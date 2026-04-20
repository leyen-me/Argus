/* global TradingView */

const chartContainerId = "tradingview_chart";
/** TradingView 内置：MAExp = EMA，周期由 length 指定 */
const DEFAULT_EMA_LENGTH = 20;
let tvWidget = null;

/**
 * 最近一次行情截图（供多模态 LLM 使用）。
 * `base64` 为不含 `data:*;base64,` 前缀的裸字符串，可直接作为 image_url / inline_data 等字段内容。
 * `dataUrl` 为完整 Data URL，与 `<img src>` 一致。
 */
function setLastChartScreenshot(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const base64 = comma === -1 ? "" : dataUrl.slice(comma + 1);
  window.argusLastChartImage = {
    mimeType: "image/png",
    dataUrl,
    base64,
  };
}

/**
 * K 线收盘后主进程推送的完整上下文：`textForLlm` + `chartImage.base64`，供后续 Chat 一并提交。
 * @type {object | null}
 */
window.argusLastBarClose = null;

async function captureTradingViewPng() {
  const widget = tvWidget;
  if (!widget || typeof widget.ready !== "function") {
    throw new Error("无图表");
  }
  if (typeof widget.imageCanvas !== "function") {
    throw new Error("不支持截图");
  }
  const canvas = await new Promise((resolve, reject) => {
    widget.ready(() => {
      widget.imageCanvas().then(resolve).catch(reject);
    });
  });
  const dataUrl = canvas.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  const base64 = comma === -1 ? "" : dataUrl.slice(comma + 1);
  return { mimeType: "image/png", dataUrl, base64 };
}

/**
 * 与 app-config 中 `MIN_FALLBACK_*` 一致：仅当非 Electron 打开页面时用于界面预览兜底。
 * 正式内容由本地库表 `prompt_strategies` 提供（内置种子见主进程 `builtin-prompts.js`）；策略在「策略中心」维护，在配置中心选用。
 */
const FALLBACK_SYSTEM_PROMPT_CRYPTO =
  "你是资深加密市场价格行为分析助手。每轮会收到已收盘 K 线、可选图表截图，以及 OKX 永续持仓与挂单快照（若已配置 API）。" +
  "需要交易时使用工具：preview_open_size、open_position、close_position、cancel_order、amend_order；不要只写评论不下单。" +
  "分析参考 Al Brooks 式价格行为，结论基于概率；信号不清时少调用工具。";

/** 与主进程 `APP_SETTINGS_SEED` + 兜底系统提示词语义一致，供非 Electron 打开页面时兜底 */
const FALLBACK_APP_CONFIG = {
  symbols: [
    { label: "BTC/USDT (OKX)", value: "OKX:BTCUSDT" },
    { label: "ETH/USDT (OKX)", value: "OKX:ETHUSDT" },
  ],
  defaultSymbol: "OKX:BTCUSDT",
  promptStrategy: "default",
  promptStrategies: ["default", "ema20"],
  interval: "5",
  openaiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  openaiModel: "qwen3.5-plus",
  openaiApiKey: "",
  systemPromptCrypto: FALLBACK_SYSTEM_PROMPT_CRYPTO,
  llmRequestTimeoutMs: 300000,
  llmReasoningEnabled: false,
  tradeNotifyEmailEnabled: false,
  smtpHost: "smtp.qq.com",
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: "",
  smtpPass: "",
  notifyEmailTo: "",
  okxSwapTradingEnabled: false,
  okxSimulated: true,
  okxApiKey: "",
  okxSecretKey: "",
  okxPassphrase: "",
  okxSwapLeverage: 10,
  okxSwapMarginFraction: 0.25,
  okxTdMode: "isolated",
};

/** 与配置 `interval` 一致，供 TradingView 与主进程路由共用 */
let chartInterval = "5";

/** 按 `品种|周期` 缓存最近一次 OKX 快照（收盘推送），切换品种时可恢复展示 */
window.argusExchangeContextCache = window.argusExchangeContextCache || Object.create(null);

/**
 * 与主进程 llm-context.conversationKey 一致
 * @param {string} tvSymbol
 * @param {string} interval
 */
function conversationKeyForUi(tvSymbol, interval) {
  const sym = String(tvSymbol || "").trim();
  const iv = String(interval ?? chartInterval ?? "5").trim();
  return sym ? `${sym}|${iv}` : "";
}

/** 当前界面选中的品种 + chartInterval，与主进程 `conversationKey(tvSymbol, interval)` 对齐 */
function currentConversationKeyForUi() {
  const sel = document.getElementById("symbol-select");
  const sym = sel?.value?.trim() || "";
  return conversationKeyForUi(sym, chartInterval);
}

/**
 * @param {string} key
 * @param {object | null | undefined} ctx
 */
function rememberExchangeContext(key, ctx) {
  if (!key || !ctx || typeof ctx !== "object") return;
  window.argusExchangeContextCache[key] = ctx;
}

/**
 * @param {object} p
 */
function formatOnePlainPendingBrief(p) {
  return `${p.ordType || "?"} ${p.side || ""} @${p.px ?? "?"}`;
}

/**
 * @param {object} o
 */
function formatOneAlgoPendingBrief(o) {
  const type = o.ordType || "?";
  const side = o.side || "";
  const parts = [];
  if (o.tpTriggerPx != null && String(o.tpTriggerPx).trim() !== "") {
    parts.push(`止盈${o.tpTriggerPx}`);
  }
  if (o.slTriggerPx != null && String(o.slTriggerPx).trim() !== "") {
    parts.push(`止损${o.slTriggerPx}`);
  }
  if (
    !parts.length &&
    o.triggerPx != null &&
    String(o.triggerPx).trim() !== ""
  ) {
    parts.push(`触发${o.triggerPx}`);
  }
  const tpsl = parts.join("/");
  return tpsl ? `${type} ${side} ${tpsl}` : `${type} ${side}`;
}

/**
 * @param {unknown} plain
 * @param {unknown} algo
 */
function formatPendingOrdersSummaryLine(plain, algo) {
  const pend = Array.isArray(plain) ? plain : [];
  const alg = Array.isArray(algo) ? algo : [];
  const pendBit =
    pend.length === 0
      ? "挂单 0"
      : `挂单 ${pend.length}：${pend
          .slice(0, 4)
          .map(formatOnePlainPendingBrief)
          .join("；")}${pend.length > 4 ? "…" : ""}`;
  const algoBit =
    alg.length === 0
      ? "算法 0"
      : `算法 ${alg.length}：${alg
          .slice(0, 4)
          .map(formatOneAlgoPendingBrief)
          .join("；")}${alg.length > 4 ? "…" : ""}`;
  return `${pendBit} ｜ ${algoBit}`;
}

/**
 * @param {object | null | undefined} ctx 主进程 getOkxExchangeContextForBar
 */
function formatExchangeContextLine(ctx) {
  if (!ctx || typeof ctx !== "object") return "—";
  if (!ctx.enabled) {
    if (ctx.reason === "okx_swap_disabled") {
      return "未启用 OKX 永续；在配置中开启并填写 API 后可显示持仓与挂单。";
    }
    if (ctx.reason === "not_crypto_chart") return "当前品种非 OKX 加密图表。";
    return "无 OKX 快照。";
  }
  if (!ctx.ok) return `快照失败：${ctx.message || "未知错误"}`;
  const posLine = formatOkxPositionLine({
    ok: true,
    skipped: false,
    simulated: ctx.simulated,
    instId: ctx.instId,
    hasPosition: ctx.position?.hasPosition,
    posNum: ctx.position?.posNum,
    absContracts: ctx.position?.absContracts,
    posSide: ctx.position?.posSide,
    fields: ctx.position?.fields,
  });
  const ordersLine = formatPendingOrdersSummaryLine(ctx.pending_orders, ctx.pending_algo_orders);
  return `${posLine} ｜ ${ordersLine}`;
}

function updateOkxBarFromExchangeContext(ctx) {
  const bar = document.getElementById("okx-position-bar");
  const textEl = document.getElementById("okx-position-text");
  const sel = document.getElementById("symbol-select");
  if (!bar || !textEl) return;
  const sym = sel?.value?.trim() || "";
  if (!sym.startsWith("OKX:")) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  textEl.textContent = formatExchangeContextLine(ctx);
  textEl.title = JSON.stringify(ctx, null, 2);
}

function refreshExchangeContextBarFromCache() {
  const key = currentConversationKeyForUi();
  const cached = key ? window.argusExchangeContextCache[key] : null;
  if (cached) {
    updateOkxBarFromExchangeContext(cached);
  } else {
    void refreshOkxPositionBar();
  }
}

/** 当前最近一次收盘推送 id，用于忽略过期的流式片段 */
let latestBarCloseId = null;

/** 从库分页拉取时每页条数 */
const LLM_HISTORY_PAGE_SIZE = 20;

/** 实时收盘插入后，DOM 中最多保留的轮数（最旧靠近列表底部会被删掉） */
const LLM_HISTORY_MAX_DOM_ROUNDS = 80;

/** @type {{ capturedAt: string, barCloseId: string } | null} */
let llmHistoryCursor = null;
let llmHistoryExhausted = false;
let llmHistoryLoading = false;
/** @type {IntersectionObserver | null} */
let llmHistoryScrollObserver = null;

/**
 * @returns {HTMLElement | null}
 */
function getLlmScrollViewport() {
  const history = document.getElementById("llm-chat-history");
  if (!history) return null;
  const root = history.closest('[data-slot="scroll-area"]');
  const vp = root?.querySelector('[data-slot="scroll-area-viewport"]');
  return vp instanceof HTMLElement ? vp : null;
}

function scrollLlmHistoryToTop() {
  const vp = getLlmScrollViewport();
  if (vp) vp.scrollTop = 0;
}

function updateLlmHistorySentinelText(text) {
  const s = document.getElementById("llm-history-load-more");
  if (s) s.textContent = text;
}

function observeLlmHistorySentinel() {
  const sent = document.getElementById("llm-history-load-more");
  const root = getLlmScrollViewport();
  if (!sent || !root) return;
  if (llmHistoryScrollObserver) {
    llmHistoryScrollObserver.disconnect();
  }
  llmHistoryScrollObserver = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      void loadNextLlmHistoryPage();
    },
    { root, rootMargin: "64px", threshold: 0 },
  );
  llmHistoryScrollObserver.observe(sent);
}

/**
 * 确保列表底部有分页哨兵（最新一条始终在列表最上方）。
 * @param {HTMLElement} history
 */
function ensureLlmHistorySentinel(history) {
  let s = document.getElementById("llm-history-load-more");
  if (s && s.parentElement === history) {
    observeLlmHistorySentinel();
    return s;
  }
  s = document.createElement("div");
  s.id = "llm-history-load-more";
  s.className = "llm-history-sentinel";
  s.textContent = "加载中…";
  history.appendChild(s);
  observeLlmHistorySentinel();
  return s;
}

function trimLlmHistoryDom(maxRounds) {
  const history = document.getElementById("llm-chat-history");
  const sent = document.getElementById("llm-history-load-more");
  if (!history || !sent) return;
  /** @type {HTMLElement[]} */
  const rounds = [...history.querySelectorAll(".llm-round")];
  if (rounds.length <= maxRounds) return;
  let removeCount = rounds.length - maxRounds;
  while (removeCount-- > 0) {
    const oldest = sent.previousElementSibling;
    if (oldest instanceof HTMLElement && oldest.classList.contains("llm-round")) {
      oldest.remove();
    } else {
      break;
    }
  }
}

/**
 * @param {object} row listAgentBarTurnsPage 返回的条目
 */
function agentBarTurnRowToPayload(row) {
  return {
    kind: "bar_close",
    barCloseId: row.barCloseId,
    tvSymbol: row.tvSymbol,
    capturedAt: row.capturedAt,
    textForLlm: row.textForLlm,
    fullUserPromptForDisplay: row.llmUserFullText,
    chartImage: null,
    chartDeferred: row.hasChart === true,
    chartCaptureError: row.chartCaptureError || null,
    fromHistory: true,
    llm: {
      enabled: true,
      reasoningEnabled: false,
      streaming: false,
      analysisText: row.agentOk ? row.assistantText || "" : null,
      toolTrace: Array.isArray(row.toolTrace) ? row.toolTrace : [],
      error: row.agentOk ? null : row.agentError || "Agent 失败",
      reasoningText: null,
    },
  };
}

async function loadNextLlmHistoryPage() {
  const history = document.getElementById("llm-chat-history");
  if (!history || !window.argus?.listAgentBarTurnsPage) return;
  if (llmHistoryLoading || llmHistoryExhausted) return;

  const sel = document.getElementById("symbol-select");
  const tvSymbol = sel?.value?.trim() || "";
  const interval = chartInterval || "5";
  if (!tvSymbol) {
    updateLlmHistorySentinelText("请先选择交易品种");
    return;
  }

  llmHistoryLoading = true;
  updateLlmHistorySentinelText("加载中…");
  try {
    const res = await window.argus.listAgentBarTurnsPage({
      tvSymbol,
      interval,
      limit: LLM_HISTORY_PAGE_SIZE,
      cursor: llmHistoryCursor,
    });

    const sentinel = document.getElementById("llm-history-load-more");
    if (!sentinel) {
      ensureLlmHistorySentinel(history);
    }

    for (const row of res.rows) {
      const payload = agentBarTurnRowToPayload(row);
      const roundEl = buildLlmRoundElement(payload);
      history.insertBefore(roundEl, document.getElementById("llm-history-load-more"));
    }

    llmHistoryCursor = res.nextCursor;
    if (!res.hasMore || res.rows.length === 0) {
      llmHistoryExhausted = true;
      if (res.rows.length === 0 && !llmHistoryCursor) {
        updateLlmHistorySentinelText("暂无历史记录");
      } else {
        updateLlmHistorySentinelText("已加载全部");
      }
    } else {
      updateLlmHistorySentinelText("继续下滑加载更早记录");
    }
  } catch (e) {
    llmHistoryExhausted = true;
    const msg = e instanceof Error ? e.message : String(e);
    updateLlmHistorySentinelText(`加载失败：${msg}（点击重试）`);
    const sent = document.getElementById("llm-history-load-more");
    if (sent) {
      sent.onclick = () => {
        sent.onclick = null;
        llmHistoryExhausted = false;
        void loadNextLlmHistoryPage();
      };
    }
  } finally {
    llmHistoryLoading = false;
    observeLlmHistorySentinel();
  }
}

/**
 * 切换品种/周期或应用启动时：清空并重新拉第一页（最新在上）。
 */
async function reloadLlmHistoryFromStore() {
  const history = document.getElementById("llm-chat-history");
  if (!history || !window.argus?.listAgentBarTurnsPage) return;

  if (llmHistoryScrollObserver) {
    llmHistoryScrollObserver.disconnect();
    llmHistoryScrollObserver = null;
  }

  history.replaceChildren();
  llmHistoryCursor = null;
  llmHistoryExhausted = false;
  llmHistoryLoading = false;

  const sentinel = document.createElement("div");
  sentinel.id = "llm-history-load-more";
  sentinel.className = "llm-history-sentinel";
  sentinel.textContent = "加载中…";
  history.appendChild(sentinel);
  history.hidden = false;

  await loadNextLlmHistoryPage();
}

/**
 * @param {string} barCloseId
 * @returns {HTMLElement | null}
 */
function findAssistantBubbleForBar(barCloseId) {
  if (!barCloseId) return null;
  const id = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(barCloseId) : barCloseId;
  return document.querySelector(
    `#llm-chat-history .llm-round[data-bar-close-id="${id}"] .llm-bubble--assistant`,
  );
}

/**
 * @param {string} barCloseId
 * @returns {HTMLElement | null}
 */
function findReasoningBubbleForBar(barCloseId) {
  if (!barCloseId) return null;
  const id = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(barCloseId) : barCloseId;
  return document.querySelector(
    `#llm-chat-history .llm-round[data-bar-close-id="${id}"] .llm-bubble--reasoning`,
  );
}

/**
 * @param {string} barCloseId
 * @returns {HTMLElement | null}
 */
function findToolBubbleForBar(barCloseId) {
  if (!barCloseId) return null;
  const id = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(barCloseId) : barCloseId;
  return document.querySelector(`#llm-chat-history .llm-round[data-bar-close-id="${id}"] .llm-bubble--tools`);
}

/**
 * @param {string} barCloseId
 * @returns {HTMLDetailsElement | null}
 */
function findLlmRoundDetailsForBar(barCloseId) {
  if (!barCloseId) return null;
  const id = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(barCloseId) : barCloseId;
  const el = document.querySelector(
    `#llm-chat-history .llm-round[data-bar-close-id="${id}"] .llm-round-details`,
  );
  return el instanceof HTMLDetailsElement ? el : null;
}

/**
 * 老数据里曾将 assistant 正文与工具轨迹拼在同一个字段里，这里兼容拆开显示。
 * @param {string | null | undefined} text
 * @returns {{ assistantText: string, legacyToolText: string }}
 */
function splitLegacyAssistantAndToolText(text) {
  const raw = typeof text === "string" ? text : "";
  const marker = "\n---\n工具轨迹：\n";
  const idx = raw.indexOf(marker);
  if (idx < 0) return { assistantText: raw, legacyToolText: "" };
  return {
    assistantText: raw.slice(0, idx),
    legacyToolText: raw.slice(idx + marker.length),
  };
}

/**
 * @param {unknown[] | null | undefined} trace
 * @returns {string}
 */
function formatToolTraceDisplay(trace) {
  if (!Array.isArray(trace) || trace.length === 0) return "";
  return trace
    .map((t) => {
      const result = t?.result && typeof t.result === "object" ? t.result : {};
      const ok = result.ok === true ? "ok" : "fail";
      const name = t?.name ? String(t.name) : "unknown_tool";
      return `• ${name} (${ok}) ${JSON.stringify(result)}`;
    })
    .join("\n");
}

/**
 * @param {object | null | undefined} llm
 * @returns {{ assistantText: string, toolText: string }}
 */
function resolveAssistantAndToolDisplay(llm) {
  const legacy = splitLegacyAssistantAndToolText(llm?.analysisText);
  const toolText = formatToolTraceDisplay(llm?.toolTrace) || legacy.legacyToolText;
  return {
    assistantText: legacy.assistantText,
    toolText,
  };
}

/**
 * 构建单轮 DOM（实时收盘与库分页复用）。
 * @returns {HTMLElement} `.llm-round` 根节点
 */
function buildLlmRoundElement(payload) {
  const llm = payload?.llm;
  const barCloseId = payload?.barCloseId;
  if (!barCloseId || !llm?.enabled) {
    throw new Error("buildLlmRoundElement: 无效 payload");
  }
  const display = resolveAssistantAndToolDisplay(llm);

  const round = document.createElement("div");
  round.className = "llm-round";
  round.dataset.barCloseId = barCloseId;

  const details = document.createElement("details");
  details.className = "llm-round-details";
  details.open = llm.streaming === true;

  const summary = document.createElement("summary");
  summary.className = "llm-round-summary";
  const cap = payload.capturedAt
    ? new Date(payload.capturedAt).toLocaleString("zh-CN", { hour12: false })
    : "";
  const summaryInner = document.createElement("span");
  summaryInner.className = "llm-round-summary-inner";
  const summaryHead = document.createElement("span");
  summaryHead.className = "llm-round-summary-head";
  const summaryTitle = document.createElement("span");
  summaryTitle.className = "llm-round-summary-title";
  summaryTitle.textContent = payload.tvSymbol || "未命名标的";
  const summaryTag = document.createElement("span");
  summaryTag.className = "llm-round-summary-tag";
  summaryTag.textContent = "单轮 Agent";
  summaryHead.append(summaryTitle, summaryTag);
  const summaryMeta = document.createElement("span");
  summaryMeta.className = "llm-round-summary-meta";
  if (cap) {
    const time = document.createElement("span");
    time.className = "llm-round-summary-chip";
    time.textContent = cap;
    summaryMeta.appendChild(time);
  }
  if (payload.fromHistory) {
    const hist = document.createElement("span");
    hist.className = "llm-round-summary-chip llm-round-summary-chip--history";
    hist.textContent = "历史记录";
    summaryMeta.appendChild(hist);
  }
  const hint = document.createElement("span");
  hint.className = "llm-round-summary-hint";
  hint.textContent = details.open ? "点击收起" : "点击展开";
  summaryInner.append(summaryHead, summaryMeta, hint);
  summary.appendChild(summaryInner);

  const body = document.createElement("div");
  body.className = "llm-round-body";

  const chartDataUrl = payload?.chartImage?.dataUrl;
  let thumbRow = null;
  if (chartDataUrl) {
    thumbRow = document.createElement("div");
    thumbRow.className = "llm-round-thumb-row";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "llm-round-thumb";
    btn.title = "点击放大查看本轮截图";
    btn.setAttribute("aria-label", "放大预览本轮图表截图");
    const img = document.createElement("img");
    img.src = chartDataUrl;
    img.alt = "";
    img.decoding = "async";
    btn.appendChild(img);
    btn.addEventListener("click", () => openLlmChartPreview(chartDataUrl));
    thumbRow.appendChild(btn);
  } else if (payload.chartCaptureError) {
    thumbRow = document.createElement("div");
    thumbRow.className = "llm-round-thumb-row";
    const hint = document.createElement("div");
    hint.className = "llm-round-chart-hint";
    hint.textContent = `截图：${payload.chartCaptureError}`;
    thumbRow.appendChild(hint);
  } else if (payload.chartDeferred && payload.barCloseId && window.argus?.getAgentBarTurnChart) {
    thumbRow = document.createElement("div");
    thumbRow.className = "llm-round-thumb-row";
    const loadBtn = document.createElement("button");
    loadBtn.type = "button";
    loadBtn.className = "llm-round-thumb llm-round-thumb--load";
    loadBtn.textContent = "加载截图";
    loadBtn.title = "从本地库加载该轮图表";
    loadBtn.addEventListener("click", async () => {
      loadBtn.disabled = true;
      try {
        const imgData = await window.argus.getAgentBarTurnChart(payload.barCloseId);
        if (!imgData?.dataUrl) {
          loadBtn.textContent = "无截图";
          return;
        }
        thumbRow.replaceChildren();
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "llm-round-thumb";
        btn.title = "点击放大查看本轮截图";
        const im = document.createElement("img");
        im.src = imgData.dataUrl;
        im.alt = "";
        im.decoding = "async";
        btn.appendChild(im);
        btn.addEventListener("click", () => openLlmChartPreview(imgData.dataUrl));
        thumbRow.appendChild(btn);
      } catch {
        loadBtn.textContent = "加载失败";
      } finally {
        loadBtn.disabled = false;
      }
    });
    thumbRow.appendChild(loadBtn);
  }

  const rowUser = document.createElement("div");
  rowUser.className = "llm-chat-row llm-chat-row--user";
  const bubbleUser = document.createElement("div");
  bubbleUser.className = "llm-bubble llm-bubble--user";
  const userFull =
    typeof payload?.fullUserPromptForDisplay === "string" && payload.fullUserPromptForDisplay.trim()
      ? payload.fullUserPromptForDisplay
      : payload?.textForLlm || "";
  bubbleUser.textContent = userFull;

  /** @type {HTMLElement | null} */
  let rowReasoning = null;
  if (llm.reasoningEnabled) {
    rowReasoning = document.createElement("div");
    rowReasoning.className = "llm-chat-row llm-chat-row--reasoning";
    const wrap = document.createElement("div");
    wrap.className = "llm-reasoning-wrap";
    const label = document.createElement("div");
    label.className = "llm-reasoning-label";
    label.textContent = "深度思考";
    const bubbleReasoning = document.createElement("div");
    bubbleReasoning.className = "llm-bubble llm-bubble--reasoning";
    if (llm.streaming) {
      bubbleReasoning.textContent =
        llm.reasoningText != null && String(llm.reasoningText).length > 0
          ? normalizeAssistantDisplayText(llm.reasoningText)
          : "…";
    } else if (llm.reasoningText != null && String(llm.reasoningText).trim()) {
      bubbleReasoning.textContent = normalizeAssistantDisplayText(llm.reasoningText);
    } else {
      bubbleReasoning.textContent = "";
    }
    wrap.append(label, bubbleReasoning);
    rowReasoning.appendChild(wrap);
  }

  const rowTool = document.createElement("div");
  rowTool.className = "llm-chat-row llm-chat-row--tools";
  rowTool.hidden = !display.toolText;
  const toolWrap = document.createElement("div");
  toolWrap.className = "llm-tools-wrap";
  const toolLabel = document.createElement("div");
  toolLabel.className = "llm-tools-label";
  toolLabel.textContent = "工具调用";
  const bubbleTool = document.createElement("div");
  bubbleTool.className = "llm-bubble llm-bubble--tools";
  bubbleTool.textContent = display.toolText;
  toolWrap.append(toolLabel, bubbleTool);
  rowTool.appendChild(toolWrap);

  const rowAsst = document.createElement("div");
  rowAsst.className = "llm-chat-row llm-chat-row--assistant";
  const bubbleAsst = document.createElement("div");
  bubbleAsst.className = "llm-bubble llm-bubble--assistant";
  bubbleAsst.classList.remove("llm-bubble--error");
  if (llm.streaming) {
    bubbleAsst.textContent = "…";
  } else if (display.assistantText) {
    bubbleAsst.textContent = normalizeAssistantDisplayText(display.assistantText);
  } else {
    bubbleAsst.textContent = llm.error || "";
    bubbleAsst.classList.add("llm-bubble--error");
  }

  rowUser.appendChild(bubbleUser);
  rowAsst.appendChild(bubbleAsst);
  if (thumbRow) body.appendChild(thumbRow);
  body.appendChild(rowUser);
  if (rowReasoning) body.appendChild(rowReasoning);
  body.appendChild(rowTool);
  body.appendChild(rowAsst);
  details.append(summary, body);
  round.appendChild(details);
  return round;
}

/**
 * 每根 K 线收盘且启用 LLM 时插入一轮：**最新在最上方**。
 * @returns {HTMLElement | null} 本轮助手气泡
 */
function appendLlmRound(payload) {
  const history = document.getElementById("llm-chat-history");
  const llm = payload?.llm;
  const barCloseId = payload?.barCloseId;
  if (!history || !barCloseId || !llm?.enabled) return null;

  const round = buildLlmRoundElement(payload);
  ensureLlmHistorySentinel(history);
  const anchor = history.firstChild;
  if (anchor) {
    history.insertBefore(round, anchor);
  } else {
    history.appendChild(round);
  }
  history.hidden = false;
  trimLlmHistoryDom(LLM_HISTORY_MAX_DOM_ROUNDS);
  scrollLlmHistoryToTop();
  return round.querySelector(".llm-bubble--assistant");
}

async function loadAppConfig() {
  if (window.argus && typeof window.argus.getConfig === "function") {
    try {
      return await window.argus.getConfig();
    } catch {
      /* ignore */
    }
  }
  return FALLBACK_APP_CONFIG;
}

function applySymbolSelect(config) {
  const sel = document.getElementById("symbol-select");
  if (!sel) return;
  sel.replaceChildren();
  for (const s of config.symbols) {
    const opt = document.createElement("option");
    opt.value = s.value;
    opt.textContent = s.label;
    sel.appendChild(opt);
  }
  const def =
    config.symbols.some((x) => x.value === config.defaultSymbol) && config.defaultSymbol
      ? config.defaultSymbol
      : config.symbols[0]?.value || "OKX:BTCUSDT";
  sel.value = def;
  window.dispatchEvent(
    new CustomEvent("argus:symbol-select-sync", {
      detail: {
        symbols: config.symbols.map((s) => ({ label: s.label, value: s.value })),
        value: def,
      },
    }),
  );
}

/** 与 `src/node/app-config.js` 中 `ALLOWED_INTERVAL` 一致 */
const CHART_INTERVAL_ALLOWED = new Set(["1", "3", "5", "15", "30", "60", "120", "240", "D", "1D"]);

/**
 * 同步左侧行情标题栏 K 线周期控件，并更新内存中的 `chartInterval`。
 * @param {string} interval
 */
function applyChartIntervalSelect(interval) {
  const raw = String(interval ?? "5").trim() || "5";
  let iv = CHART_INTERVAL_ALLOWED.has(raw) ? raw : "5";
  const sel = document.getElementById("chart-interval-select");
  if (sel) {
    const has = [...sel.options].some((o) => o.value === iv);
    if (!has) iv = "5";
    sel.value = iv;
  }
  chartInterval = iv;
  window.dispatchEvent(new CustomEvent("argus:chart-interval-sync", { detail: { value: iv } }));
}

/**
 * 配置弹窗内「K 线周期 / 默认打开」与快捷栏一致（弹窗未打开时元素可能不存在）。
 * @param {{ interval?: string, defaultSymbol?: string }} fields
 */
function syncConfigModalMarketFields(fields) {
  if (!fields || typeof fields !== "object") return;
  if (fields.interval != null) {
    const intEl = document.getElementById("config-interval");
    if (intEl) intEl.value = String(fields.interval);
  }
  if (fields.defaultSymbol != null) {
    const defEl = document.getElementById("config-default-symbol");
    if (defEl) defEl.value = String(fields.defaultSymbol);
  }
}

/**
 * 将快捷栏选的标的 / 周期写入本地设置（合并保存），并刷新主进程行情路由。
 * @param {{ defaultSymbol?: string, interval?: string }} partial
 */
async function persistChartPreferences(partial) {
  if (!partial || typeof partial !== "object") return;
  if (!window.argus || typeof window.argus.saveConfig !== "function") {
    syncConfigModalMarketFields(partial);
    return;
  }
  try {
    const saved = await window.argus.saveConfig(partial);
    chartInterval = saved.interval || chartInterval;
    applyChartIntervalSelect(chartInterval);
    applySymbolSelect(saved);
    syncConfigModalMarketFields({
      interval: saved.interval,
      defaultSymbol: saved.defaultSymbol,
    });
  } catch (err) {
    console.error(err);
    setLlmStatus("保存行情设置失败");
  }
}

function collectSymbolsFromConfigRows() {
  const rows = document.querySelectorAll("#config-rows .config-row");
  const symbols = [];
  rows.forEach((row) => {
    const label = row.querySelector(".config-in-label")?.value.trim() ?? "";
    const value = row.querySelector(".config-in-value")?.value.trim() ?? "";
    if (label && value) symbols.push({ label, value });
  });
  return symbols;
}

function fillDefaultSymbolSelect(symbols, selectedValue) {
  const sel = document.getElementById("config-default-symbol");
  if (!sel) return;
  sel.replaceChildren();
  if (!symbols || symbols.length === 0) return;
  for (const s of symbols) {
    const opt = document.createElement("option");
    opt.value = s.value;
    opt.textContent = s.label;
    sel.appendChild(opt);
  }
  const pick = symbols.some((s) => s.value === selectedValue) ? selectedValue : symbols[0].value;
  sel.value = pick;
}

function onConfigRowRemoved() {
  const syms = collectSymbolsFromConfigRows();
  const defSel = document.getElementById("config-default-symbol");
  const prev = defSel?.value;
  if (syms.length === 0) {
    fillDefaultSymbolSelect([], "");
    return;
  }
  fillDefaultSymbolSelect(syms, prev);
}

function renderConfigRows(symbols) {
  const container = document.getElementById("config-rows");
  if (!container) return;
  container.replaceChildren();
  const list = symbols.length > 0 ? symbols : [{ label: "", value: "" }];
  list.forEach((sym) => {
    const row = document.createElement("div");
    row.className = "config-row";

    const inLabel = document.createElement("input");
    inLabel.type = "text";
    inLabel.className = "config-in config-in-label";
    inLabel.value = sym.label;
    inLabel.placeholder = "展示名称";

    const inValue = document.createElement("input");
    inValue.type = "text";
    inValue.className = "config-in config-in-value";
    inValue.value = sym.value;
    inValue.placeholder = "OKX:BTCUSDT";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-row-remove";
    btn.textContent = "删除";

    row.append(inLabel, inValue, btn);
    container.appendChild(row);
  });
}

function initDevToolsButton() {
  const btn = document.getElementById("btn-open-devtools");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (window.argus && typeof window.argus.openDevTools === "function") {
      void window.argus.openDevTools();
    }
  });
}

function initFishMode() {
  const btn = document.getElementById("btn-fish-mode");
  const overlay = document.getElementById("fish-mode-overlay");
  const dismiss = document.getElementById("fish-mode-dismiss");
  if (!btn || !overlay) return;

  const setLabel = (on) => {
    const label = document.getElementById("btn-fish-mode-label");
    const next = on ? "恢复显示" : "隐私遮挡";
    if (label) label.textContent = next;
    else btn.textContent = next;
  };

  const setActive = (on) => {
    overlay.hidden = !on;
    overlay.setAttribute("aria-hidden", on ? "false" : "true");
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.classList.toggle("titlebar-config--fish-active", on);
    setLabel(on);
  };

  btn.addEventListener("click", () => {
    setActive(overlay.hidden);
  });

  if (dismiss) {
    dismiss.addEventListener("click", () => setActive(false));
  }

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || overlay.hidden) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setActive(false);
    },
    true,
  );
}

/** 与 `lib/argus-config-modal-events.ts` 中常量一致（shadcn Dialog 由 React 控制显隐） */
const ARGUS_CONFIG_MODAL_OPEN = "argus:config-modal-open";
const ARGUS_CONFIG_MODAL_CLOSE = "argus:config-modal-close";
const ARGUS_STRATEGY_MODAL_OPEN = "argus:strategy-modal-open";
const ARGUS_PROMPT_STRATEGIES_CHANGED = "argus:prompt-strategies-changed";

/**
 * 配置弹窗按钮用 document 委托绑定：Dialog 关闭会卸载 Portal，若只对节点 addEventListener 一次，
 * 第二次打开会是新 DOM，旧监听全丢。
 */
let __argusConfigModalDocClickBound = false;

function initConfigCenter() {
  const btnOpen = document.getElementById("btn-open-config");
  if (!btnOpen) return;

  const fillConfigModalFields = (cfg) => {
    renderConfigRows(cfg.symbols);
    fillDefaultSymbolSelect(cfg.symbols, cfg.defaultSymbol);
    const intSel = document.getElementById("config-interval");
    if (intSel) intSel.value = cfg.interval || "5";
    const openaiUrlEl = document.getElementById("config-openai-base-url");
    const openaiModelEl = document.getElementById("config-openai-model");
    if (openaiUrlEl) openaiUrlEl.value = cfg.openaiBaseUrl || FALLBACK_APP_CONFIG.openaiBaseUrl;
    if (openaiModelEl) openaiModelEl.value = cfg.openaiModel || FALLBACK_APP_CONFIG.openaiModel;
    const openaiKeyEl = document.getElementById("config-openai-api-key");
    if (openaiKeyEl) openaiKeyEl.value = cfg.openaiApiKey ?? FALLBACK_APP_CONFIG.openaiApiKey;
    const reasoningEl = document.getElementById("config-llm-reasoning");
    if (reasoningEl) reasoningEl.checked = cfg.llmReasoningEnabled === true;
    const tradeNotifyEl = document.getElementById("config-trade-notify-email");
    if (tradeNotifyEl) tradeNotifyEl.checked = cfg.tradeNotifyEmailEnabled === true;
    const smtpUserEl = document.getElementById("config-smtp-user");
    const smtpPassEl = document.getElementById("config-smtp-pass");
    const notifyToEl = document.getElementById("config-notify-email-to");
    if (smtpUserEl) smtpUserEl.value = cfg.smtpUser ?? FALLBACK_APP_CONFIG.smtpUser;
    if (smtpPassEl) smtpPassEl.value = cfg.smtpPass ?? FALLBACK_APP_CONFIG.smtpPass;
    if (notifyToEl) notifyToEl.value = cfg.notifyEmailTo ?? FALLBACK_APP_CONFIG.notifyEmailTo;
    const okxEn = document.getElementById("config-okx-swap-enabled");
    const okxSim = document.getElementById("config-okx-simulated");
    if (okxEn) okxEn.checked = cfg.okxSwapTradingEnabled === true;
    if (okxSim) okxSim.checked = cfg.okxSimulated !== false;
    const okxAk = document.getElementById("config-okx-api-key");
    const okxSk = document.getElementById("config-okx-secret-key");
    const okxPh = document.getElementById("config-okx-passphrase");
    if (okxAk) okxAk.value = cfg.okxApiKey ?? FALLBACK_APP_CONFIG.okxApiKey;
    if (okxSk) okxSk.value = cfg.okxSecretKey ?? FALLBACK_APP_CONFIG.okxSecretKey;
    if (okxPh) okxPh.value = cfg.okxPassphrase ?? FALLBACK_APP_CONFIG.okxPassphrase;
    const okxLev = document.getElementById("config-okx-leverage");
    const okxMf = document.getElementById("config-okx-margin-fraction");
    if (okxLev) okxLev.value = String(cfg.okxSwapLeverage ?? FALLBACK_APP_CONFIG.okxSwapLeverage);
    if (okxMf) okxMf.value = String(cfg.okxSwapMarginFraction ?? FALLBACK_APP_CONFIG.okxSwapMarginFraction);
    const okxTd = document.getElementById("config-okx-td-mode");
    if (okxTd) okxTd.value = cfg.okxTdMode === "isolated" ? "isolated" : "cross";
    const stratSel = document.getElementById("config-prompt-strategy");
    if (stratSel) {
      const list =
        Array.isArray(cfg.promptStrategies) && cfg.promptStrategies.length > 0
          ? cfg.promptStrategies
          : [cfg.promptStrategy || "default"];
      stratSel.replaceChildren();
      for (const name of list) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        stratSel.appendChild(opt);
      }
      const cur =
        cfg.promptStrategy && list.includes(cfg.promptStrategy)
          ? cfg.promptStrategy
          : list.includes("default")
            ? "default"
            : list[0];
      stratSel.value = cur;
    }
  };

  window.addEventListener(ARGUS_PROMPT_STRATEGIES_CHANGED, () => {
    void (async () => {
      try {
        const cfg = await loadAppConfig();
        fillConfigModalFields(cfg);
      } catch (e) {
        console.error(e);
      }
    })();
  });

  const closeModal = () => {
    window.dispatchEvent(new CustomEvent(ARGUS_CONFIG_MODAL_CLOSE));
  };

  const openModal = async () => {
    const cfg = await loadAppConfig();
    window.dispatchEvent(new CustomEvent(ARGUS_CONFIG_MODAL_OPEN));
    const fillAfterOpen = async () => {
      const pathEl = document.getElementById("config-file-path");
      if (pathEl && window.argus && typeof window.argus.getConfigPath === "function") {
        try {
          const p = await window.argus.getConfigPath();
          pathEl.textContent = `本地数据库（应用设置存于此）：${p}`;
        } catch {
          pathEl.textContent = "";
        }
      } else if (pathEl) {
        pathEl.textContent = "";
      }
      fillConfigModalFields(cfg);
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void fillAfterOpen();
      });
    });
  };

  btnOpen.addEventListener("click", () => {
    void openModal();
  });

  const handleConfigModalDocumentClick = (ev) => {
    const raw = ev.target;
    if (!(raw instanceof Element)) return;
    const dlg = raw.closest('[data-slot="dialog-content"]');
    if (!dlg) return;

    const el = raw.closest(
      "#btn-config-save, #btn-config-reset, #btn-config-close, #btn-config-cancel, #btn-config-add, .btn-row-remove",
    );
    if (!el) return;

    if (el.classList.contains("btn-row-remove")) {
      ev.preventDefault();
      const row = el.closest(".config-row");
      row?.remove();
      onConfigRowRemoved();
      return;
    }

    const id = el.id;
    if (id === "btn-config-add") {
      ev.preventDefault();
      const container = document.getElementById("config-rows");
      if (!container) return;
      const row = document.createElement("div");
      row.className = "config-row";
      const inLabel = document.createElement("input");
      inLabel.type = "text";
      inLabel.className = "config-in config-in-label";
      inLabel.placeholder = "展示名称";
      const inValue = document.createElement("input");
      inValue.type = "text";
      inValue.className = "config-in config-in-value";
      inValue.placeholder = "OKX:BTCUSDT";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-row-remove";
      btn.textContent = "删除";
      row.append(inLabel, inValue, btn);
      container.appendChild(row);
      return;
    }

    if (id === "btn-config-close" || id === "btn-config-cancel") {
      closeModal();
      return;
    }

    if (id === "btn-config-reset") {
      ev.preventDefault();
      void (async () => {
        const ok = window.confirm(
          "将本地数据库中的应用设置恢复为代码中的默认种子。API Key、SMTP 等将清空为默认，是否继续？",
        );
        if (!ok) return;

        if (!window.argus || typeof window.argus.resetConfig !== "function") {
          fillConfigModalFields(FALLBACK_APP_CONFIG);
          applySymbolSelect(FALLBACK_APP_CONFIG);
          chartInterval = FALLBACK_APP_CONFIG.interval || "5";
          applyChartIntervalSelect(chartInterval);
          createTradingViewWidget(FALLBACK_APP_CONFIG.defaultSymbol, chartInterval);
          setLlmStatus("已恢复界面为内置默认（非 Electron 环境不会写入磁盘）");
          refreshExchangeContextBarFromCache();
          return;
        }
        try {
          const saved = await window.argus.resetConfig();
          fillConfigModalFields(saved);
          applySymbolSelect(saved);
          chartInterval = saved.interval || "5";
          applyChartIntervalSelect(chartInterval);
          createTradingViewWidget(saved.defaultSymbol, chartInterval);
          setLlmStatus("配置已恢复默认");
          refreshExchangeContextBarFromCache();
        } catch (err) {
          console.error(err);
          setLlmStatus("恢复默认配置失败");
        }
      })();
      return;
    }

    if (id === "btn-config-save") {
      ev.preventDefault();
      void (async () => {
        let symbols = collectSymbolsFromConfigRows();
        const defEl = document.getElementById("config-default-symbol");
        let defaultSymbol = defEl?.value?.trim() ?? "";
        if (symbols.length === 0) {
          setLlmStatus("请至少填写一行品种");
          return;
        }
        if (!symbols.some((s) => s.value === defaultSymbol)) {
          defaultSymbol = symbols[0].value;
        }
        const intEl = document.getElementById("config-interval");
        const interval = intEl?.value?.trim() || "5";
        const openaiUrlEl = document.getElementById("config-openai-base-url");
        const openaiModelEl = document.getElementById("config-openai-model");
        const openaiKeyEl = document.getElementById("config-openai-api-key");
        const openaiBaseUrl = openaiUrlEl?.value?.trim() ?? "";
        const openaiModel = openaiModelEl?.value?.trim() ?? "";
        const openaiApiKey = openaiKeyEl?.value?.trim() ?? "";
        const reasoningEl = document.getElementById("config-llm-reasoning");
        const llmReasoningEnabled = reasoningEl?.checked === true;
        const tradeNotifyEl = document.getElementById("config-trade-notify-email");
        const tradeNotifyEmailEnabled = tradeNotifyEl?.checked === true;
        const smtpUserEl = document.getElementById("config-smtp-user");
        const smtpPassEl = document.getElementById("config-smtp-pass");
        const notifyToEl = document.getElementById("config-notify-email-to");
        const smtpUser = smtpUserEl?.value?.trim() ?? "";
        const smtpPass = smtpPassEl?.value?.trim() ?? "";
        const notifyEmailTo = notifyToEl?.value?.trim() ?? "";
        const okxEn = document.getElementById("config-okx-swap-enabled");
        const okxSim = document.getElementById("config-okx-simulated");
        const okxAk = document.getElementById("config-okx-api-key");
        const okxSk = document.getElementById("config-okx-secret-key");
        const okxPh = document.getElementById("config-okx-passphrase");
        const okxLev = document.getElementById("config-okx-leverage");
        const okxMf = document.getElementById("config-okx-margin-fraction");
        const okxTd = document.getElementById("config-okx-td-mode");
        const okxSwapTradingEnabled = okxEn?.checked === true;
        const okxSimulated = okxSim?.checked !== false;
        const okxApiKey = okxAk?.value?.trim() ?? "";
        const okxSecretKey = okxSk?.value?.trim() ?? "";
        const okxPassphrase = okxPh?.value?.trim() ?? "";
        const okxSwapLeverage = Math.min(125, Math.max(1, Math.floor(Number(okxLev?.value) || 10)));
        const okxSwapMarginFraction = Math.min(
          1,
          Math.max(0.01, Number(okxMf?.value) || 0.25),
        );
        const okxTdMode = okxTd?.value === "isolated" ? "isolated" : "cross";
        const stratEl = document.getElementById("config-prompt-strategy");
        const promptStrategy = stratEl?.value?.trim() || "default";

        if (!window.argus || typeof window.argus.saveConfig !== "function") {
          applySymbolSelect({ symbols, defaultSymbol });
          chartInterval = interval;
          applyChartIntervalSelect(chartInterval);
          createTradingViewWidget(defaultSymbol, chartInterval);
          closeModal();
          refreshExchangeContextBarFromCache();
          void refreshOkxPositionBar();
          return;
        }
        try {
          const saved = await window.argus.saveConfig({
            symbols,
            defaultSymbol,
            interval,
            promptStrategy,
            openaiBaseUrl,
            openaiModel,
            openaiApiKey,
            llmReasoningEnabled,
            tradeNotifyEmailEnabled,
            smtpUser,
            smtpPass,
            notifyEmailTo,
            okxSwapTradingEnabled,
            okxSimulated,
            okxApiKey,
            okxSecretKey,
            okxPassphrase,
            okxSwapLeverage,
            okxSwapMarginFraction,
            okxTdMode,
          });
          applySymbolSelect(saved);
          chartInterval = saved.interval || interval;
          applyChartIntervalSelect(chartInterval);
          createTradingViewWidget(saved.defaultSymbol, chartInterval);
          closeModal();
          refreshExchangeContextBarFromCache();
          void refreshOkxPositionBar();
        } catch (err) {
          console.error(err);
          setLlmStatus("保存配置失败");
        }
      })();
    }
  };

  if (!__argusConfigModalDocClickBound) {
    __argusConfigModalDocClickBound = true;
    document.addEventListener("click", handleConfigModalDocumentClick);
  }
}

function initStrategyCenter() {
  const btn = document.getElementById("btn-open-strategy-center");
  if (!btn) return;
  btn.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent(ARGUS_STRATEGY_MODAL_OPEN));
  });
}

function destroyWidget() {
  if (tvWidget && typeof tvWidget.remove === "function") {
    try {
      tvWidget.remove();
    } catch {
      /* ignore */
    }
  }
  tvWidget = null;
  const el = document.getElementById(chartContainerId);
  if (el) el.innerHTML = "";
}

function createTradingViewWidget(symbol, interval) {
  destroyWidget();

  const iv = interval ?? chartInterval ?? "5";

  if (typeof TradingView === "undefined" || !TradingView.widget) {
    const el = document.getElementById(chartContainerId);
    if (el) {
      el.innerHTML =
        '<p style="padding:16px;color:#f85149;font-size:13px;">无法加载 TradingView 脚本，请检查网络或 CSP。</p>';
    }
    return;
  }

  /**
   * tv.js（免费 Advanced Chart）里与「隐藏界面」相关的选项主要来自官方 embed：
   *
   * - hide_top_toolbar：顶部栏（品种搜索、周期、布局等）
   * - hide_side_toolbar：左侧竖条绘图/工具栏（画线、斐波那契等）
   * - hide_legend：主图左上角 OHLC 等图例
   * - hide_volume：底部成交量副图
   * - hideideasbutton：图表上的 Ideas 相关按钮（注意：不是 hideideas；源码里 URL 还会带 hideideas 参数）
   *
   * 另：save_image 为 false 时可关闭保存图片；show_popup_button 控制弹出大图等。
   * enabled_features / disabled_features 会传给 iframe，主要给 Charting Library 用，免费 embed 是否生效因版本而异。
   */
  tvWidget = new TradingView.widget({
    autosize: true,
    symbol: symbol || "OKX:BTCUSDT",
    interval: iv,
    timezone: "Asia/Shanghai",
    theme: "dark",
    style: "1",
    locale: "zh_CN",
    toolbar_bg: "#161b22",
    enable_publishing: false,
    hide_top_toolbar: true,
    hide_side_toolbar: true,
    hide_legend: true,
    hide_volume: true,
    hideideasbutton: true,
    /** 为 false 时 iframe 可能拒绝 imageCanvas 截图，需保留导出能力 */
    save_image: true,
    container_id: chartContainerId,
    allow_symbol_change: true,
    studies: [
      {
        id: "MAExp@tv-basicstudies",
        inputs: { length: DEFAULT_EMA_LENGTH },
      },
    ],
  });
}

function initSymbolSelect() {
  const sel = document.getElementById("symbol-select");
  if (!sel) return;
  sel.addEventListener("change", () => {
    const sym = sel.value;
    createTradingViewWidget(sym, chartInterval);
    void (async () => {
      await persistChartPreferences({ defaultSymbol: sym });
      await reloadLlmHistoryFromStore();
      refreshExchangeContextBarFromCache();
      void refreshOkxPositionBar();
    })();
  });
}

function initChartIntervalSelect() {
  const sel = document.getElementById("chart-interval-select");
  if (!sel) return;
  sel.addEventListener("change", () => {
    const iv = sel.value;
    chartInterval = iv;
    const symEl = document.getElementById("symbol-select");
    const sym = symEl?.value?.trim() || "OKX:BTCUSDT";
    createTradingViewWidget(sym, iv);
    void (async () => {
      await persistChartPreferences({ interval: iv });
      await reloadLlmHistoryFromStore();
      refreshExchangeContextBarFromCache();
      void refreshOkxPositionBar();
    })();
  });
}

/**
 * 助手气泡展示用：模型与流式接口常在行首或段间输出 \\n\\n；配合 CSS pre-wrap 会原样显示，看起来像「多出一行」或双倍段距。
 */
function normalizeAssistantDisplayText(s) {
  if (s == null || s === "") return "";
  return String(s)
    .replace(/\r\n/g, "\n")
    .replace(/^\n+/, "")
    .replace(/\n{3,}/g, "\n\n");
}

function formatBarClosePreview(payload) {
  if (!payload || payload.kind !== "bar_close") return JSON.stringify(payload, null, 2);
  const safe = JSON.parse(JSON.stringify(payload));
  if (safe.chartImage?.base64) {
    const n = safe.chartImage.base64.length;
    safe.chartImage = {
      ...safe.chartImage,
      base64: `[省略 ${n} 字符，完整数据在 window.argusLastBarClose.chartImage.base64]`,
    };
  }
  if (typeof safe.fullUserPromptForDisplay === "string" && safe.fullUserPromptForDisplay.length > 400) {
    const n = safe.fullUserPromptForDisplay.length;
    safe.fullUserPromptForDisplay = `${safe.fullUserPromptForDisplay.slice(0, 400)}… [共 ${n} 字符]`;
  }
  return JSON.stringify(safe, null, 2);
}

/**
 * 右侧「状态」徽章用短标签（约 2～4 字），完整句子由元素 title 展示。
 * @param {string} full
 * @returns {string}
 */
function shortLlmStatusLabel(full) {
  const t = String(full ?? "").trim();
  if (!t) return "就绪";

  /** @type {readonly (readonly [(s: string) => boolean, string])[]} */
  const rules = [
    [(s) => s.includes("LLM 输出中"), "分析中"],
    [(s) => s.includes("收盘（截图异常）"), "截图异常"],
    [(s) => s.includes("收盘 · LLM 已分析"), "已分析"],
    [(s) => s.includes("收盘 · LLM 失败"), "分析失败"],
    [(s) => s.includes("K 线收盘已采集"), "已采集"],
    [(s) => s.startsWith("OKX WS · K 收盘"), "WS收盘"],
    [(s) => s.startsWith("收盘处理失败"), "处理失败"],
    [(s) => s.includes("WS 断开") && s.includes("重连"), "WS重连"],
    [(s) => s.startsWith("OKX WS 已连接"), "WS已连"],
    [(s) => s.includes("无效 OKX"), "代码无效"],
    [(s) => s.startsWith("OKX："), "OKX异常"],
    [(s) => s.includes("请使用 OKX:") || (s.includes("OKX:") && s.includes("前缀")), "前缀无效"],
    [(s) => s.includes("需为 OKX:") && s.includes("订阅行情"), "无行情"],
    [(s) => s.includes("已恢复界面为内置默认"), "已恢复"],
    [(s) => s === "配置已恢复默认", "已恢复"],
    [(s) => s.includes("恢复默认配置失败"), "恢复失败"],
    [(s) => s === "请至少填写一行品种", "缺品种"],
    [(s) => s === "保存配置失败", "保存失败"],
    [(s) => s === "就绪", "就绪"],
  ];

  for (const [pred, label] of rules) {
    if (pred(t)) return label;
  }
  if (t.length <= 6) return t;
  return `${t.slice(0, 5)}…`;
}

/**
 * @param {string} text 完整状态句（主进程或本页逻辑原文）
 */
function setLlmStatus(text) {
  const el = document.getElementById("llm-status");
  if (!el) return;
  const full = String(text ?? "").trim() || "就绪";
  el.textContent = shortLlmStatusLabel(full);
  el.title = full;
}

function openLlmChartPreview(dataUrl) {
  const modal = document.getElementById("llm-chart-preview-modal");
  const img = document.getElementById("llm-chart-preview-img");
  if (!modal || !img || !dataUrl) return;
  img.src = dataUrl;
  img.alt = "本轮 K 线收盘时的图表截图";
  modal.hidden = false;
}

function closeLlmChartPreview() {
  const modal = document.getElementById("llm-chart-preview-modal");
  const img = document.getElementById("llm-chart-preview-img");
  if (modal) modal.hidden = true;
  if (img) {
    img.removeAttribute("src");
    img.alt = "";
  }
}

function initLlmChartPreview() {
  const modal = document.getElementById("llm-chart-preview-modal");
  const btn = document.getElementById("btn-llm-chart-preview-close");
  if (!modal) return;
  const close = () => closeLlmChartPreview();
  btn?.addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (modal.hidden) return;
    close();
  });
}

function initChartCaptureBridge() {
  if (!window.argus?.onChartCaptureRequest || !window.argus?.submitChartCaptureResult) {
    return;
  }
  window.argus.onChartCaptureRequest(async ({ requestId }) => {
    try {
      const shot = await captureTradingViewPng();
      window.argus.submitChartCaptureResult({
        requestId,
        ok: true,
        mimeType: shot.mimeType,
        base64: shot.base64,
        dataUrl: shot.dataUrl,
      });
    } catch (e) {
      window.argus.submitChartCaptureResult({
        requestId,
        ok: false,
        error: e.message || String(e),
      });
    }
  });
}

function bindMarketBarClose() {
  if (typeof window.argus === "undefined" || !window.argus.onMarketBarClose) {
    return;
  }
  window.argus.onMarketBarClose((payload) => {
    latestBarCloseId = payload?.barCloseId ?? null;
    window.argusLastBarClose = payload;
    if (payload?.chartImage?.dataUrl) {
      setLastChartScreenshot(payload.chartImage.dataUrl);
    }

    if (payload?.conversationKey && payload?.exchangeContext) {
      rememberExchangeContext(payload.conversationKey, payload.exchangeContext);
      if (payload.conversationKey === currentConversationKeyForUi()) {
        updateOkxBarFromExchangeContext(payload.exchangeContext);
      }
    }

    const llm = payload?.llm;
    const showRound =
      llm?.enabled &&
      (llm.streaming === true || Boolean(llm.analysisText) || Boolean(llm.error));
    if (showRound) {
      appendLlmRound(payload);
    }

    try {
      console.log("[Argus] market-bar-close", JSON.parse(formatBarClosePreview(payload)));
    } catch {
      console.log("[Argus] market-bar-close", payload);
    }
    if (payload?.chartCaptureError) {
      setLlmStatus("收盘（截图异常）");
    } else if (llm?.enabled && llm.streaming) {
      setLlmStatus("LLM 输出中…");
    } else if (llm?.enabled && llm.analysisText) {
      setLlmStatus("收盘 · LLM 已分析");
    } else if (llm?.enabled && llm.error) {
      setLlmStatus("收盘 · LLM 失败");
    } else {
      setLlmStatus("K 线收盘已采集");
    }
  });
}

function bindLlmStream() {
  if (typeof window.argus === "undefined") return;
  const { onLlmStreamDelta, onLlmStreamEnd, onLlmStreamError } = window.argus;
  if (typeof onLlmStreamDelta === "function") {
    onLlmStreamDelta(({ barCloseId, full, reasoningFull, toolFull }) => {
      const bubbleAsst = findAssistantBubbleForBar(barCloseId);
      const bubbleReas = findReasoningBubbleForBar(barCloseId);
      const bubbleTool = findToolBubbleForBar(barCloseId);
      if (!bubbleAsst && !bubbleReas && !bubbleTool) return;
      if (bubbleReas && reasoningFull != null) {
        bubbleReas.textContent = normalizeAssistantDisplayText(String(reasoningFull));
      }
      if (bubbleTool) {
        bubbleTool.textContent = toolFull ? normalizeAssistantDisplayText(String(toolFull)) : "";
        if (bubbleTool.parentElement?.parentElement) {
          bubbleTool.parentElement.parentElement.hidden = !toolFull;
        }
      }
      if (bubbleAsst) {
        bubbleAsst.textContent = normalizeAssistantDisplayText(full);
        bubbleAsst.classList.remove("llm-bubble--error");
      }
      if (barCloseId === latestBarCloseId) {
        setLlmStatus("LLM 输出中…");
      }
      const history = document.getElementById("llm-chat-history");
      if (history) history.scrollTop = history.scrollHeight;
    });
  }
  if (typeof onLlmStreamEnd === "function") {
    onLlmStreamEnd(
      ({ barCloseId, analysisText, reasoningText, toolTrace, conversationKey, exchangeContext }) => {
      const bubbleAsst = findAssistantBubbleForBar(barCloseId);
      const display = resolveAssistantAndToolDisplay({ analysisText, toolTrace });
      if (bubbleAsst && analysisText != null) {
        bubbleAsst.textContent = normalizeAssistantDisplayText(display.assistantText);
        bubbleAsst.classList.remove("llm-bubble--error");
      }
      const bubbleReas = findReasoningBubbleForBar(barCloseId);
      if (bubbleReas && reasoningText != null) {
        bubbleReas.textContent = normalizeAssistantDisplayText(String(reasoningText));
      }
      const bubbleTool = findToolBubbleForBar(barCloseId);
      if (bubbleTool) {
        bubbleTool.textContent = display.toolText ? normalizeAssistantDisplayText(display.toolText) : "";
        if (bubbleTool.parentElement?.parentElement) {
          bubbleTool.parentElement.parentElement.hidden = !display.toolText;
        }
      }
      if (conversationKey && exchangeContext) {
        rememberExchangeContext(conversationKey, exchangeContext);
        if (conversationKey === currentConversationKeyForUi()) {
          updateOkxBarFromExchangeContext(exchangeContext);
        }
      }
      const roundDetails = findLlmRoundDetailsForBar(barCloseId);
      if (roundDetails) {
        roundDetails.open = false;
      }
      if (barCloseId !== latestBarCloseId) return;
      if (window.argusLastBarClose?.llm) {
        window.argusLastBarClose.llm.analysisText = analysisText;
        window.argusLastBarClose.llm.toolTrace = Array.isArray(toolTrace) ? toolTrace : [];
        window.argusLastBarClose.llm.reasoningText = reasoningText ?? "";
        window.argusLastBarClose.llm.streaming = false;
        window.argusLastBarClose.llm.error = null;
      }
      if (window.argusLastBarClose && exchangeContext) {
        window.argusLastBarClose.exchangeContext = exchangeContext;
      }
      setLlmStatus("收盘 · LLM 已分析");
    },
    );
  }
  if (typeof onLlmStreamError === "function") {
    onLlmStreamError(({ barCloseId, message, toolTrace }) => {
      const bubbleAsst = findAssistantBubbleForBar(barCloseId);
      if (bubbleAsst) {
        bubbleAsst.textContent = message || "错误";
        bubbleAsst.classList.add("llm-bubble--error");
      }
      const bubbleTool = findToolBubbleForBar(barCloseId);
      const toolText = formatToolTraceDisplay(toolTrace);
      if (bubbleTool) {
        bubbleTool.textContent = toolText ? normalizeAssistantDisplayText(toolText) : "";
        if (bubbleTool.parentElement?.parentElement) {
          bubbleTool.parentElement.parentElement.hidden = !toolText;
        }
      }
      const roundDetailsErr = findLlmRoundDetailsForBar(barCloseId);
      if (roundDetailsErr) {
        roundDetailsErr.open = false;
      }
      if (barCloseId !== latestBarCloseId) return;
      if (window.argusLastBarClose?.llm) {
        window.argusLastBarClose.llm.error = message;
        window.argusLastBarClose.llm.streaming = false;
        window.argusLastBarClose.llm.analysisText = null;
        window.argusLastBarClose.llm.toolTrace = Array.isArray(toolTrace) ? toolTrace : [];
      }
      setLlmStatus("收盘 · LLM 失败");
    });
  }
}

function bindMarketStatus() {
  if (typeof window.argus === "undefined" || !window.argus.onMarketStatus) {
    return;
  }
  window.argus.onMarketStatus((payload) => {
    if (payload?.text) setLlmStatus(payload.text);
  });
}

/**
 * @param {object | null} r `getOkxSwapPosition` 返回
 */
function formatOkxPositionLine(r) {
  if (!r) return "—";
  if (r.skipped && r.reason === "not_okx_chart") return "";
  if (r.skipped && r.reason === "okx_swap_disabled") {
    return "未启用 OKX 永续下单；在配置中开启后可显示交易所持仓。";
  }
  if (r.ok === false) return r.message || "查询失败";
  const sim = r.simulated !== false ? "模拟" : "实盘";
  const id = r.instId || "";
  const f = r.fields;
  if (!r.hasPosition || !f) {
    return `${sim} · ${id} · 当前无持仓`;
  }
  const dir = r.posNum > 0 ? "多" : r.posNum < 0 ? "空" : "—";
  const contracts = f.pos != null ? String(f.pos) : String(r.absContracts ?? "");
  const upl = f.upl != null && f.upl !== "" ? ` · 未实现盈亏 ${f.upl}` : "";
  const avg = f.avgPx != null && f.avgPx !== "" ? ` · 开仓均价 ${f.avgPx}` : "";
  const mark = f.markPx != null && f.markPx !== "" ? ` · 标记 ${f.markPx}` : "";
  const lev = f.lever != null && f.lever !== "" ? ` · ${f.lever}x` : "";
  return `${sim} · ${f.instId || id} · ${dir} ${contracts} 张${lev}${avg}${mark}${upl}`;
}

async function refreshOkxPositionBar() {
  const bar = document.getElementById("okx-position-bar");
  const textEl = document.getElementById("okx-position-text");
  const sel = document.getElementById("symbol-select");
  if (!bar || !textEl || !sel) return;
  const sym = sel.value?.trim() || "";
  if (!sym.startsWith("OKX:")) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  if (!window.argus || typeof window.argus.getOkxSwapPosition !== "function") {
    textEl.textContent = "—";
    textEl.removeAttribute("title");
    return;
  }
  textEl.textContent = "查询中…";
  try {
    const r = await window.argus.getOkxSwapPosition(sym);
    const posLine = formatOkxPositionLine(r);
    const ordersLine = formatPendingOrdersSummaryLine(r?.pending_orders, r?.pending_algo_orders);
    const line =
      posLine && posLine.length > 0
        ? `${posLine} ｜ ${ordersLine}`
        : ordersLine && ordersLine.length > 0
          ? ordersLine
          : "—";
    textEl.textContent = line && line.length > 0 ? line : "—";
    textEl.title = JSON.stringify(
      {
        position: r?.fields ?? null,
        pending_orders: r?.pending_orders,
        pending_algo_orders: r?.pending_algo_orders,
      },
      null,
      2,
    );
  } catch (e) {
    textEl.textContent = e instanceof Error ? e.message : String(e);
    textEl.removeAttribute("title");
  }
}

/**
 * @param {{ position?: object, tvSymbol?: string, simulated?: boolean }} payload
 */
function applyOkxPositionFromPayload(payload) {
  const bar = document.getElementById("okx-position-bar");
  const textEl = document.getElementById("okx-position-text");
  const sel = document.getElementById("symbol-select");
  if (!bar || !textEl || !payload?.position) return;
  const cur = sel?.value?.trim() || "";
  if (payload.tvSymbol && cur && cur !== payload.tvSymbol) {
    void refreshOkxPositionBar();
    return;
  }
  if (!cur.startsWith("OKX:")) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const r = {
    ok: true,
    simulated: payload.simulated !== false,
    ...payload.position,
  };
  const line = formatOkxPositionLine(r);
  textEl.textContent = line && line.length > 0 ? line : "—";
  if (payload.position.fields) {
    textEl.title = JSON.stringify(payload.position.fields, null, 2);
  } else {
    textEl.title = textEl.textContent;
  }
}

function initOkxPositionBar() {
  const btn = document.getElementById("okx-position-refresh");
  if (btn) {
    btn.addEventListener("click", () => {
      void refreshOkxPositionBar();
    });
  }
}

function bindOkxSwapStatus() {
  if (typeof window.argus === "undefined" || typeof window.argus.onOkxSwapStatus !== "function") {
    return;
  }
  window.argus.onOkxSwapStatus((payload) => {
    if (payload?.message) {
      setLlmStatus(payload.ok ? `OKX：${payload.message}` : `OKX 错误：${payload.message}`);
    }
    if (payload?.position) {
      applyOkxPositionFromPayload(payload);
    } else {
      void refreshOkxPositionBar();
    }
  });
}

let __argusRendererInitPromise = null;

/** 由 React 根组件挂载后调用；可安全重复调用（只初始化一次）。 */
export function initArgusApp() {
  if (__argusRendererInitPromise) return __argusRendererInitPromise;
  __argusRendererInitPromise = (async () => {
    const cfg = await loadAppConfig();
    applySymbolSelect(cfg);
    applyChartIntervalSelect(cfg.interval || "5");
    const sym = cfg.defaultSymbol || cfg.symbols[0]?.value || "OKX:BTCUSDT";
    createTradingViewWidget(sym, chartInterval);
    if (window.argus && typeof window.argus.setMarketContext === "function") {
      window.argus.setMarketContext(sym);
    }
    initSymbolSelect();
    initChartIntervalSelect();
    initChartCaptureBridge();
    initConfigCenter();
    initStrategyCenter();
    initDevToolsButton();
    initFishMode();
    initLlmChartPreview();
    await reloadLlmHistoryFromStore();
    bindMarketBarClose();
    bindLlmStream();
    bindMarketStatus();
    bindOkxSwapStatus();
    initOkxPositionBar();
    refreshExchangeContextBarFromCache();
    void refreshOkxPositionBar();
  })();
  return __argusRendererInitPromise;
}
