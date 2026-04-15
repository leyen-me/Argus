/**
 * K 线收盘后：请求渲染进程截取左侧 TradingView，与行情数据组装为统一 payload（供后续多模态 LLM）。
 */
const crypto = require("crypto");
const { ipcMain } = require("electron");
const { loadAppConfig } = require("./app-config");
const { conversationKey, getHistoryMessages, appendSuccessfulTurn } = require("./llm-context");
const {
  isLlmEnabled,
  buildUserPrompt,
  streamOpenAIChat,
  buildMultimodalUserContent,
  buildUserTextForHistory,
  SYSTEM_PROMPT,
} = require("./llm");

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

  const cfg = loadAppConfig();
  const textForLlm = buildUserPrompt(ctx.tvSymbol, ctx.periodLabel, ctx.candle);
  const barCloseId = crypto.randomUUID();

  /** @type {{ enabled: boolean, streaming?: boolean, analysisText: string | null, skippedReason: string | null, error: string | null }} */
  const llm = {
    enabled: isLlmEnabled(cfg),
    analysisText: null,
    skippedReason: null,
    error: null,
  };

  const convKey = conversationKey(ctx.tvSymbol, ctx.interval);

  const payloadBase = {
    kind: "bar_close",
    barCloseId,
    conversationKey: convKey,
    source: ctx.source,
    tvSymbol: ctx.tvSymbol,
    interval: ctx.interval,
    longPortSymbol: ctx.longPortSymbol ?? null,
    candle: ctx.candle,
    capturedAt: new Date().toISOString(),
    chartImage,
    chartCaptureError,
    textForLlm,
    llm,
  };

  if (!llm.enabled) {
    llm.skippedReason =
      "未调用 LLM：需设置 ARGUS_ENABLE_LLM=1，并在配置中心填写 API Key（或环境变量 OPENAI_API_KEY）。";
    win.webContents.send("market-bar-close", payloadBase);
    return;
  }

  llm.streaming = true;
  llm.analysisText = "";
  win.webContents.send("market-bar-close", payloadBase);

  const streamOpts = {
    appConfig: cfg,
    baseUrl: cfg.openaiBaseUrl,
    model: cfg.openaiModel,
  };

  const history = getHistoryMessages(convKey);
  const currentUserContent = buildMultimodalUserContent(
    textForLlm,
    chartImage?.base64 ?? null,
    chartImage?.mimeType || "image/png",
  );
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: currentUserContent },
  ];

  const result = await streamOpenAIChat(messages, streamOpts, (ev) => {
    if (ev.type === "delta") {
      win.webContents.send("llm-stream-delta", { barCloseId, full: ev.full });
    }
  });

  if (result.ok) {
    llm.analysisText = result.text;
    llm.streaming = false;
    appendSuccessfulTurn(
      convKey,
      buildUserTextForHistory(textForLlm, !!chartImage?.base64),
      result.text,
    );
    win.webContents.send("llm-stream-end", { barCloseId, analysisText: result.text });
  } else {
    llm.error = result.text;
    llm.streaming = false;
    win.webContents.send("llm-stream-error", { barCloseId, message: result.text });
  }
}

module.exports = { emitBarClose, requestChartCapture };
