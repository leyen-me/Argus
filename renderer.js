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

/** 与仓库 config.json 一致，供非 Electron 打开页面时兜底 */
const FALLBACK_APP_CONFIG = {
  symbols: [
    { label: "BTC/USDT", value: "BINANCE:BTCUSDT" },
    { label: "ETH/USDT", value: "BINANCE:ETHUSDT" },
    { label: "SPY", value: "AMEX:SPY" },
    { label: "QQQ", value: "NASDAQ:QQQ" },
  ],
  defaultSymbol: "BINANCE:BTCUSDT",
  interval: "5",
  openaiBaseUrl: "https://api.openai.com/v1",
  openaiModel: "gpt-4o-mini",
  openaiApiKey: "",
};

/** 与配置 `interval` 一致，供 TradingView 与主进程路由共用 */
let chartInterval = "5";

/** 当前最近一次收盘推送 id，用于忽略过期的流式片段 */
let latestBarCloseId = null;

/** 右侧保留的「收盘 + LLM」轮数上限，避免 DOM 无限增长 */
const LLM_HISTORY_MAX_ROUNDS = 40;

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
 * 每根 K 线收盘且启用 LLM 时追加一轮（左用户摘要 / 右模型回复），流式时先占位「…」。
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
  if (thumbRow) {
    round.append(meta, thumbRow, rowUser, rowAsst);
  } else {
    round.append(meta, rowUser, rowAsst);
  }
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
      : config.symbols[0]?.value || "BINANCE:BTCUSDT";
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
    inValue.placeholder = "BINANCE:BTCUSDT";

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

function initConfigCenter() {
  const modal = document.getElementById("config-modal");
  const btnOpen = document.getElementById("btn-open-config");
  const btnClose = document.getElementById("btn-config-close");
  const btnCancel = document.getElementById("btn-config-cancel");
  const btnSave = document.getElementById("btn-config-save");
  const btnAdd = document.getElementById("btn-config-add");
  const pathEl = document.getElementById("config-file-path");

  if (!modal || !btnOpen || !btnSave) return;

  const closeModal = () => {
    modal.hidden = true;
  };

  const openModal = async () => {
    const cfg = await loadAppConfig();
    if (pathEl && window.argus && typeof window.argus.getConfigPath === "function") {
      try {
        const p = await window.argus.getConfigPath();
        pathEl.textContent = `保存路径（用户配置）：${p}`;
      } catch {
        pathEl.textContent = "";
      }
    }
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
    modal.hidden = false;
  };

  btnOpen.addEventListener("click", () => {
    openModal();
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
    inValue.placeholder = "BINANCE:BTCUSDT";
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

    if (!window.argus || typeof window.argus.saveConfig !== "function") {
      applySymbolSelect({ symbols, defaultSymbol });
      chartInterval = interval;
      createTradingViewWidget(defaultSymbol);
      closeModal();
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
      });
      applySymbolSelect(saved);
      chartInterval = saved.interval || interval;
      createTradingViewWidget(saved.defaultSymbol);
      closeModal();
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
    symbol: symbol || "BINANCE:BTCUSDT",
    interval: iv,
    timezone: "Asia/Shanghai",
    theme: "dark",
    style: "1",
    locale: "zh_CN",
    toolbar_bg: "#161b22",
    enable_publishing: false,
    hide_top_toolbar: false,
    hide_side_toolbar: true,
    hide_legend: false,
    hide_volume: false,
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

function setLlmStatus(text) {
  const el = document.getElementById("llm-status");
  if (el) el.textContent = text;
}

/**
 * @param {{ estimatedPromptTokens?: number, contextWindowTokens?: number, percent?: number } | null | undefined} usage
 */
function updateContextUsage(usage) {
  const el = document.getElementById("llm-context-usage");
  if (!el) return;
  el.classList.remove("panel-badge--usage-warn", "panel-badge--usage-danger");
  if (!usage || typeof usage.percent !== "number" || typeof usage.estimatedPromptTokens !== "number") {
    el.textContent = "上下文 —";
    el.title =
      "启用 LLM 后，每次收盘请求会显示估算输入占比。默认按 200K 上下文窗口；可用环境变量 ARGUS_CONTEXT_WINDOW_TOKENS 覆盖。含图时为粗估。";
    return;
  }
  const pct = usage.percent;
  const est = usage.estimatedPromptTokens;
  const cap = usage.contextWindowTokens ?? 200_000;
  el.textContent = `上下文 ${pct}%`;
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
    const status = document.getElementById("llm-status");

    latestBarCloseId = payload?.barCloseId ?? null;
    window.argusLastBarClose = payload;
    if (payload?.chartImage?.dataUrl) {
      setLastChartScreenshot(payload.chartImage.dataUrl);
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
    if (status) {
      if (payload?.chartCaptureError) {
        status.textContent = "收盘（截图异常）";
      } else if (llm?.enabled && llm.streaming) {
        status.textContent = "LLM 输出中…";
      } else if (llm?.enabled && llm.analysisText) {
        status.textContent = "收盘 · LLM 已分析";
      } else if (llm?.enabled && llm.error) {
        status.textContent = "收盘 · LLM 失败";
      } else {
        status.textContent = "K 线收盘已采集";
      }
    }
  });
}

function bindLlmStream() {
  if (typeof window.argus === "undefined") return;
  const { onLlmStreamDelta, onLlmStreamEnd, onLlmStreamError } = window.argus;
  if (typeof onLlmStreamDelta === "function") {
    onLlmStreamDelta(({ barCloseId, full }) => {
      if (barCloseId !== latestBarCloseId) return;
      const bubbleAsst = findAssistantBubbleForBar(barCloseId);
      const status = document.getElementById("llm-status");
      if (bubbleAsst) {
        bubbleAsst.textContent = normalizeAssistantDisplayText(full);
        bubbleAsst.classList.remove("llm-bubble--error");
      }
      if (status) status.textContent = "LLM 输出中…";
      const history = document.getElementById("llm-chat-history");
      if (history) history.scrollTop = history.scrollHeight;
    });
  }
  if (typeof onLlmStreamEnd === "function") {
    onLlmStreamEnd(({ barCloseId, analysisText }) => {
      if (barCloseId !== latestBarCloseId) return;
      if (window.argusLastBarClose?.llm) {
        window.argusLastBarClose.llm.analysisText = analysisText;
        window.argusLastBarClose.llm.streaming = false;
        window.argusLastBarClose.llm.error = null;
      }
      const status = document.getElementById("llm-status");
      if (status) status.textContent = "收盘 · LLM 已分析";
    });
  }
  if (typeof onLlmStreamError === "function") {
    onLlmStreamError(({ barCloseId, message }) => {
      if (barCloseId !== latestBarCloseId) return;
      const bubbleAsst = findAssistantBubbleForBar(barCloseId);
      if (bubbleAsst) {
        bubbleAsst.textContent = message || "错误";
        bubbleAsst.classList.add("llm-bubble--error");
      }
      if (window.argusLastBarClose?.llm) {
        window.argusLastBarClose.llm.error = message;
        window.argusLastBarClose.llm.streaming = false;
        window.argusLastBarClose.llm.analysisText = null;
      }
      const status = document.getElementById("llm-status");
      if (status) status.textContent = "收盘 · LLM 失败";
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
  const sym = cfg.defaultSymbol || cfg.symbols[0]?.value || "BINANCE:BTCUSDT";
  createTradingViewWidget(sym, chartInterval);
  if (window.argus && typeof window.argus.setMarketContext === "function") {
    window.argus.setMarketContext(sym);
  }
  initSymbolSelect();
  initChartCaptureBridge();
  initConfigCenter();
  initLlmChartPreview();
  bindMarketBarClose();
  bindLlmStream();
  bindMarketStatus();
});
