/**
 * K 线收盘后：请求渲染进程截取左侧 TradingView，与行情数据组装为统一 payload（供后续多模态 LLM）。
 */
const crypto = require("crypto");
const { ipcMain } = require("electron");
const { isLlmEnabled, buildUserPrompt } = require("./llm");

/**
 * @param {import("electron").WebContents} webContents
 * @param {number} [timeoutMs]
 * @returns {Promise<{ mimeType: string, base64: string, dataUrl: string }>}
 */
function requestChartCapture(webContents, timeoutMs = 18000) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener("chart-capture-result", handler);
      reject(new Error("截图超时"));
    }, timeoutMs);

    function handler(_event, result) {
      if (!result || result.requestId !== requestId) return;
      clearTimeout(timer);
      ipcMain.removeListener("chart-capture-result", handler);
      if (result.ok) {
        resolve({
          mimeType: result.mimeType || "image/png",
          base64: result.base64,
          dataUrl: result.dataUrl,
        });
      } else {
        reject(new Error(result.error || "截图失败"));
      }
    }

    ipcMain.on("chart-capture-result", handler);
    webContents.send("request-chart-capture", { requestId });
  });
}

/**
 * @param {() => import("electron").BrowserWindow | null} winGetter
 * @param {{
 *   source: "longbridge" | "binance_ws",
 *   tvSymbol: string,
 *   interval: string,
 *   periodLabel: string,
 *   candle: object,
 *   longPortSymbol?: string | null,
 * }} ctx
 */
async function emitBarClose(winGetter, ctx) {
  const win = typeof winGetter === "function" ? winGetter() : null;
  if (!win || win.isDestroyed()) return;

  let chartImage = null;
  let chartCaptureError = null;
  try {
    chartImage = await requestChartCapture(win.webContents);
  } catch (e) {
    chartCaptureError = e.message || String(e);
  }

  const textForLlm = buildUserPrompt(ctx.tvSymbol, ctx.periodLabel, ctx.candle);

  const payload = {
    kind: "bar_close",
    source: ctx.source,
    tvSymbol: ctx.tvSymbol,
    interval: ctx.interval,
    longPortSymbol: ctx.longPortSymbol ?? null,
    candle: ctx.candle,
    capturedAt: new Date().toISOString(),
    chartImage,
    chartCaptureError,
    textForLlm,
    llm: {
      enabled: isLlmEnabled(),
      analysisText: null,
      skippedReason: isLlmEnabled()
        ? null
        : "未调用 LLM：需同时设置 ARGUS_ENABLE_LLM=1 与 OPENAI_API_KEY（当前仅收集数据与截图）。",
    },
  };

  if (isLlmEnabled()) {
    // 后续在此接入多模态：textForLlm + chartImage.base64
  }

  win.webContents.send("market-bar-close", payload);
}

module.exports = { emitBarClose, requestChartCapture };
