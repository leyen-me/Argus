/**
 * K 线收盘后：请求渲染进程截取左侧 TradingView，与行情数据组装为统一 payload（供后续多模态 LLM）。
 */
const crypto = require("crypto");
const { ipcMain } = require("electron");
const { loadAppConfig } = require("./app-config");
const { conversationKey, getHistoryMessages, appendSuccessfulTurn } = require("./llm-context");
const { inferFeed } = require("./market");
const {
  isLlmEnabled,
  buildUserPrompt,
  streamOpenAIChat,
  buildMultimodalUserContent,
  buildUserTextForHistory,
  resolveSystemPrompt,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  estimatePromptTokensFromMessages,
  keepOnlyLastUserImageInMessages,
} = require("./llm");
const {
  getAllowedIntentsForState,
  syncTradingStateBeforeLlm,
  applyTradingDecision,
} = require("./trading-state");

function coerceFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function tryParseJsonObject(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* ignore */
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* ignore */
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* ignore */
    }
  }
  return null;
}

function mapLegacyActionToIntent(currentState, action, confidence) {
  const act = String(action || "").trim().toUpperCase();
  const conf = Number.isFinite(Number(confidence)) ? Number(confidence) : 0;
  switch (currentState) {
    case "IDLE":
      if (act === "LONG") return "LOOK_LONG";
      if (act === "SHORT") return "LOOK_SHORT";
      return "WAIT";
    case "LOOKING_LONG":
      if (act === "LONG") return "ENTER_LONG";
      return "CANCEL_LOOKING";
    case "LOOKING_SHORT":
      if (act === "SHORT") return "ENTER_SHORT";
      return "CANCEL_LOOKING";
    case "HOLDING_LONG":
      if (act === "SHORT" && conf >= 90) return "EXIT_LONG";
      return "HOLD";
    case "HOLDING_SHORT":
      if (act === "LONG" && conf >= 90) return "EXIT_SHORT";
      return "HOLD";
    case "COOLDOWN":
    default:
      return "WAIT";
  }
}

function parseTradingDecision(rawText, tradeState) {
  const parsed = tryParseJsonObject(rawText);
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "LLM 未返回可解析的 JSON，状态机未更新。" };
  }
  const currentState = String(tradeState?.state || "IDLE");
  let intent =
    typeof parsed.intent === "string" && parsed.intent.trim()
      ? parsed.intent.trim().toUpperCase()
      : "";
  if (!intent && typeof parsed.action === "string") {
    intent = mapLegacyActionToIntent(currentState, parsed.action, parsed.confidence);
  }
  if (!intent) {
    return { ok: false, error: "LLM JSON 缺少 intent/action 字段，状态机未更新。" };
  }
  return {
    ok: true,
    decision: {
      intent,
      confidence: coerceFiniteNumber(parsed.confidence) ?? 0,
      reasoning:
        typeof parsed.reasoning === "string"
          ? parsed.reasoning.trim()
          : typeof parsed.summary === "string"
            ? parsed.summary.trim()
            : "",
      keyLevel: coerceFiniteNumber(parsed.key_level ?? parsed.keyLevel),
      stopLoss: coerceFiniteNumber(
        parsed.stop_loss ?? parsed.stopLoss ?? parsed.stop_loss_suggestion,
      ),
      takeProfit: coerceFiniteNumber(
        parsed.take_profit ?? parsed.takeProfit ?? parsed.take_profit_suggestion,
      ),
      riskNote:
        typeof parsed.risk_note === "string"
          ? parsed.risk_note.trim()
          : typeof parsed.warning === "string"
            ? parsed.warning.trim()
            : "",
    },
  };
}

function buildStateAwareUserText(marketText, tradeState) {
  const snapshot = {
    current_state: tradeState?.state || "IDLE",
    pending_direction: tradeState?.pendingDirection ?? null,
    position_side: tradeState?.positionSide ?? null,
    key_level: tradeState?.keyLevel ?? null,
    entry_price: tradeState?.entryPrice ?? null,
    stop_loss: tradeState?.stopLoss ?? null,
    take_profit: tradeState?.takeProfit ?? null,
    cooldown_until:
      tradeState?.cooldownUntil && tradeState.cooldownUntil > 0
        ? new Date(tradeState.cooldownUntil).toISOString()
        : null,
    allowed_intents: getAllowedIntentsForState(tradeState?.state || "IDLE"),
  };
  return [
    marketText,
    "",
    "交易状态机上下文（由系统维护，必须严格遵守）：",
    JSON.stringify(snapshot, null, 2),
    "",
    "补充规则：",
    "1. 只能从 allowed_intents 中选择一个 intent。",
    "2. 若当前为 LOOKING_*，只有确认条件成立才输出 ENTER_*；否则输出 CANCEL_LOOKING 或 WAIT。",
    "3. 若当前为 HOLDING_*，禁止重复开仓，只能 HOLD 或 EXIT_*。",
    "4. 仅返回严格 JSON，不要输出 Markdown 代码块或额外解释。",
  ].join("\n");
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
  const stateSync = syncTradingStateBeforeLlm(convKey, ctx.candle);

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
    tradeState: stateSync.tradeState,
    tradeStateEvent: stateSync.hardExit,
    llm,
  };

  if (!llm.enabled) {
    llm.skippedReason =
      "未调用 LLM：需设置 ARGUS_ENABLE_LLM=1，并在配置中心填写 API Key（或环境变量 OPENAI_API_KEY）。";
    win.webContents.send("market-bar-close", payloadBase);
    return;
  }

  if (stateSync.skipLlm) {
    llm.skippedReason = `未调用 LLM：${stateSync.skipReason}`;
    win.webContents.send("market-bar-close", payloadBase);
    return;
  }

  const symEntry = cfg.symbols.find((s) => s.value === ctx.tvSymbol);
  const feed = inferFeed(ctx.tvSymbol, symEntry?.feed);
  const systemPrompt = resolveSystemPrompt(cfg, feed);
  const history = getHistoryMessages(convKey);
  const llmUserText = buildStateAwareUserText(textForLlm, stateSync.tradeState);
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

  const result = await streamOpenAIChat(messages, streamOpts, (ev) => {
    if (ev.type === "delta") {
      win.webContents.send("llm-stream-delta", {
        barCloseId,
        full: ev.full,
        reasoningFull: ev.reasoningFull ?? "",
      });
    }
  });

  if (result.ok) {
    llm.analysisText = result.text;
    llm.reasoningText = result.reasoningText ?? "";
    llm.streaming = false;
    const parsedDecision = parseTradingDecision(result.text, stateSync.tradeState);
    if (parsedDecision.ok) {
      const stateResult = applyTradingDecision(convKey, ctx.candle, parsedDecision.decision);
      payloadBase.tradeState = stateResult.tradeState;
      if (!stateResult.applied && stateResult.ignoredReason) {
        llm.skippedReason = `状态机未转移：${stateResult.ignoredReason}`;
      }
    } else {
      llm.skippedReason = parsedDecision.error;
    }
    appendSuccessfulTurn(
      convKey,
      buildUserTextForHistory(textForLlm, !!chartImage?.base64),
      result.text,
    );
    win.webContents.send("llm-stream-end", {
      barCloseId,
      analysisText: result.text,
      reasoningText: result.reasoningText ?? "",
    });
  } else {
    llm.error = result.text;
    llm.streaming = false;
    win.webContents.send("llm-stream-error", { barCloseId, message: result.text });
  }
}

module.exports = { emitBarClose, requestChartCapture };
