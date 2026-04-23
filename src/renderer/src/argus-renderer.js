/* global TradingView */

/** TradingView 内置：MAExp = EMA，周期由 length 指定 */
const DEFAULT_EMA_LENGTH = 20;
const AGENT_DECISION_INTERVAL = "5";
const MULTI_TIMEFRAME_SPECS = [
  {
    interval: "1D",
    label: "1D",
    caption: "日线",
    containerId: "tradingview_chart_1d",
  },
  {
    interval: "60",
    label: "1H",
    caption: "1 小时",
    containerId: "tradingview_chart_1h",
  },
  {
    interval: "15",
    label: "15m",
    caption: "15 分钟",
    containerId: "tradingview_chart_15m",
  },
  {
    interval: AGENT_DECISION_INTERVAL,
    label: "5m",
    caption: "5 分钟",
    containerId: "tradingview_chart_5m",
  },
];
let tvWidgets = new Map();

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

async function captureTradingViewPng(interval = AGENT_DECISION_INTERVAL) {
  const widget = tvWidgets.get(String(interval));
  if (!widget || typeof widget.ready !== "function") {
    throw new Error(`无图表：${interval}`);
  }
  if (typeof widget.imageCanvas !== "function") {
    throw new Error(`图表不支持截图：${interval}`);
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

function loadImageElement(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图像解码失败"));
    img.src = dataUrl;
  });
}

async function captureMultiTimeframeCharts() {
  const charts = await Promise.all(
    MULTI_TIMEFRAME_SPECS.map(async (spec) => {
      const shot = await captureTradingViewPng(spec.interval);
      return {
        interval: spec.interval,
        label: spec.label,
        caption: spec.caption,
        mimeType: shot.mimeType,
        base64: shot.base64,
        dataUrl: shot.dataUrl,
      };
    }),
  );
  const images = await Promise.all(charts.map((chart) => loadImageElement(chart.dataUrl)));
  const cellWidth = Math.max(...images.map((img) => img.width));
  const cellHeight = Math.max(...images.map((img) => img.height));
  const gap = 12;
  const pad = 16;
  const titleHeight = 42;
  const canvas = document.createElement("canvas");
  canvas.width = pad * 2 + cellWidth * 2 + gap;
  canvas.height = pad * 2 + cellHeight * 2 + gap;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建截图画布");
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  charts.forEach((chart, index) => {
    const row = Math.floor(index / 2);
    const col = index % 2;
    const x = pad + col * (cellWidth + gap);
    const y = pad + row * (cellHeight + gap);
    ctx.fillStyle = "#111827";
    ctx.fillRect(x, y, cellWidth, cellHeight);
    ctx.drawImage(images[index], x, y, cellWidth, cellHeight);
    ctx.fillStyle = "rgba(13, 17, 23, 0.78)";
    ctx.fillRect(x + 10, y + 10, 102, titleHeight);
    ctx.strokeStyle = "rgba(148, 163, 184, 0.22)";
    ctx.strokeRect(x + 10, y + 10, 102, titleHeight);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 18px system-ui";
    ctx.fillText(chart.label, x + 22, y + 28);
    ctx.fillStyle = "#94a3b8";
    ctx.font = "12px system-ui";
    ctx.fillText(chart.caption, x + 22, y + 45);
  });
  const dataUrl = canvas.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  const base64 = comma === -1 ? "" : dataUrl.slice(comma + 1);
  return {
    mimeType: "image/png",
    dataUrl,
    base64,
    charts,
  };
}

/**
 * 与 app-config 中 `MIN_FALLBACK_*` 一致：仅当非 Electron 打开页面时用于界面预览兜底。
 * 正式内容由本地库表 `prompt_strategies` 提供（内置种子见主进程 `builtin-prompts.js`）；策略在「策略中心」维护，并在顶部快捷栏切换。
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
  barCloseAgentAutoEnabled: true,
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
  dashboardBaselineEquityUsdt: null,
  dashboardAgentToolStatsSince: null,
};

/** Agent 决策周期固定为 5 分钟，左侧同时展示 1D / 1H / 15m / 5m */
let chartInterval = AGENT_DECISION_INTERVAL;

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
    periodLabel: row.periodLabel,
    capturedAt: row.capturedAt,
    textForLlm: row.textForLlm,
    fullUserPromptForDisplay: row.llmUserFullText,
    chartImage: null,
    llm: {
      enabled: true,
      reasoningEnabled: false,
      streaming: false,
      analysisText: row.agentOk ? row.assistantText || "" : null,
      cardSummary: row.agentOk && row.cardSummary ? String(row.cardSummary) : null,
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
 * @returns {HTMLElement | null}
 */
function findLlmRoundRoot(barCloseId) {
  if (!barCloseId) return null;
  const id = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(barCloseId) : barCloseId;
  const el = document.querySelector(`#llm-chat-history .llm-round[data-bar-close-id="${id}"]`);
  return el instanceof HTMLElement ? el : null;
}

/**
 * @param {object} payload
 * @param {object} llm
 * @returns {"running" | "done" | "error"}
 */
function getLlmRoundStatusKind(payload, llm) {
  if (llm.streaming === true) return "running";
  if (llm.error) return "error";
  if (llm.skippedReason && String(llm.skippedReason).trim()) return "skipped";
  return "done";
}

/**
 * @param {"running" | "done" | "error"} kind
 * @returns {HTMLElement}
 */
function buildLlmRoundStatusEl(kind) {
  const wrap = document.createElement("span");
  wrap.className = "llm-round-status-wrap";
  const st = document.createElement("span");
  st.className = `llm-round-status llm-round-status--${kind}`;
  if (kind === "running") {
    const sp = document.createElement("span");
    sp.className = "llm-round-spinner";
    sp.setAttribute("aria-hidden", "true");
    st.appendChild(sp);
    st.appendChild(document.createTextNode("决策中"));
  } else if (kind === "error") {
    st.textContent = "失败";
  } else if (kind === "skipped") {
    st.textContent = "已跳过";
  } else {
    st.textContent = "已完成";
  }
  wrap.appendChild(st);
  return wrap;
}

/**
 * Agent 结束后刷新列表项：解锁明细、更新角标。
 * @param {string} barCloseId
 * @param {"ok" | "err"} outcome
 */
function updateLlmRoundAfterAgentFinished(barCloseId, outcome) {
  const root = findLlmRoundRoot(barCloseId);
  if (!root) return;
  root.dataset.detailLocked = "0";
  const card = root.querySelector(".llm-round-card");
  if (card instanceof HTMLElement) card.classList.remove("llm-round-card--locked");
  const btn = root.querySelector(".llm-round-detail-btn");
  if (btn instanceof HTMLButtonElement) {
    btn.disabled = false;
    btn.setAttribute("aria-label", "在弹窗中查看多轮对话明细");
  }
  const statusWrap = root.querySelector(".llm-round-status-wrap");
  if (statusWrap) {
    const kind = outcome === "err" ? "error" : "done";
    statusWrap.replaceWith(buildLlmRoundStatusEl(kind));
  }
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function formatSessionMsgContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

/**
 * 非 assistant 行仍合并在一列（含罕见的 tool_calls），与落库结构一致。
 * @param {object} m
 * @returns {string}
 */
function formatSessionMessageRowBody(m) {
  const parts = [];
  if (m.content != null && m.content !== "") {
    parts.push(formatSessionMsgContent(m.content));
  }
  if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
    parts.push(`tool_calls:\n${JSON.stringify(m.toolCalls, null, 2)}`);
  }
  if (m.toolCallId) parts.push(`tool_call_id: ${m.toolCallId}`);
  if (m.name) parts.push(`name: ${m.name}`);
  return parts.join("\n\n").trim() || "（空）";
}

/**
 * assistant 主文本（不含 tool_calls），单独一块展示。
 * @param {object} m
 * @returns {string}
 */
function formatAssistantSessionMainText(m) {
  if (m.content != null && m.content !== "") {
    return formatSessionMsgContent(m.content);
  }
  return "";
}

/**
 * @param {string} role
 * @returns {string}
 */
function sanitizeSessionMsgRoleClass(role) {
  const s = String(role || "unknown").replace(/[^a-z0-9_-]/gi, "");
  return s || "unknown";
}

/**
 * @param {string | null | undefined} capturedAt
 * @returns {string}
 */
function formatSessionCapturedAt(capturedAt) {
  if (!capturedAt) return "";
  const dt = new Date(capturedAt);
  if (Number.isNaN(dt.getTime())) return "";
  const pad2 = (n) => String(n).padStart(2, "0");
  return [
    `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`,
    `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`,
  ].join(" ");
}

/**
 * @param {string} dataUrl
 * @returns {HTMLDivElement}
 */
function createSessionChartRow(dataUrl) {
  const row = document.createElement("div");
  row.className = "llm-session-msg llm-session-msg--chart";
  row.setAttribute("role", "listitem");

  const roleEl = document.createElement("div");
  roleEl.className = "llm-session-msg-role";
  roleEl.textContent = "chart";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "llm-round-card-thumb llm-session-detail-chart-thumb";
  btn.title = "放大查看本轮截图";
  btn.setAttribute("aria-label", "放大预览图表截图");

  const img = document.createElement("img");
  img.src = dataUrl;
  img.alt = "本轮 K 线收盘时的图表截图";
  img.decoding = "async";

  btn.appendChild(img);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    openLlmChartPreview(dataUrl);
  });

  row.append(roleEl, btn);
  return row;
}

/**
 * @param {string} role
 * @param {string} text
 * @returns {boolean}
 */
function shouldCollapseSessionMessage(role, text) {
  const normalizedRole = String(role || "").toLowerCase();
  if (normalizedRole !== "system" && normalizedRole !== "user") return false;
  const body = String(text || "");
  if (!body) return false;
  const lineCount = body.split("\n").length;
  return body.length > 600 || lineCount > 10;
}

/**
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copySessionText(text) {
  const value = String(text || "");
  if (!value) return false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to legacy copy path.
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "true");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(ta);
    return copied === true;
  } catch {
    return false;
  }
}

/**
 * @param {string} text
 * @returns {HTMLButtonElement}
 */
function createSessionCopyButton(text) {
  const setLabel = (label) => {
    labelEl.textContent = label;
  };

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "llm-session-copy-btn";
  btn.setAttribute("aria-label", "复制当前内容块");

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.8");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.classList.add("llm-session-copy-btn-icon");
  icon.setAttribute("aria-hidden", "true");

  const rectBack = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rectBack.setAttribute("x", "9");
  rectBack.setAttribute("y", "9");
  rectBack.setAttribute("width", "11");
  rectBack.setAttribute("height", "11");
  rectBack.setAttribute("rx", "2");
  rectBack.setAttribute("ry", "2");

  const pathFront = document.createElementNS("http://www.w3.org/2000/svg", "path");
  pathFront.setAttribute("d", "M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3");

  icon.append(rectBack, pathFront);

  const labelEl = document.createElement("span");
  labelEl.className = "llm-session-copy-btn-label";
  setLabel("复制");

  btn.append(icon, labelEl);

  let resetTimer = 0;
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    btn.disabled = true;
    const copied = await copySessionText(text);
    setLabel(copied ? "已复制" : "复制失败");
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      setLabel("复制");
      btn.disabled = false;
    }, copied ? 1200 : 1600);
  });

  return btn;
}

/**
 * @param {HTMLElement} contentEl
 * @param {string} text
 * @returns {HTMLDivElement}
 */
function createSessionCopyBlock(contentEl, text) {
  const wrap = document.createElement("div");
  wrap.className = "llm-session-copy-block";
  wrap.append(createSessionCopyButton(text), contentEl);
  return wrap;
}

/**
 * @param {string} text
 * @returns {HTMLDivElement}
 */
function createCollapsibleSessionContent(text) {
  const wrap = document.createElement("div");
  wrap.className = "llm-session-msg-collapse llm-session-copy-block";

  const preview = document.createElement("pre");
  preview.className = "llm-session-msg-pre llm-session-msg-pre--collapsed";
  preview.textContent = text;

  const full = document.createElement("pre");
  full.className = "llm-session-msg-pre llm-session-msg-pre--full";
  full.textContent = text;
  full.hidden = true;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "llm-session-msg-collapse-toggle";
  toggle.textContent = "展开全文";
  toggle.setAttribute("aria-expanded", "false");

  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
    toggle.textContent = expanded ? "展开全文" : "收起";
    preview.hidden = !expanded;
    full.hidden = expanded;
  });

  wrap.append(createSessionCopyButton(text), preview, full, toggle);
  return wrap;
}

/**
 * @param {HTMLElement} container
 * @param {object[]} msgs
 * @param {string} [chartDataUrl]
 */
function renderSessionMessagesInto(container, msgs, chartDataUrl = "") {
  container.replaceChildren();
  const lastUserIdx = msgs.reduce((acc, m, idx) => {
    return String(m?.role || "").toLowerCase() === "user" ? idx : acc;
  }, -1);
  let chartInserted = false;

  for (const [idx, m] of msgs.entries()) {
    const row = document.createElement("div");
    row.className = `llm-session-msg llm-session-msg--${sanitizeSessionMsgRoleClass(m.role)}`;
    row.setAttribute("role", "listitem");
    const roleEl = document.createElement("div");
    roleEl.className = "llm-session-msg-role";
    const seq = m.seq != null ? ` · #${m.seq}` : "";
    roleEl.textContent = `${m.role || "?"}${seq}`;
    const isAssistant = String(m.role || "").toLowerCase() === "assistant";
    const toolCalls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    const hasToolCalls = toolCalls.length > 0;

    if (isAssistant && hasToolCalls) {
      const mainText = formatAssistantSessionMainText(m);
      if (mainText) {
        const preMain = document.createElement("pre");
        preMain.className = "llm-session-msg-pre";
        preMain.textContent = mainText;
        row.appendChild(roleEl);
        row.appendChild(createSessionCopyBlock(preMain, mainText));
      } else {
        row.appendChild(roleEl);
      }
      const toolsWrap = document.createElement("div");
      toolsWrap.className = "llm-session-msg-toolcalls";
      const toolsLabel = document.createElement("div");
      toolsLabel.className = "llm-session-msg-toolcalls-label";
      toolsLabel.textContent = "工具调用";
      const toolText = JSON.stringify(toolCalls, null, 2);
      const preTools = document.createElement("pre");
      preTools.className = "llm-session-msg-pre llm-session-msg-pre--toolcalls";
      preTools.textContent = toolText;
      toolsWrap.append(toolsLabel, createSessionCopyBlock(preTools, toolText));
      row.appendChild(toolsWrap);
    } else {
      const bodyText = formatSessionMessageRowBody(m);
      row.appendChild(roleEl);
      if (shouldCollapseSessionMessage(m.role, bodyText)) {
        row.appendChild(createCollapsibleSessionContent(bodyText));
      } else {
        const pre = document.createElement("pre");
        pre.className = "llm-session-msg-pre";
        pre.textContent = bodyText;
        row.appendChild(createSessionCopyBlock(pre, bodyText));
      }
    }
    container.appendChild(row);

    if (!chartInserted && chartDataUrl && lastUserIdx === idx) {
      container.appendChild(createSessionChartRow(chartDataUrl));
      chartInserted = true;
    }
  }

  if (!chartInserted && chartDataUrl) {
    container.appendChild(createSessionChartRow(chartDataUrl));
  }
}

async function openLlmSessionDetailModal(barCloseId) {
  const modal = document.getElementById("llm-session-detail-modal");
  const bodyEl = document.getElementById("llm-session-detail-body");
  const loading = document.getElementById("llm-session-detail-loading");
  const errEl = document.getElementById("llm-session-detail-error");
  const subtitle = document.getElementById("llm-session-detail-subtitle");
  const title = document.getElementById("llm-session-detail-title");
  if (!modal || !bodyEl) return;

  const root = findLlmRoundRoot(barCloseId);
  const sym = root?.dataset.tvSymbol?.trim() || "";
  const cap = root?.dataset.capturedAt || "";
  const timeLine = formatSessionCapturedAt(cap);

  if (subtitle) {
    subtitle.textContent = "";
    subtitle.hidden = true;
  }
  if (title) {
    title.textContent = [sym, timeLine].filter(Boolean).join(" · ") || "Agent 多轮对话";
  }

  bodyEl.replaceChildren();
  if (errEl) {
    errEl.textContent = "";
    errEl.hidden = true;
  }
  if (loading) loading.hidden = false;
  modal.hidden = false;

  if (!window.argus || typeof window.argus.getAgentSessionMessages !== "function") {
    if (loading) loading.hidden = true;
    if (errEl) {
      errEl.textContent = "当前环境无法读取会话明细";
      errEl.hidden = false;
    }
    return;
  }

  try {
    const msgs = await window.argus.getAgentSessionMessages(barCloseId);
    let chartData = null;
    if (typeof window.argus.getAgentBarTurnChart === "function") {
      try {
        chartData = await window.argus.getAgentBarTurnChart(barCloseId);
      } catch {
        chartData = null;
      }
    }
    if (loading) loading.hidden = true;
    if (!Array.isArray(msgs) || msgs.length === 0) {
      if (errEl) {
        errEl.textContent = "暂无消息记录（可能尚未落库）";
        errEl.hidden = false;
      }
      return;
    }
    renderSessionMessagesInto(bodyEl, msgs, chartData?.dataUrl || "");
  } catch (e) {
    if (loading) loading.hidden = true;
    const msg = e instanceof Error ? e.message : String(e);
    if (errEl) {
      errEl.textContent = `加载失败：${msg}`;
      errEl.hidden = false;
    }
  }
}

function closeLlmSessionDetailModal() {
  const modal = document.getElementById("llm-session-detail-modal");
  if (modal) modal.hidden = true;
}

function initLlmSessionDetailModal() {
  const modal = document.getElementById("llm-session-detail-modal");
  const btn = document.getElementById("btn-llm-session-detail-close");
  if (!modal) return;
  const close = () => closeLlmSessionDetailModal();
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
  const skip = llm?.skippedReason != null ? String(llm.skippedReason).trim() : "";
  if (skip) {
    return { assistantText: skip, toolText: "" };
  }
  const legacy = splitLegacyAssistantAndToolText(llm?.analysisText);
  const toolText = formatToolTraceDisplay(llm?.toolTrace) || legacy.legacyToolText;
  return {
    assistantText: legacy.assistantText,
    toolText,
  };
}

function fmtTradePx(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function pickFiniteNum(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object | null | undefined} llm
 */
function setIdleNeutralTradeSummaryText(textEl, llm) {
  const L = llm && typeof llm === "object" ? llm : {};
  const short =
    L.cardSummary != null && String(L.cardSummary).trim()
      ? normalizeAssistantDisplayText(String(L.cardSummary).trim())
      : "";
  if (short) {
    textEl.textContent = short;
    textEl.classList.remove("llm-round-neutral-trade-text--analysis");
    textEl.classList.add("llm-round-neutral-trade-text--summary");
    return;
  }
  const d = resolveAssistantAndToolDisplay(L);
  const body = d.assistantText && String(d.assistantText).trim();
  if (body) {
    textEl.textContent = normalizeAssistantDisplayText(body);
    textEl.classList.add("llm-round-neutral-trade-text--analysis");
    textEl.classList.remove("llm-round-neutral-trade-text--summary");
  } else {
    textEl.textContent = "暂无可摘录的分析正文。";
    textEl.classList.remove("llm-round-neutral-trade-text--analysis", "llm-round-neutral-trade-text--summary");
  }
}

/**
 * @param {"running" | "idle" | "skipped" | "error"} kind
 * @param {object | null | undefined} [llm] 与 `kind === "idle"` 时展示 `llm.cardSummary` 或正文摘要用
 * @returns {HTMLElement}
 */
function buildNeutralTradeStripElement(kind, llm) {
  const wrap = document.createElement("div");
  wrap.className = `llm-round-neutral-trade llm-round-neutral-trade--${kind}`;
  wrap.setAttribute("role", "status");

  const badge = document.createElement("span");
  badge.className = "llm-round-event-badge llm-round-event-badge--neutral";
  if (kind === "running") badge.textContent = "IN PROGRESS";
  else if (kind === "skipped") badge.textContent = "SKIP";
  else if (kind === "error") badge.textContent = "ERROR";
  else badge.textContent = "NO TRADE";
  const badgeCell = document.createElement("div");
  badgeCell.className = "llm-round-event-badge-cell";
  badgeCell.appendChild(badge);

  const body = document.createElement("div");
  body.className = "llm-round-neutral-trade-body";
  const title = document.createElement("div");
  title.className = "llm-round-neutral-trade-title";
  if (kind === "running") title.textContent = "等待本轮下单决策";
  else if (kind === "skipped") title.textContent = "本轮未触发 Agent 会话";
  else if (kind === "error") title.textContent = "本轮未完成交易执行";
  else title.textContent = "本轮无下单动作";
  const text = document.createElement("div");
  text.className = "llm-round-neutral-trade-text";
  if (kind === "running") text.textContent = "模型分析进行中，若触发交易将追加到此处。";
  else if (kind === "skipped") text.textContent = "当前只有状态判断或外部条件未满足，没有生成可查看的交易会话。";
  else if (kind === "error") {
    const raw = llm && typeof llm.error === "string" ? llm.error.trim() : "";
    const detail = raw && raw !== "error" ? raw : "";
    text.textContent = detail
      ? detail
      : "Agent 分析未成功完成，因此没有可确认的开平仓事件。";
  } else setIdleNeutralTradeSummaryText(text, llm);
  body.append(title, text);

  wrap.append(badgeCell, body);
  return wrap;
}

/**
 * @param {object} payload
 * @returns {"running" | "idle" | "skipped" | "error"}
 */
function getNeutralTradeKind(payload) {
  const llm = payload?.llm;
  if (llm?.streaming === true) return "running";
  if (llm?.skippedReason && String(llm.skippedReason).trim()) return "skipped";
  if (llm?.error) return "error";
  return "idle";
}

/**
 * @param {object} args
 * @param {object} result
 * @returns {HTMLElement | null}
 */
function buildOpenTradeStripElement(args, result) {
  const side = String(args.side || "").toLowerCase() === "short" ? "short" : "long";
  const orderType = String(args.order_type || "market").toLowerCase() === "limit" ? "limit" : "market";
  const takeProfit = pickFiniteNum(args.take_profit_trigger_price ?? args.tp_trigger_price);
  const stopLoss = pickFiniteNum(args.stop_loss_trigger_price ?? args.sl_trigger_price);
  const limitPx = pickFiniteNum(args.limit_price);
  const ex = result.exchange && typeof result.exchange === "object" ? result.exchange : {};
  const avgPx = pickFiniteNum(ex.avgPx);
  const openPrice = avgPx ?? (orderType === "limit" ? limitPx : null);

  const wrap = document.createElement("div");
  wrap.className = `llm-round-open-trade llm-round-open-trade--${side}`;
  wrap.setAttribute("role", "status");

  const badge = document.createElement("span");
  badge.className = "llm-round-event-badge llm-round-event-badge--open";
  badge.textContent = "OPEN";
  const badgeCell = document.createElement("div");
  badgeCell.className = "llm-round-event-badge-cell";
  badgeCell.appendChild(badge);

  let priceLine = "—";
  if (openPrice != null) {
    priceLine = fmtTradePx(openPrice) + (orderType === "limit" ? " · LIMIT" : " · AVG");
  } else if (orderType === "limit") {
    priceLine = "LIMIT · 待成交";
  } else {
    priceLine = "MKT · 见持仓均价";
  }

  const body = document.createElement("div");
  body.className = "llm-round-event-body";
  const title = document.createElement("div");
  title.className = "llm-round-event-title";
  title.textContent = side === "short" ? "做空开仓" : "做多开仓";
  const meta = document.createElement("div");
  meta.className = "llm-round-event-meta";

  const metaLines = [
    ["入场", priceLine],
    ["TP", takeProfit != null ? fmtTradePx(takeProfit) : "未设"],
    ["SL", stopLoss != null ? fmtTradePx(stopLoss) : "未设"],
  ];
  for (const [label, value] of metaLines) {
    const row = document.createElement("span");
    row.className = "llm-round-event-meta-item";
    const k = document.createElement("span");
    k.className = "llm-round-event-meta-label";
    k.textContent = label;
    const v = document.createElement("span");
    v.className = "llm-round-event-meta-value";
    v.textContent = value;
    row.append(k, v);
    meta.appendChild(row);
  }

  body.append(title, meta);
  wrap.append(badgeCell, body);
  return wrap;
}

/**
 * @param {object} args
 * @param {object} result
 * @returns {HTMLElement | null}
 */
function buildCloseTradeStripElement(args, result) {
  const orderType = String(args.order_type || "market").toLowerCase() === "limit" ? "limit" : "market";
  const limitPx = pickFiniteNum(args.limit_price);
  const ex = result.exchange && typeof result.exchange === "object" ? result.exchange : {};
  const closeSz = ex.closeSz != null && String(ex.closeSz).trim() !== "" ? String(ex.closeSz) : "—";
  const closedSide =
    result.closedSide === "short" || result.closedSide === "long" ? result.closedSide : null;

  const wrap = document.createElement("div");
  const sideMod =
    closedSide === "short"
      ? "llm-round-close-trade--short"
      : closedSide === "long"
        ? "llm-round-close-trade--long"
        : "llm-round-close-trade--unknown";
  wrap.className = `llm-round-close-trade ${sideMod}`;
  wrap.setAttribute("role", "status");

  const badge = document.createElement("span");
  badge.className = "llm-round-event-badge llm-round-event-badge--close";
  badge.textContent = "CLOSE";
  const badgeCell = document.createElement("div");
  badgeCell.className = "llm-round-event-badge-cell";
  badgeCell.appendChild(badge);
  const priceLine =
    orderType === "limit" && limitPx != null
      ? `${fmtTradePx(limitPx)} · LIMIT`
      : orderType === "limit"
        ? "LIMIT · 待确认"
        : "MKT";

  const body = document.createElement("div");
  body.className = "llm-round-event-body";
  const title = document.createElement("div");
  title.className = "llm-round-event-title";
  if (closedSide === "short") title.textContent = "平空";
  else if (closedSide === "long") title.textContent = "平多";
  else title.textContent = "平仓";
  const meta = document.createElement("div");
  meta.className = "llm-round-event-meta";
  const metaLines = [
    ["委托", priceLine],
    ["数量", closeSz],
  ];
  for (const [label, value] of metaLines) {
    const row = document.createElement("span");
    row.className = "llm-round-event-meta-item";
    const k = document.createElement("span");
    k.className = "llm-round-event-meta-label";
    k.textContent = label;
    const v = document.createElement("span");
    v.className = "llm-round-event-meta-value";
    v.textContent = value;
    row.append(k, v);
    meta.appendChild(row);
  }

  body.append(title, meta);
  wrap.append(badgeCell, body);
  return wrap;
}

/**
 * 按 tool_trace **时间顺序**生成平仓/开仓摘要块；同一根 K 线内先平后开会得到上下两块。
 * 卡片整体高亮取**最后一笔**成功交易（平→开 则与最终开仓方向一致）。
 * @param {object} payload
 * @returns {{ stack: HTMLElement | null, accent: "long" | "short" | "close" | null }}
 */
function buildTradeStackFromToolTrace(payload) {
  const toolTrace = payload?.llm?.toolTrace;
  if (!Array.isArray(toolTrace)) return { stack: null, accent: null };
  /** @type {HTMLElement[]} */
  const blocks = [];
  /** @type {"long" | "short" | "close" | null} */
  let accent = null;

  for (const t of toolTrace) {
    const name = t?.name != null ? String(t.name) : "";
    const result = t?.result && typeof t.result === "object" ? t.result : {};
    if (result.ok !== true) continue;
    const args = t?.args && typeof t.args === "object" ? t.args : {};
    if (name === "close_position") {
      const el = buildCloseTradeStripElement(args, result);
      if (el) {
        blocks.push(el);
        accent =
          result.closedSide === "short"
            ? "short"
            : result.closedSide === "long"
              ? "long"
              : "close";
      }
    } else if (name === "open_position") {
      const el = buildOpenTradeStripElement(args, result);
      if (el) {
        blocks.push(el);
        accent = String(args.side || "").toLowerCase() === "short" ? "short" : "long";
      }
    }
  }

  const stack = document.createElement("div");
  stack.className = "llm-round-trade-stack";
  if (blocks.length === 0) {
    stack.appendChild(buildNeutralTradeStripElement(getNeutralTradeKind(payload), payload?.llm));
    return { stack, accent: null };
  }
  for (const b of blocks) stack.appendChild(b);
  return { stack, accent };
}

/**
 * @param {HTMLElement} card
 * @param {HTMLElement} inner
 * @param {HTMLElement} subEl
 * @param {object} payload
 */
function applyTradeStripsToRoundCard(card, inner, subEl, payload) {
  for (const n of inner.querySelectorAll(".llm-round-trade-stack")) {
    n.remove();
  }
  card.classList.remove(
    "llm-round-card--has-open",
    "llm-round-card--open-long",
    "llm-round-card--open-short",
    "llm-round-card--trade-close",
  );
  const { stack, accent } = buildTradeStackFromToolTrace(payload);
  if (!stack) return;
  card.classList.add("llm-round-card--has-open");
  if (accent === "close") {
    card.classList.add("llm-round-card--trade-close");
  } else if (accent === "short") {
    card.classList.add("llm-round-card--open-short");
  } else if (accent === "long") {
    card.classList.add("llm-round-card--open-long");
  }
  inner.insertBefore(stack, subEl);
}

/**
 * 列表卡片上可见的说明（`.llm-round-stream-target` 在 CSS 中不可见，主因/跳过须写在此处）。
 * @param {HTMLElement} el
 * @param {object} llm
 */
function fillLlmRoundCardNoteElement(el, llm) {
  if (!el) return;
  const skip = llm?.skippedReason && String(llm.skippedReason).trim();
  const err = llm?.error && String(llm.error).trim() && !llm?.streaming;
  if (skip) {
    el.textContent = skip;
    el.className = "llm-round-card-note llm-round-card-note--skip";
    el.hidden = false;
  } else if (err) {
    el.textContent = String(llm.error).trim();
    el.className = "llm-round-card-note llm-round-card-note--error";
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

/**
 * @param {string} barCloseId
 * @param {object} llm
 */
function syncLlmRoundCardNoteFromPayload(barCloseId, llm) {
  const root = findLlmRoundRoot(barCloseId);
  if (!root) return;
  const el = root.querySelector(".llm-round-card-note");
  if (el instanceof HTMLElement) fillLlmRoundCardNoteElement(el, llm);
}

/**
 * 流式结束后根据最终 toolTrace 更新平仓/开仓摘要区。
 * @param {string} barCloseId
 * @param {unknown} toolTrace
 * @param {"idle" | "error"} [state]
 * @param {object} [llmPatch] 与无成交摘要条一起展示；失败时须带 `error` 原文，勿覆盖为 \"error\"。
 */
function syncLlmRoundTradeStrips(barCloseId, toolTrace, state = "idle", llmPatch) {
  const root = findLlmRoundRoot(barCloseId);
  if (!root) return;
  const card = root.querySelector(".llm-round-card");
  const inner = root.querySelector(".llm-round-card-inner");
  const sub = root.querySelector(".llm-round-card-sub");
  if (card instanceof HTMLElement && inner instanceof HTMLElement && sub instanceof HTMLElement) {
    const base = llmPatch && typeof llmPatch === "object" ? { ...llmPatch } : {};
    if (state === "error") {
      const em = typeof base.error === "string" && base.error.trim() ? base.error.trim() : "";
      base.error = em || "error";
    } else {
      if (!("error" in base)) base.error = null;
    }
    applyTradeStripsToRoundCard(card, inner, sub, {
      llm: {
        ...base,
        toolTrace: Array.isArray(toolTrace) ? toolTrace : [],
      },
    });
  }
}

/**
 * 构建单轮 DOM（实时收盘与库分页复用）：卡片 + 可见的 `.llm-round-card-note`；隐藏区仍供流式/IPC 更新气泡。
 * @returns {HTMLElement} `.llm-round` 根节点
 */
function buildLlmRoundElement(payload) {
  const llm = payload?.llm;
  const barCloseId = payload?.barCloseId;
  if (!barCloseId || !llm) {
    throw new Error("buildLlmRoundElement: 无效 payload");
  }
  const allowListItem =
    llm.enabled === true || Boolean(llm.skippedReason && String(llm.skippedReason).trim());
  if (!allowListItem) {
    throw new Error("buildLlmRoundElement: 无效 payload");
  }
  const display = resolveAssistantAndToolDisplay(llm);
  const statusKind = getLlmRoundStatusKind(payload, llm);
  const locked = llm.streaming === true;

  const round = document.createElement("div");
  round.className = "llm-round";
  round.dataset.barCloseId = barCloseId;
  round.dataset.tvSymbol = payload.tvSymbol || "";
  round.dataset.capturedAt = payload.capturedAt || "";
  round.dataset.detailLocked = locked ? "1" : "0";

  const cap = payload.capturedAt
    ? new Date(payload.capturedAt).toLocaleString("zh-CN", { hour12: false })
    : "";

  const card = document.createElement("div");
  card.className = "llm-round-card";
  if (locked) card.classList.add("llm-round-card--locked");

  const inner = document.createElement("div");
  inner.className = "llm-round-card-inner";

  const top = document.createElement("div");
  top.className = "llm-round-card-top";

  const head = document.createElement("div");
  head.className = "llm-round-card-head";
  const summaryTitle = document.createElement("span");
  summaryTitle.className = "llm-round-summary-title";
  summaryTitle.textContent = payload.tvSymbol || "未命名标的";
  head.appendChild(summaryTitle);

  top.append(head, buildLlmRoundStatusEl(statusKind));

  const sub = document.createElement("div");
  sub.className = "llm-round-card-sub";
  const subMeta = document.createElement("div");
  subMeta.className = "llm-round-card-submeta";
  const timeEl = document.createElement("span");
  timeEl.className = "llm-round-card-time";
  timeEl.textContent = cap;
  const detailBtn = document.createElement("button");
  detailBtn.type = "button";
  detailBtn.className = "llm-round-detail-btn";
  detailBtn.textContent = "详情";
  detailBtn.disabled = locked;
  detailBtn.setAttribute(
    "aria-label",
    locked ? "决策完成后可查看明细" : "在弹窗中查看多轮对话明细",
  );
  const skipped = Boolean(llm.skippedReason && String(llm.skippedReason).trim());
  if (skipped) {
    detailBtn.disabled = true;
    detailBtn.textContent = "—";
    detailBtn.setAttribute("aria-label", "本轮未调用 Agent，无会话明细");
    round.dataset.detailLocked = "1";
  }
  subMeta.append(timeEl);
  sub.append(subMeta, detailBtn);
  const cardNote = document.createElement("div");
  cardNote.className = "llm-round-card-note";
  cardNote.setAttribute("role", "status");
  fillLlmRoundCardNoteElement(cardNote, llm);

  inner.appendChild(top);
  inner.appendChild(cardNote);
  inner.appendChild(sub);
  applyTradeStripsToRoundCard(card, inner, sub, payload);
  card.appendChild(inner);

  const openIfUnlocked = () => {
    if (round.dataset.detailLocked === "1") return;
    void openLlmSessionDetailModal(barCloseId);
  };
  card.addEventListener("click", (e) => {
    const t = /** @type {HTMLElement | null} */ (e.target);
    if (t?.closest?.(".llm-round-detail-btn")) return;
    openIfUnlocked();
  });
  detailBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!detailBtn.disabled) void openLlmSessionDetailModal(barCloseId);
  });

  const streamTarget = document.createElement("div");
  streamTarget.className = "llm-round-stream-target";
  streamTarget.setAttribute("aria-hidden", "true");

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
  streamTarget.appendChild(rowUser);
  if (rowReasoning) streamTarget.appendChild(rowReasoning);
  streamTarget.appendChild(rowTool);
  streamTarget.appendChild(rowAsst);

  round.appendChild(card);
  round.appendChild(streamTarget);
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
  if (!history || !barCloseId || !llm) return null;
  const canAppend =
    llm.enabled === true || Boolean(llm.skippedReason && String(llm.skippedReason).trim());
  if (!canAppend) return null;

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
  let iv = AGENT_DECISION_INTERVAL;
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
 * 同步顶栏当前策略下拉；仍沿用隐藏原生 select 供 imperative 逻辑读写。
 * @param {{ promptStrategies?: string[], promptStrategy?: string }} cfg
 */
function applyPromptStrategySelect(cfg) {
  const sel = document.getElementById("config-prompt-strategy");
  const list =
    Array.isArray(cfg?.promptStrategies) && cfg.promptStrategies.length > 0
      ? cfg.promptStrategies
      : [cfg?.promptStrategy || "default"];
  const cur =
    cfg?.promptStrategy && list.includes(cfg.promptStrategy)
      ? cfg.promptStrategy
      : list.includes("default")
        ? "default"
        : list[0];
  if (sel) {
    sel.replaceChildren();
    for (const name of list) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    }
    sel.value = cur;
  }
  window.dispatchEvent(
    new CustomEvent("argus:prompt-strategy-sync", {
      detail: {
        options: list.map((name) => ({ value: name, label: name })),
        value: cur,
      },
    }),
  );
}

/**
 * 将快捷栏选的标的 / 周期写入本地设置（合并保存），并刷新主进程行情路由。
 * @param {{ defaultSymbol?: string, interval?: string }} partial
 */
async function persistChartPreferences(partial) {
  if (!partial || typeof partial !== "object") return;
  if (!window.argus || typeof window.argus.saveConfig !== "function") {
    return;
  }
  try {
    const saved = await window.argus.saveConfig(partial);
    chartInterval = saved.interval || chartInterval;
    applyChartIntervalSelect(chartInterval);
    applySymbolSelect(saved);
  } catch (err) {
    console.error(err);
    setLlmStatus("保存行情设置失败");
  }
}

/**
 * 将顶栏当前策略写入本地设置；切换即生效。
 * @param {string} promptStrategy
 */
async function persistPromptStrategyPreference(promptStrategy) {
  const next = String(promptStrategy ?? "").trim() || "default";
  if (!window.argus || typeof window.argus.saveConfig !== "function") {
    applyPromptStrategySelect({
      promptStrategies: [next],
      promptStrategy: next,
    });
    return;
  }
  try {
    const saved = await window.argus.saveConfig({ promptStrategy: next });
    applyPromptStrategySelect(saved);
    setLlmStatus(`已切换策略：${saved.promptStrategy || next}`);
  } catch (err) {
    console.error(err);
    setLlmStatus("切换策略失败");
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
const ARGUS_DASHBOARD_MODAL_OPEN = "argus:dashboard-modal-open";
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
    applyPromptStrategySelect(cfg);
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
      el.closest(".config-row")?.remove();
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
        const symbols = collectSymbolsFromConfigRows();
        if (symbols.length === 0) {
          setLlmStatus("请至少填写一行品种");
          return;
        }
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
        const okxSwapTradingEnabled = okxEn?.checked === true;
        const okxSimulated = okxSim?.checked !== false;
        const okxApiKey = okxAk?.value?.trim() ?? "";
        const okxSecretKey = okxSk?.value?.trim() ?? "";
        const okxPassphrase = okxPh?.value?.trim() ?? "";
        const currentSymbolEl = document.getElementById("symbol-select");
        const currentSymbol = currentSymbolEl?.value?.trim() ?? "";
        const fallbackSymbol = symbols[0]?.value ?? "OKX:BTCUSDT";
        const nextDefaultSymbol = symbols.some((s) => s.value === currentSymbol) ? currentSymbol : fallbackSymbol;

        if (!window.argus || typeof window.argus.saveConfig !== "function") {
          applySymbolSelect({ symbols, defaultSymbol: nextDefaultSymbol });
          createTradingViewWidget(nextDefaultSymbol, chartInterval);
          closeModal();
          refreshExchangeContextBarFromCache();
          void refreshOkxPositionBar();
          return;
        }
        try {
          const saved = await window.argus.saveConfig({
            symbols,
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
          });
          applySymbolSelect(saved);
          chartInterval = saved.interval || chartInterval;
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

function initDashboardModal() {
  const btn = document.getElementById("btn-open-dashboard");
  if (!btn) return;
  btn.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent(ARGUS_DASHBOARD_MODAL_OPEN));
  });
}

function destroyWidget() {
  for (const widget of tvWidgets.values()) {
    if (widget && typeof widget.remove === "function") {
      try {
        widget.remove();
      } catch {
        /* ignore */
      }
    }
  }
  tvWidgets = new Map();
  for (const spec of MULTI_TIMEFRAME_SPECS) {
    const el = document.getElementById(spec.containerId);
    if (el) el.innerHTML = "";
  }
}

function createTradingViewWidget(symbol, interval) {
  destroyWidget();

  if (typeof TradingView === "undefined" || !TradingView.widget) {
    for (const spec of MULTI_TIMEFRAME_SPECS) {
      const el = document.getElementById(spec.containerId);
      if (el) {
        el.innerHTML =
          '<p style="padding:16px;color:#f85149;font-size:13px;">无法加载 TradingView 脚本，请检查网络或 CSP。</p>';
      }
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
  for (const spec of MULTI_TIMEFRAME_SPECS) {
    const widget = new TradingView.widget({
      autosize: true,
      symbol: symbol || "OKX:BTCUSDT",
      interval: spec.interval,
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
      container_id: spec.containerId,
      allow_symbol_change: true,
      studies: [
        {
          id: "MAExp@tv-basicstudies",
          inputs: { length: DEFAULT_EMA_LENGTH },
        },
      ],
    });
    tvWidgets.set(spec.interval, widget);
  }
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

function initPromptStrategySelect() {
  const sel = document.getElementById("config-prompt-strategy");
  if (!sel) return;
  sel.addEventListener("change", () => {
    void persistPromptStrategyPreference(sel.value);
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
  if (Array.isArray(safe.multiChartImages)) {
    safe.multiChartImages = safe.multiChartImages.map((item) => {
      if (!item?.base64) return item;
      return {
        ...item,
        base64: `[省略 ${String(item.base64).length} 字符]`,
      };
    });
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
    [(s) => s.includes("收盘 · Agent 已跳过"), "已跳过"],
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
      const shot = await captureMultiTimeframeCharts();
      window.argus.submitChartCaptureResult({
        requestId,
        ok: true,
        mimeType: shot.mimeType,
        base64: shot.base64,
        dataUrl: shot.dataUrl,
        charts: shot.charts,
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
      llm &&
      (Boolean(llm.skippedReason && String(llm.skippedReason).trim()) ||
        (llm.enabled === true &&
          (llm.streaming === true ||
            Boolean(llm.analysisText) ||
            Boolean(llm.error))));
    if (showRound) {
      appendLlmRound(payload);
    }

    try {
      console.log("[Argus] market-bar-close", JSON.parse(formatBarClosePreview(payload)));
    } catch {
      console.log("[Argus] market-bar-close", payload);
    }
    if (llm?.skippedReason && String(llm.skippedReason).trim()) {
      setLlmStatus("收盘 · Agent 已跳过");
    } else if (payload?.chartCaptureError) {
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
      ({ barCloseId, analysisText, cardSummary, reasoningText, toolTrace, conversationKey, exchangeContext }) => {
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
      syncLlmRoundTradeStrips(barCloseId, toolTrace, "idle", { analysisText, cardSummary });
      syncLlmRoundCardNoteFromPayload(barCloseId, { skippedReason: null, error: null, streaming: false });
      if (conversationKey && exchangeContext) {
        rememberExchangeContext(conversationKey, exchangeContext);
        if (conversationKey === currentConversationKeyForUi()) {
          updateOkxBarFromExchangeContext(exchangeContext);
        }
      }
      updateLlmRoundAfterAgentFinished(barCloseId, "ok");
      if (barCloseId !== latestBarCloseId) return;
      if (window.argusLastBarClose?.llm) {
        window.argusLastBarClose.llm.analysisText = analysisText;
        window.argusLastBarClose.llm.cardSummary =
          cardSummary != null && String(cardSummary).trim() ? String(cardSummary).trim() : null;
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
      syncLlmRoundTradeStrips(barCloseId, toolTrace, "error", {
        error: message && String(message).trim() ? String(message).trim() : "错误",
      });
      syncLlmRoundCardNoteFromPayload(barCloseId, {
        skippedReason: null,
        error: message && String(message).trim() ? String(message).trim() : "错误",
        streaming: false,
      });
      updateLlmRoundAfterAgentFinished(barCloseId, "err");
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
    applyPromptStrategySelect(cfg);
    const sym = cfg.defaultSymbol || cfg.symbols[0]?.value || "OKX:BTCUSDT";
    createTradingViewWidget(sym, chartInterval);
    if (window.argus && typeof window.argus.setMarketContext === "function") {
      window.argus.setMarketContext(sym);
    }
    initSymbolSelect();
    initChartIntervalSelect();
    initPromptStrategySelect();
    initChartCaptureBridge();
    initConfigCenter();
    initDashboardModal();
    initStrategyCenter();
    initDevToolsButton();
    initFishMode();
    initLlmChartPreview();
    initLlmSessionDetailModal();
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
