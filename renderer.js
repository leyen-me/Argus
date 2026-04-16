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
 * 正式内容由应用目录 `prompts/system-crypto.txt`、`prompts/system-stocks.txt` 提供。
 */
const FALLBACK_SYSTEM_PROMPT_CRYPTO =
  "你是资深加密市场价格行为分析助手，核心方法参考 Al Brooks，但输出必须服务于一个由代码维护的交易状态机。" +
  "先判断趋势、震荡或过渡，再分析本根收盘 K 线在当前位置是延续、测试、拒绝、突破、失败突破还是噪音。" +
  "重点看价格行为本身，不机械复述原始 OHLCV；所有结论都基于概率，没有足够 edge 时优先保守。" +
  "你必须严格服从状态机：只能从 allowed_intents 中选择一个 intent；若当前为 HOLDING_*，禁止重复开仓；若当前为 LOOKING_*，只有确认成立才允许 ENTER_*。" +
  "若信号一般、位置不佳、盈亏比不清晰或只是震荡中部，优先 WAIT / HOLD / CANCEL_LOOKING。" +
  "请只返回严格 JSON，不要输出 Markdown、代码块或额外解释。";
const FALLBACK_SYSTEM_PROMPT_STOCKS =
  "你是资深证券与权益市场价格行为分析助手，核心方法参考 Al Brooks，但输出必须服务于一个由代码维护的交易状态机。" +
  "先判断趋势、震荡或过渡，再分析本根收盘 K 线在当前位置是延续、测试、拒绝、突破、失败突破还是噪音。" +
  "重点看价格行为本身，不机械复述原始 OHLCV；所有结论都基于概率，没有足够 edge 时优先保守。" +
  "你必须严格服从状态机：只能从 allowed_intents 中选择一个 intent；若当前为 HOLDING_*，禁止重复开仓；若当前为 LOOKING_*，只有确认成立才允许 ENTER_*。" +
  "若处于盘前、盘后、开盘初段异常波动或流动性不足时段，必须降低信心并体现谨慎；若只是区间中部噪音，优先 WAIT / HOLD / CANCEL_LOOKING。" +
  "请只返回严格 JSON，不要输出 Markdown、代码块或额外解释。";

/** 与仓库 config.json 一致，供非 Electron 打开页面时兜底 */
const FALLBACK_APP_CONFIG = {
  symbols: [
    { label: "BTC/USDT (OKX)", value: "OKX:BTCUSDT" },
    { label: "ETH/USDT (OKX)", value: "OKX:ETHUSDT" },
    { label: "SPY", value: "AMEX:SPY" },
    { label: "QQQ", value: "NASDAQ:QQQ" },
  ],
  defaultSymbol: "OKX:BTCUSDT",
  interval: "5",
  openaiBaseUrl: "https://api.openai.com/v1",
  openaiModel: "gpt-4o-mini",
  openaiApiKey: "",
  systemPromptCrypto: FALLBACK_SYSTEM_PROMPT_CRYPTO,
  systemPromptStocks: FALLBACK_SYSTEM_PROMPT_STOCKS,
  llmReasoningEnabled: false,
  tradeNotifyEmailEnabled: false,
  smtpHost: "smtp.qq.com",
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: "",
  smtpPass: "",
  notifyEmailTo: "",
};

/** 与配置 `interval` 一致，供 TradingView 与主进程路由共用 */
let chartInterval = "5";

/** 按 `品种|周期` 缓存最近一次交易状态机快照，切换品种时可从缓存恢复展示 */
window.argusTradeStateCache = window.argusTradeStateCache || Object.create(null);

const TRADE_STATE_LABELS = {
  IDLE: "空仓观望",
  LOOKING_LONG: "观察做多",
  LOOKING_SHORT: "观察做空",
  HOLDING_LONG: "模拟持多",
  HOLDING_SHORT: "模拟持空",
  COOLDOWN: "冷静期",
};

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
 * @param {object | null | undefined} tradeState
 */
function rememberTradeState(key, tradeState) {
  if (!key || !tradeState || typeof tradeState !== "object") return;
  window.argusTradeStateCache[key] = tradeState;
}

/**
 * @param {object | null | undefined} ev
 */
function formatTradeStateEventLine(ev) {
  if (!ev || typeof ev !== "object") return "";
  const side = ev.side === "SHORT" ? "空" : ev.side === "LONG" ? "多" : "";
  const t = ev.type === "TAKE_PROFIT" ? "止盈" : ev.type === "STOP_LOSS" ? "止损" : "";
  const p = ev.exitPrice != null ? String(ev.exitPrice) : "";
  if (t && side && p) return `（本根触发${side}单${t} @ ${p}）`;
  if (t && p) return `（本根触发${t} @ ${p}）`;
  return "";
}

/**
 * @param {object | null | undefined} ts
 */
function formatTradeStateLine(ts) {
  if (!ts || typeof ts !== "object") {
    return {
      text: "暂无记录 · 待下一根 K 线收盘后更新",
      title: "由应用内状态机维护，仅为分析纪律用，不代表真实持仓或成交。",
    };
  }
  const state = String(ts.state || "IDLE");
  const label = TRADE_STATE_LABELS[state] || state;
  const parts = [label];

  if (state === "LOOKING_LONG" || state === "LOOKING_SHORT") {
    if (ts.keyLevel != null) parts.push(`关键位 ${ts.keyLevel}`);
  }
  if (state === "HOLDING_LONG" || state === "HOLDING_SHORT") {
    if (ts.entryPrice != null) parts.push(`入 ${ts.entryPrice}`);
    if (ts.stopLoss != null) parts.push(`损 ${ts.stopLoss}`);
    if (ts.takeProfit != null) parts.push(`盈 ${ts.takeProfit}`);
  }
  if (state === "COOLDOWN" && ts.cooldownUntil) {
    const t = new Date(ts.cooldownUntil).toLocaleTimeString("zh-CN", { hour12: false });
    parts.push(`至 ${t}`);
  }

  const detail = [
    ts.lastTransitionReason ? `原因: ${ts.lastTransitionReason}` : "",
    ts.lastDecisionIntent ? `意图: ${ts.lastDecisionIntent}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    text: parts.join(" · "),
    title: detail || JSON.stringify(ts, null, 2),
  };
}

/**
 * @param {object | null | undefined} tradeState
 * @param {object | null | undefined} tradeStateEvent
 */
function updateTradeStateDisplay(tradeState, tradeStateEvent) {
  const el = document.getElementById("llm-trade-state-text");
  if (!el) return;
  const { text, title } = formatTradeStateLine(tradeState);
  const evLine = formatTradeStateEventLine(tradeStateEvent);
  el.textContent = evLine ? `${text} ${evLine}` : text;
  el.title = title;
}

function refreshTradeStateBarFromCache() {
  const sel = document.getElementById("symbol-select");
  const sym = sel?.value?.trim() || "";
  const key = conversationKeyForUi(sym, chartInterval);
  const cached = key ? window.argusTradeStateCache[key] : null;
  updateTradeStateDisplay(cached, null);
}

/** 当前最近一次收盘推送 id，用于忽略过期的流式片段 */
let latestBarCloseId = null;

/** 右侧保留的「收盘 + LLM」轮数上限，避免 DOM 无限增长 */
const LLM_HISTORY_MAX_ROUNDS = 40;

/**
 * 与 `market.inferFeed` 一致：界面侧按当前品种解析将使用哪条系统提示词。
 * @param {string} tvSymbol
 * @param {{ feed?: string } | undefined} symEntry 配置中该品种行
 */
function inferFeedForSymbol(tvSymbol, symEntry) {
  const explicit = symEntry?.feed;
  if (explicit === "crypto" || explicit === "longbridge") return explicit;
  const v = String(tvSymbol || "").trim();
  if (v.startsWith("BINANCE:") || v.startsWith("OKX:")) return "crypto";
  return "longbridge";
}

/**
 * @param {object} cfg `loadAppConfig()` 结果
 * @param {string} tvSymbol
 */
function resolveSystemPromptForUi(cfg, tvSymbol) {
  const c = cfg || FALLBACK_APP_CONFIG;
  const symEntry = c.symbols?.find((s) => s.value === tvSymbol);
  const feed = inferFeedForSymbol(tvSymbol, symEntry);
  if (feed === "crypto") {
    return c.systemPromptCrypto ?? FALLBACK_APP_CONFIG.systemPromptCrypto;
  }
  return c.systemPromptStocks ?? FALLBACK_APP_CONFIG.systemPromptStocks;
}

/**
 * @param {string} systemText
 * @returns {HTMLElement | null}
 */
function buildSystemPromptRow(systemText) {
  const t = String(systemText || "").trim();
  if (!t) return null;
  const rowSystem = document.createElement("div");
  rowSystem.className = "llm-chat-row llm-chat-row--system";
  const details = document.createElement("details");
  details.className = "llm-system-details";
  const summary = document.createElement("summary");
  summary.className = "llm-system-summary";
  summary.textContent = "系统提示词 · 点击展开";
  const bubbleSys = document.createElement("div");
  bubbleSys.className = "llm-bubble llm-bubble--system";
  bubbleSys.textContent = t;
  details.append(summary, bubbleSys);
  rowSystem.appendChild(details);
  return rowSystem;
}

/**
 * 启动后 / 切换品种时：右侧顶部展示当前将使用的系统提示词（无需等 K 线收盘）。
 * @param {object} cfg
 * @param {string} tvSymbol
 */
function updateCurrentSystemPromptPreview(cfg, tvSymbol) {
  const root = document.getElementById("llm-current-system");
  if (!root) return;
  root.replaceChildren();
  const sym = String(tvSymbol || "").trim() || "—";
  const c = cfg || FALLBACK_APP_CONFIG;
  const symEntry = c.symbols?.find((s) => s.value === tvSymbol);
  const feed = inferFeedForSymbol(tvSymbol, symEntry);
  const routeLabel = feed === "crypto" ? "币圈（7×24）" : "股票 / 长桥";
  const meta = document.createElement("div");
  meta.className = "llm-current-system-meta";
  meta.textContent = `当前图表：${sym} · 路由：${routeLabel}`;
  const text = String(resolveSystemPromptForUi(c, tvSymbol) || "").trim();
  const row = buildSystemPromptRow(text);
  root.appendChild(meta);
  if (row) {
    root.appendChild(row);
  } else {
    const hint = document.createElement("div");
    hint.className = "llm-current-system-empty";
    hint.textContent = "（未配置系统提示词）";
    root.appendChild(hint);
  }
}

async function refreshCurrentSystemPromptPreview() {
  const cfg = await loadAppConfig();
  const sel = document.getElementById("symbol-select");
  const sym =
    sel?.value?.trim() ||
    cfg.defaultSymbol ||
    cfg.symbols[0]?.value ||
    "OKX:BTCUSDT";
  updateCurrentSystemPromptPreview(cfg, sym);
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
 * 每根 K 线收盘且启用 LLM 时追加一轮（左模型回复 / 右用户与推送摘要），流式时先占位「…」。
 * @returns {HTMLElement | null} 本轮助手气泡，便于调试
 */
function appendLlmRound(payload) {
  const history = document.getElementById("llm-chat-history");
  const llm = payload?.llm;
  const barCloseId = payload?.barCloseId;
  if (!history || !barCloseId || !llm?.enabled) return null;

  const round = document.createElement("div");
  round.className = "llm-round";
  round.dataset.barCloseId = barCloseId;

  const meta = document.createElement("div");
  meta.className = "llm-round-meta";
  const cap = payload.capturedAt
    ? new Date(payload.capturedAt).toLocaleString("zh-CN", { hour12: false })
    : "";
  meta.textContent = [payload.tvSymbol, cap, payload.conversationKey ? "多轮上下文" : ""]
    .filter(Boolean)
    .join(" · ");

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
  }

  const rowUser = document.createElement("div");
  rowUser.className = "llm-chat-row llm-chat-row--user";
  const bubbleUser = document.createElement("div");
  bubbleUser.className = "llm-bubble llm-bubble--user";
  bubbleUser.textContent = truncateText(payload?.textForLlm || "", 400);

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

  const rowAsst = document.createElement("div");
  rowAsst.className = "llm-chat-row llm-chat-row--assistant";
  const bubbleAsst = document.createElement("div");
  bubbleAsst.className = "llm-bubble llm-bubble--assistant";
  bubbleAsst.classList.remove("llm-bubble--error");
  if (llm.streaming) {
    bubbleAsst.textContent = "…";
  } else if (llm.analysisText) {
    bubbleAsst.textContent = normalizeAssistantDisplayText(llm.analysisText);
  } else {
    bubbleAsst.textContent = llm.error || "";
    bubbleAsst.classList.add("llm-bubble--error");
  }

  rowUser.appendChild(bubbleUser);
  rowAsst.appendChild(bubbleAsst);
  const parts = [meta];
  if (thumbRow) parts.push(thumbRow);
  parts.push(rowUser);
  if (rowReasoning) parts.push(rowReasoning);
  parts.push(rowAsst);
  round.append(...parts);
  history.appendChild(round);
  history.hidden = false;

  while (history.children.length > LLM_HISTORY_MAX_ROUNDS) {
    history.removeChild(history.firstChild);
  }
  history.scrollTop = history.scrollHeight;
  return bubbleAsst;
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
    btn.addEventListener("click", () => {
      row.remove();
      onConfigRowRemoved();
    });

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
  if (!btn || !overlay) return;

  const setActive = (on) => {
    overlay.hidden = !on;
    overlay.setAttribute("aria-hidden", on ? "false" : "true");
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.classList.toggle("titlebar-config--fish-active", on);
    btn.textContent = on ? "摸鱼中…" : "摸鱼模式";
  };

  btn.addEventListener("click", () => {
    setActive(overlay.hidden);
  });

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

function initConfigCenter() {
  const modal = document.getElementById("config-modal");
  const btnOpen = document.getElementById("btn-open-config");
  const btnClose = document.getElementById("btn-config-close");
  const btnCancel = document.getElementById("btn-config-cancel");
  const btnSave = document.getElementById("btn-config-save");
  const btnReset = document.getElementById("btn-config-reset");
  const btnAdd = document.getElementById("btn-config-add");
  const pathEl = document.getElementById("config-file-path");

  if (!modal || !btnOpen || !btnSave) return;

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
  };

  const closeModal = () => {
    modal.hidden = true;
  };

  const openModal = async () => {
    const cfg = await loadAppConfig();
    if (pathEl && window.argus && typeof window.argus.getConfigPath === "function") {
      try {
        const p = await window.argus.getConfigPath();
        pathEl.textContent = `配置文件（仅此一份）：${p}`;
      } catch {
        pathEl.textContent = "";
      }
    }
    fillConfigModalFields(cfg);
    modal.hidden = false;
  };

  btnOpen.addEventListener("click", () => {
    openModal();
  });
  btnReset?.addEventListener("click", async () => {
    const ok = window.confirm(
      "将用户目录下的 config.json 恢复为安装目录模板（或内置默认值）。API Key、SMTP 等将清空为默认，是否继续？",
    );
    if (!ok) return;

    if (!window.argus || typeof window.argus.resetConfig !== "function") {
      fillConfigModalFields(FALLBACK_APP_CONFIG);
      applySymbolSelect(FALLBACK_APP_CONFIG);
      chartInterval = FALLBACK_APP_CONFIG.interval || "5";
      createTradingViewWidget(FALLBACK_APP_CONFIG.defaultSymbol);
      void refreshCurrentSystemPromptPreview();
      setLlmStatus("已恢复界面为内置默认（非 Electron 环境不会写入磁盘）");
      refreshTradeStateBarFromCache();
      return;
    }
    try {
      const saved = await window.argus.resetConfig();
      fillConfigModalFields(saved);
      applySymbolSelect(saved);
      chartInterval = saved.interval || "5";
      createTradingViewWidget(saved.defaultSymbol);
      void refreshCurrentSystemPromptPreview();
      setLlmStatus("配置已恢复默认");
      refreshTradeStateBarFromCache();
    } catch (err) {
      console.error(err);
      setLlmStatus("恢复默认配置失败");
    }
  });
  btnClose?.addEventListener("click", closeModal);
  btnCancel?.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  btnAdd?.addEventListener("click", () => {
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
    btn.addEventListener("click", () => {
      row.remove();
      onConfigRowRemoved();
    });
    row.append(inLabel, inValue, btn);
    container.appendChild(row);
  });

  btnSave.addEventListener("click", async () => {
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

    if (!window.argus || typeof window.argus.saveConfig !== "function") {
      applySymbolSelect({ symbols, defaultSymbol });
      chartInterval = interval;
      createTradingViewWidget(defaultSymbol);
      const selAfter = document.getElementById("symbol-select");
      updateCurrentSystemPromptPreview(
        {
          ...FALLBACK_APP_CONFIG,
          symbols,
          defaultSymbol,
          interval,
          llmReasoningEnabled,
          tradeNotifyEmailEnabled,
          smtpUser,
          smtpPass,
          notifyEmailTo,
        },
        selAfter?.value?.trim() || defaultSymbol,
      );
      closeModal();
      refreshTradeStateBarFromCache();
      return;
    }
    try {
      const saved = await window.argus.saveConfig({
        symbols,
        defaultSymbol,
        interval,
        openaiBaseUrl,
        openaiModel,
        openaiApiKey,
        llmReasoningEnabled,
        tradeNotifyEmailEnabled,
        smtpUser,
        smtpPass,
        notifyEmailTo,
      });
      applySymbolSelect(saved);
      chartInterval = saved.interval || interval;
      createTradingViewWidget(saved.defaultSymbol);
      void refreshCurrentSystemPromptPreview();
      closeModal();
      refreshTradeStateBarFromCache();
    } catch (err) {
      console.error(err);
      setLlmStatus("保存配置失败");
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) {
      e.preventDefault();
      closeModal();
    }
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
    createTradingViewWidget(sel.value);
    if (window.argus && typeof window.argus.setMarketContext === "function") {
      window.argus.setMarketContext(sel.value);
    }
    void refreshCurrentSystemPromptPreview();
    refreshTradeStateBarFromCache();
  });
}

function truncateText(str, max) {
  if (str == null || str === "") return "";
  if (str.length <= max) return str;
  return `${str.slice(0, max)}…`;
}

/**
 * 助手气泡展示用：模型与流式接口常在行首或段间输出 \\n\\n；配合 CSS pre-wrap 会原样显示，看起来像「多出一行」或双倍段距。
 */
function normalizeAssistantDisplayText(s) {
  if (s == null || s === "") return "";
  return String(s)
    .replace(/\r\n/g, "\n")
    .replace(/^\n+/, "")
    .replace(/\n{2,}/g, "\n");
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
    [(s) => s.startsWith("加密 WS（") && s.includes("· K 收盘"), "WS收盘"],
    [(s) => s.startsWith("收盘处理失败"), "处理失败"],
    [(s) => s.includes("WS 断开") && s.includes("重连"), "WS重连"],
    [(s) => s.includes("无效 BINANCE"), "代码无效"],
    [(s) => s.includes("加密 WS（") && s.includes("已连接"), "WS已连"],
    [(s) => s.includes("无效 OKX"), "代码无效"],
    [(s) => s.startsWith("OKX："), "OKX异常"],
    [(s) => s.includes("请使用 BINANCE:") || (s.includes("BINANCE:") && s.includes("前缀")), "前缀无效"],
    [(s) => s.includes("未选择可订阅"), "未订阅"],
    [(s) => s.startsWith("长桥凭证无效"), "凭证无效"],
    [(s) => s.startsWith("长桥推送错误"), "推送异常"],
    [(s) => s.includes("跳过开盘前"), "跳过K"],
    [(s) => s.startsWith("长桥 K 确认"), "K确认"],
    [(s) => s.startsWith("长桥：已订阅"), "已订阅"],
    [(s) => s.startsWith("长桥订阅失败"), "订阅失败"],
    [(s) => s.startsWith("长桥：无法映射"), "映射失败"],
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

/**
 * @param {{ estimatedPromptTokens?: number, contextWindowTokens?: number, percent?: number } | null | undefined} usage
 */
function updateContextUsage(usage) {
  const el = document.getElementById("llm-context-usage");
  if (!el) return;
  el.classList.remove("panel-badge--usage-warn", "panel-badge--usage-danger");
  if (!usage || typeof usage.percent !== "number" || typeof usage.estimatedPromptTokens !== "number") {
    el.textContent = "—";
    el.title =
      "启用 LLM 后，每次收盘请求会显示估算输入占比。默认按 200K 上下文窗口；可用环境变量 ARGUS_CONTEXT_WINDOW_TOKENS 覆盖。含图时为粗估。";
    return;
  }
  const pct = usage.percent;
  const est = usage.estimatedPromptTokens;
  const cap = usage.contextWindowTokens ?? 200_000;
  el.textContent = `${pct}%`;
  el.title = `估算输入约 ${est.toLocaleString("zh-CN")} tokens，窗口 ${cap.toLocaleString("zh-CN")}（约 ${pct}%）。含图为粗估，与服务商实际计费可能略有差异。`;
  if (pct >= 80) el.classList.add("panel-badge--usage-danger");
  else if (pct >= 50) el.classList.add("panel-badge--usage-warn");
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

    if (payload?.conversationKey && payload?.tradeState) {
      rememberTradeState(payload.conversationKey, payload.tradeState);
      if (payload.conversationKey === currentConversationKeyForUi()) {
        updateTradeStateDisplay(payload.tradeState, payload.tradeStateEvent ?? null);
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
    if (payload?.usage) {
      updateContextUsage(payload.usage);
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
    onLlmStreamDelta(({ barCloseId, full, reasoningFull }) => {
      const bubbleAsst = findAssistantBubbleForBar(barCloseId);
      const bubbleReas = findReasoningBubbleForBar(barCloseId);
      if (!bubbleAsst && !bubbleReas) return;
      if (bubbleReas && reasoningFull != null) {
        bubbleReas.textContent = normalizeAssistantDisplayText(String(reasoningFull));
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
      ({ barCloseId, analysisText, reasoningText, conversationKey, tradeState, tradeStateEvent }) => {
      const bubbleAsst = findAssistantBubbleForBar(barCloseId);
      if (bubbleAsst && analysisText != null) {
        bubbleAsst.textContent = normalizeAssistantDisplayText(analysisText);
        bubbleAsst.classList.remove("llm-bubble--error");
      }
      const bubbleReas = findReasoningBubbleForBar(barCloseId);
      if (bubbleReas && reasoningText != null) {
        bubbleReas.textContent = normalizeAssistantDisplayText(String(reasoningText));
      }
      if (conversationKey && tradeState) {
        rememberTradeState(conversationKey, tradeState);
        if (conversationKey === currentConversationKeyForUi()) {
          updateTradeStateDisplay(tradeState, tradeStateEvent ?? null);
        }
      }
      if (barCloseId !== latestBarCloseId) return;
      if (window.argusLastBarClose?.llm) {
        window.argusLastBarClose.llm.analysisText = analysisText;
        window.argusLastBarClose.llm.reasoningText = reasoningText ?? "";
        window.argusLastBarClose.llm.streaming = false;
        window.argusLastBarClose.llm.error = null;
      }
      if (window.argusLastBarClose && tradeState) {
        window.argusLastBarClose.tradeState = tradeState;
      }
      if (window.argusLastBarClose && tradeStateEvent !== undefined) {
        window.argusLastBarClose.tradeStateEvent = tradeStateEvent;
      }
      setLlmStatus("收盘 · LLM 已分析");
    },
    );
  }
  if (typeof onLlmStreamError === "function") {
    onLlmStreamError(({ barCloseId, message }) => {
      const bubbleAsst = findAssistantBubbleForBar(barCloseId);
      if (bubbleAsst) {
        bubbleAsst.textContent = message || "错误";
        bubbleAsst.classList.add("llm-bubble--error");
      }
      if (barCloseId !== latestBarCloseId) return;
      if (window.argusLastBarClose?.llm) {
        window.argusLastBarClose.llm.error = message;
        window.argusLastBarClose.llm.streaming = false;
        window.argusLastBarClose.llm.analysisText = null;
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

window.addEventListener("DOMContentLoaded", async () => {
  const cfg = await loadAppConfig();
  chartInterval = cfg.interval || "5";
  applySymbolSelect(cfg);
  const sym = cfg.defaultSymbol || cfg.symbols[0]?.value || "OKX:BTCUSDT";
  createTradingViewWidget(sym, chartInterval);
  const sel = document.getElementById("symbol-select");
  updateCurrentSystemPromptPreview(cfg, sel?.value?.trim() || sym);
  if (window.argus && typeof window.argus.setMarketContext === "function") {
    window.argus.setMarketContext(sym);
  }
  initSymbolSelect();
  initChartCaptureBridge();
  initConfigCenter();
  initDevToolsButton();
  initFishMode();
  initLlmChartPreview();
  bindMarketBarClose();
  bindLlmStream();
  bindMarketStatus();
  refreshTradeStateBarFromCache();
});
