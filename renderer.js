/* global TradingView */

const chartContainerId = "tradingview_chart";
/** TradingView 内置：MAExp = EMA，周期由 length 指定 */
const DEFAULT_EMA_LENGTH = 20;
let tvWidget = null;

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
    hide_legend: false,
    save_image: false,
    container_id: chartContainerId,
    hide_side_toolbar: false,
    allow_symbol_change: true,
    hideideas: true,
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

window.addEventListener("DOMContentLoaded", () => {
  const sel = document.getElementById("symbol-select");
  const initial = sel ? sel.value : "BINANCE:BTCUSDT";
  createTradingViewWidget(initial);
  initSymbolSelect();
  bindArgusBridge();
  showDemoAnalysis();
});
