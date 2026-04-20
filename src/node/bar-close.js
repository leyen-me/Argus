/**
 * K 线收盘后：请求渲染进程截取左侧 TradingView，与行情数据组装为统一 payload（供后续多模态 LLM + OKX Agent）。
 */
const crypto = require("crypto");
const { ipcMain } = require("electron");
const { loadAppConfig } = require("./app-config");
const { conversationKey, getHistoryMessages, appendSuccessfulTurn } = require("./llm-context");
const {
  isLlmEnabled,
  buildUserPrompt,
  runTradingAgentTurn,
  buildMultimodalUserContent,
  buildUserTextForHistory,
  resolveSystemPrompt,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  estimatePromptTokensFromMessages,
  keepOnlyLastUserImageInMessages,
} = require("./llm");
const { getOkxExchangeContextForBar } = require("./okx-perp");
const { TRADING_AGENT_TOOLS } = require("./trading-agent-tools");
const { createTradingToolExecutor } = require("./trading-agent-executor");

function buildOkxContextUserText(marketText, exchangeCtx) {
  let exchangeBlock;
  if (exchangeCtx && exchangeCtx.enabled && exchangeCtx.ok) {
    exchangeBlock = {
      instId: exchangeCtx.instId,
      simulated: exchangeCtx.simulated,
      position: exchangeCtx.position,
      pending_orders: exchangeCtx.pending_orders,
    };
  } else if (exchangeCtx && exchangeCtx.enabled && !exchangeCtx.ok) {
    exchangeBlock = { error: exchangeCtx.message || "交易所快照失败" };
  } else {
    exchangeBlock = {
      note: exchangeCtx?.reason || "OKX 永续未启用或未配置 API。",
    };
  }
  return [
    marketText,
    "",
    "OKX 永续快照（持仓 + 未成交挂单；请用工具下单，勿只写评论）：",
    JSON.stringify(exchangeBlock, null, 2),
  ].join("\n");
}

function formatAgentToolTrace(trace) {
  if (!Array.isArray(trace) || !trace.length) return "";
  const lines = trace.map((t) => {
    const r = t.result && typeof t.result === "object" ? t.result : {};
    const ok = r.ok === true ? "ok" : "fail";
    return `• ${t.name} (${ok}) ${JSON.stringify(r)}`;
  });
  return `\n\n---\n工具轨迹：\n${lines.join("\n")}`;
}

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
 *   source: "okx_ws",
 *   tvSymbol: string,
 *   interval: string,
 *   periodLabel: string,
 *   candle: object,
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

  /** @type {{ enabled: boolean, streaming?: boolean, reasoningEnabled?: boolean, reasoningText?: string | null, analysisText: string | null, skippedReason: string | null, error: string | null }} */
  const llm = {
    enabled: isLlmEnabled(cfg),
    reasoningEnabled: cfg.llmReasoningEnabled === true,
    reasoningText: null,
    analysisText: null,
    skippedReason: null,
    error: null,
  };

  const convKey = conversationKey(ctx.tvSymbol, ctx.interval);
  const exchangeCtx = await getOkxExchangeContextForBar(cfg, ctx.tvSymbol);

  const payloadBase = {
    kind: "bar_close",
    barCloseId,
    conversationKey: convKey,
    source: ctx.source,
    tvSymbol: ctx.tvSymbol,
    interval: ctx.interval,
    candle: ctx.candle,
    capturedAt: new Date().toISOString(),
    chartImage,
    chartCaptureError,
    textForLlm,
    exchangeContext: exchangeCtx,
    llm,
  };

  if (!llm.enabled) {
    llm.skippedReason =
      "未调用 LLM：请在配置中心填写 API Key（或环境变量 OPENAI_API_KEY）。";
    win.webContents.send("market-bar-close", payloadBase);
    return;
  }

  const systemPrompt = resolveSystemPrompt(cfg);
  const history = getHistoryMessages(convKey);
  const llmUserText = buildOkxContextUserText(textForLlm, exchangeCtx);
  const currentUserContent = buildMultimodalUserContent(
    llmUserText,
    chartImage?.base64 ?? null,
    chartImage?.mimeType || "image/png",
  );
  const messages = keepOnlyLastUserImageInMessages([
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: currentUserContent },
  ]);

  const envCtx = process.env.ARGUS_CONTEXT_WINDOW_TOKENS;
  const contextWindowTokens =
    envCtx && Number(envCtx) > 0 ? Math.floor(Number(envCtx)) : DEFAULT_CONTEXT_WINDOW_TOKENS;
  const estimatedPromptTokens = estimatePromptTokensFromMessages(messages);
  const percent = Math.round((estimatedPromptTokens / contextWindowTokens) * 1000) / 10;
  payloadBase.usage = {
    estimatedPromptTokens,
    contextWindowTokens,
    percent,
  };

  llm.streaming = true;
  llm.analysisText = "";
  win.webContents.send("market-bar-close", payloadBase);

  const streamOpts = {
    appConfig: cfg,
    baseUrl: cfg.openaiBaseUrl,
    model: cfg.openaiModel,
  };

  const executeTool = createTradingToolExecutor({
    cfg,
    tvSymbol: ctx.tvSymbol,
    barCloseId,
    win,
  });

  let streamAcc = "";
  const agentResult = await runTradingAgentTurn(messages, streamOpts, {
    tools: TRADING_AGENT_TOOLS,
    executeTool,
    maxSteps: 8,
    onStep: ({ toolCalls, assistantPreview }) => {
      let add = "";
      if (assistantPreview) add += `${assistantPreview}\n\n`;
      if (toolCalls?.length) {
        add += `${toolCalls.map((t) => `[调用 ${t.function?.name}]`).join(" ")}\n`;
      }
      if (add) {
        streamAcc += add;
        win.webContents.send("llm-stream-delta", {
          barCloseId,
          full: streamAcc.trim(),
          reasoningFull: "",
        });
      }
    },
  });

  if (agentResult.ok) {
    const traceStr = formatAgentToolTrace(agentResult.toolTrace);
    llm.analysisText = [agentResult.text, traceStr].filter(Boolean).join("");
    llm.reasoningText = "";
    llm.streaming = false;
    const exchangeAfter = await getOkxExchangeContextForBar(cfg, ctx.tvSymbol);
    payloadBase.exchangeContext = exchangeAfter;
    appendSuccessfulTurn(
      convKey,
      buildUserTextForHistory(textForLlm, !!chartImage?.base64),
      llm.analysisText,
    );
    win.webContents.send("llm-stream-end", {
      barCloseId,
      conversationKey: convKey,
      exchangeContext: exchangeAfter,
      analysisText: llm.analysisText,
      reasoningText: "",
    });
  } else {
    llm.error = agentResult.text;
    llm.streaming = false;
    win.webContents.send("llm-stream-error", { barCloseId, message: agentResult.text });
  }
}

module.exports = { emitBarClose, requestChartCapture };
