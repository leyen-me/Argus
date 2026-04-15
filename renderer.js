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

/** 与仓库 config.json 一致，供非 Electron 打开页面时兜底 */
const FALLBACK_APP_CONFIG = {
  symbols: [
    { label: "BTC/USDT", value: "BINANCE:BTCUSDT" },
    { label: "ETH/USDT", value: "BINANCE:ETHUSDT" },
    { label: "SPY", value: "AMEX:SPY" },
    { label: "QQQ", value: "NASDAQ:QQQ" },
  ],
  defaultSymbol: "BINANCE:BTCUSDT",
};

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
    if (!window.argus || typeof window.argus.saveConfig !== "function") {
      applySymbolSelect({ symbols, defaultSymbol });
      createTradingViewWidget(defaultSymbol);
      closeModal();
      return;
    }
    try {
      const saved = await window.argus.saveConfig({ symbols, defaultSymbol });
      applySymbolSelect(saved);
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

function createTradingViewWidget(symbol) {
  destroyWidget();

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
    interval: "5",
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
  });
}

function showDemoAnalysis() {
  const placeholder = document.getElementById("llm-placeholder");
  const output = document.getElementById("llm-output");
  const status = document.getElementById("llm-status");
  if (!placeholder || !output || !status) return;

  const demo =
    "【示例】多模态融合分析占位\n\n" +
    "· 趋势：待接入实时推理\n" +
    "· 风险：待接入订单流 / 情绪等信号\n\n" +
    "接入模型后，可将结构化 JSON 或 Markdown 渲染到右侧面板。";

  placeholder.hidden = true;
  output.hidden = false;
  output.textContent = demo;
  status.textContent = "演示";
}

function setLlmStatus(text) {
  const el = document.getElementById("llm-status");
  if (el) el.textContent = text;
}

function initChartCapture() {
  const btn = document.getElementById("btn-capture-chart");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const widget = tvWidget;
    const imgEl = document.getElementById("chart-screenshot-img");
    const wrap = document.getElementById("chart-capture-wrap");
    if (!widget || typeof widget.ready !== "function") {
      setLlmStatus("无图表");
      return;
    }
    if (typeof widget.imageCanvas !== "function") {
      setLlmStatus("不支持截图");
      return;
    }

    btn.disabled = true;
    setLlmStatus("截图中…");

    try {
      const canvas = await new Promise((resolve, reject) => {
        widget.ready(() => {
          widget.imageCanvas().then(resolve).catch(reject);
        });
      });
      const dataUrl = canvas.toDataURL("image/png");
      setLastChartScreenshot(dataUrl);
      if (imgEl) imgEl.src = dataUrl;
      if (wrap) wrap.hidden = false;
      setLlmStatus("已截图");
    } catch (err) {
      console.error(err);
      setLlmStatus("截图失败");
    } finally {
      btn.disabled = false;
    }
  });
}

function bindArgusBridge() {
  if (typeof window.argus === "undefined" || !window.argus.onAnalysisUpdate) {
    return;
  }
  window.argus.onAnalysisUpdate((payload) => {
    const placeholder = document.getElementById("llm-placeholder");
    const output = document.getElementById("llm-output");
    const status = document.getElementById("llm-status");
    if (placeholder) placeholder.hidden = true;
    if (output) {
      output.hidden = false;
      output.textContent =
        typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    }
    if (status) status.textContent = "已更新";
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  const cfg = await loadAppConfig();
  applySymbolSelect(cfg);
  createTradingViewWidget(cfg.defaultSymbol || cfg.symbols[0]?.value || "BINANCE:BTCUSDT");
  initSymbolSelect();
  initChartCapture();
  initConfigCenter();
  bindArgusBridge();
  showDemoAnalysis();
});
