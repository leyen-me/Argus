/**
 * K 线收盘后：请求渲染进程截取左侧 TradingView，与行情数据组装为统一 payload（供后续多模态 LLM + OKX Agent）。
 */
const crypto = require("crypto");
const { ipcMain } = require("electron");
const { loadAppConfig } = require("./app-config");
const { conversationKey } = require("./llm-context");
const {
  isLlmEnabled,
  buildUserPrompt,
  runTradingAgentTurn,
  buildMultimodalUserContent,
  resolveSystemPrompt,
  mdCell,
  mdTable,
} = require("./llm");
const {
  getOkxExchangeContextForBar,
  isOkxExchangeContextReadyForBarAgent,
  describeOkxExchangeContextGateFailure,
  fetchRecentCandlesForTv,
} = require("./okx-perp");
const { TRADING_AGENT_TOOLS } = require("./trading-agent-tools");
const { createTradingToolExecutor } = require("./trading-agent-executor");
const { persistAgentBarTurn } = require("./agent-bar-turns-store");

/** @param {boolean | null | undefined} b */
function zhBool(b) {
  if (b === true) return "是";
  if (b === false) return "否";
  return "—";
}

const MD_PENDING_ORDER_HEADERS = [
  "ordId",
  "side",
  "posSide",
  "ordType",
  "state",
  "px",
  "sz",
  "accFillSz",
  "reduceOnly",
  "lever",
  "tdMode",
];

const MD_ALGO_ORDER_HEADERS = [
  "algoId",
  "ordType",
  "side",
  "posSide",
  "state",
  "sz",
  "tpTriggerPx",
  "slTriggerPx",
  "triggerPx",
  "tpTriggerPxType",
  "slTriggerPxType",
  "ordPx",
];

/**
 * @param {Record<string, unknown>} o
 * @param {string[]} keys
 */
function pickRow(o, keys) {
  return keys.map((k) => o[k]);
}

/**
 * @param {object | null | undefined} fields
 */
function positionFieldsTable(fields) {
  if (!fields || typeof fields !== "object") return "（无 OKX 原始仓位字段）";
  const entries = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return "（无 OKX 原始仓位字段）";
  return mdTable(
    ["字段", "值"],
    entries.map(([k, v]) => [k, v]),
  );
}

function buildOkxContextUserText(marketText, exchangeCtx) {
  const snapshotIntro =
    "> **说明**：以下为 OKX 永续账户、持仓与挂单快照。**若要开仓、平仓或改单，请调用工具执行**（例如先用 `preview_open_size` 试算张数，再使用下单/平仓/撤单等工具）。**不要只在回复里写交易建议而不调用工具。**";

  if (!exchangeCtx || exchangeCtx.enabled !== true) {
    let note;
    if (exchangeCtx?.reason === "okx_swap_disabled") {
      note = "（未启用 OKX 永续或未配置 API — 无交易所数据。）";
    } else if (exchangeCtx?.reason === "not_crypto_chart") {
      note = "（当前图表非 OKX 加密永续 — 无交易所数据。）";
    } else {
      note = `（无快照：${exchangeCtx?.reason || "OKX 永续未启用或未配置 API"}。）`;
    }
    return [marketText, "", "## OKX 永续快照", "", snapshotIntro, note].join("\n");
  }

  if (exchangeCtx.ok !== true) {
    const err = mdCell(exchangeCtx.message || "交易所快照失败");
    return [marketText, "", "## OKX 永续快照", "", snapshotIntro, `**接口错误**：${err}`].join("\n");
  }

  const cs = exchangeCtx.contract_sizing;
  const sim = exchangeCtx.simulated !== false;
  const accountBlock = mdTable(
    ["USDT 可用权益", "ct_val", "lot_sz", "min_sz", "tick_sz", "last_px"],
    [
      [
        exchangeCtx.usdt_avail_eq,
        cs?.ct_val,
        cs?.lot_sz,
        cs?.min_sz,
        cs?.tick_sz,
        cs?.last_px,
      ],
    ],
  );

  const sizingExamples = Array.isArray(exchangeCtx.sizing_examples) ? exchangeCtx.sizing_examples : [];
  const sizingBlock =
    sizingExamples.length > 0
      ? mdTable(
          ["保证金占用比例", "杠杆", "预估张数", "满足最小张数"],
          sizingExamples.map((r) => [
            r.margin_fraction,
            r.leverage,
            r.estimated_contracts,
            zhBool(r.meets_min_sz),
          ]),
        )
      : "（本轮无开仓张数参考行。）";

  const pos = exchangeCtx.position;
  const posSummary = mdTable(
    ["有持仓", "posSide", "posNum", "absContracts"],
    [
      [
        zhBool(pos?.hasPosition === true),
        pos?.posSide,
        pos?.posNum,
        pos?.absContracts,
      ],
    ],
  );
  const posFieldsSection = ["#### 仓位明细（OKX 字段）", "", positionFieldsTable(pos?.fields)].join("\n");

  const pending = Array.isArray(exchangeCtx.pending_orders) ? exchangeCtx.pending_orders : [];
  const pendingBlock =
    pending.length > 0
      ? mdTable(
          MD_PENDING_ORDER_HEADERS,
          pending.map((o) => pickRow(o, MD_PENDING_ORDER_HEADERS)),
        )
      : "（当前无普通挂单。）";

  const algos = Array.isArray(exchangeCtx.pending_algo_orders) ? exchangeCtx.pending_algo_orders : [];
  const algoBlock =
    algos.length > 0
      ? mdTable(
          MD_ALGO_ORDER_HEADERS,
          algos.map((o) => pickRow(o, MD_ALGO_ORDER_HEADERS)),
        )
      : "（当前无算法挂单。）";

  const contractBlock = mdTable(
    ["项目", "值"],
    [
      ["instId", exchangeCtx.instId],
      ["模拟盘", sim ? "是" : "否"],
    ],
  );

  return [
    marketText,
    "",
    "## OKX 永续快照",
    "",
    snapshotIntro,
    "### 合约",
    "",
    contractBlock,
    "",
    "### 账户与合约规格",
    "",
    accountBlock,
    "",
    "### 开仓张数参考",
    "",
    String(exchangeCtx.sizing_note || "").trim() || "—",
    "",
    sizingBlock,
    "",
    "### 持仓",
    "",
    posSummary,
    "",
    posFieldsSection,
    "",
    "### 普通挂单",
    "",
    pendingBlock,
    "",
    "### 算法挂单（条件单等）",
    "",
    algoBlock,
  ].join("\n");
}

function formatToolCallPreview(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "";
  return toolCalls
    .map((t) => {
      const name = t?.function?.name ? String(t.function.name) : "unknown_tool";
      return `调用 ${name}`;
    })
    .join("\n");
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
  const [exchangeCtx, recentCandles] = await Promise.all([
    getOkxExchangeContextForBar(cfg, ctx.tvSymbol),
    fetchRecentCandlesForTv(ctx.tvSymbol, ctx.interval, 30),
  ]);
  const textForLlm = buildUserPrompt(ctx.tvSymbol, ctx.periodLabel, ctx.candle, recentCandles);
  const llmUserText = buildOkxContextUserText(textForLlm, exchangeCtx);

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
    fullUserPromptForDisplay: llmUserText,
    llm,
  };
  llm.toolTrace = [];

  const finishSkipped = (reason) => {
    llm.skippedReason = reason;
    llm.analysisText = null;
    llm.streaming = false;
    llm.error = null;
    win.webContents.send("market-bar-close", payloadBase);
  };

  if (!llm.enabled) {
    llm.skippedReason =
      "未调用 LLM：请在配置中心填写 API Key（或环境变量 OPENAI_API_KEY）。";
    win.webContents.send("market-bar-close", payloadBase);
    return;
  }

  if (chartCaptureError || !chartImage?.base64) {
    finishSkipped(
      chartCaptureError
        ? `未调用 LLM：图表截图失败（${chartCaptureError}）。`
        : "未调用 LLM：图表截图不可用。",
    );
    return;
  }

  if (!isOkxExchangeContextReadyForBarAgent(exchangeCtx)) {
    finishSkipped(describeOkxExchangeContextGateFailure(exchangeCtx));
    return;
  }

  if (cfg.barCloseAgentAutoEnabled === false) {
    finishSkipped("未调用 LLM：右侧面板已关闭「K 线收盘自动 Agent」。");
    return;
  }

  const systemPrompt = resolveSystemPrompt(cfg);
  const currentUserContent = buildMultimodalUserContent(
    llmUserText,
    chartImage.base64,
    chartImage.mimeType || "image/png",
  );
  /** 每根 K 线独立单轮：不传历史 messages，仅 system + 本轮 user（含完整 OKX 快照与图）。 */
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: currentUserContent },
  ];

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
  let streamToolAcc = "";
  const agentResult = await runTradingAgentTurn(messages, streamOpts, {
    tools: TRADING_AGENT_TOOLS,
    executeTool,
    maxSteps: 8,
    onStep: ({ toolCalls, assistantPreview }) => {
      let changed = false;
      if (assistantPreview) {
        streamAcc = [streamAcc, assistantPreview].filter(Boolean).join("\n\n").trim();
        changed = true;
      }
      const toolPreview = formatToolCallPreview(toolCalls);
      if (toolPreview) {
        streamToolAcc = [streamToolAcc, toolPreview].filter(Boolean).join("\n");
        changed = true;
      }
      if (changed) {
        win.webContents.send("llm-stream-delta", {
          barCloseId,
          full: streamAcc,
          reasoningFull: "",
          toolFull: streamToolAcc,
        });
      }
    },
  });

  if (agentResult.ok) {
    llm.analysisText = agentResult.text;
    llm.toolTrace = Array.isArray(agentResult.toolTrace) ? agentResult.toolTrace : [];
    llm.reasoningText = "";
    llm.streaming = false;
    const exchangeAfter = await getOkxExchangeContextForBar(cfg, ctx.tvSymbol);
    payloadBase.exchangeContext = exchangeAfter;
    try {
      persistAgentBarTurn({
        barCloseId,
        tvSymbol: ctx.tvSymbol,
        interval: ctx.interval,
        periodLabel: ctx.periodLabel,
        capturedAt: payloadBase.capturedAt,
        textForLlm,
        llmUserFullText: llmUserText,
        exchangeContext: exchangeCtx,
        chartMime: chartImage?.mimeType ?? null,
        chartBase64: chartImage?.base64 ?? null,
        chartCaptureError,
        assistantText: agentResult.text,
        toolTrace: llm.toolTrace,
        exchangeAfter,
        agentOk: true,
        systemPrompt,
        messagesOut: agentResult.messagesOut,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (win && !win.isDestroyed()) {
        win.webContents.send("market-status", { text: `Agent 记录落库失败：${msg}` });
      }
    }
    win.webContents.send("llm-stream-end", {
      barCloseId,
      conversationKey: convKey,
      exchangeContext: exchangeAfter,
      analysisText: llm.analysisText,
      reasoningText: "",
      toolTrace: llm.toolTrace,
    });
  } else {
    llm.error = agentResult.text;
    llm.toolTrace = Array.isArray(agentResult.toolTrace) ? agentResult.toolTrace : [];
    llm.streaming = false;
    try {
      persistAgentBarTurn({
        barCloseId,
        tvSymbol: ctx.tvSymbol,
        interval: ctx.interval,
        periodLabel: ctx.periodLabel,
        capturedAt: payloadBase.capturedAt,
        textForLlm,
        llmUserFullText: llmUserText,
        exchangeContext: exchangeCtx,
        chartMime: chartImage?.mimeType ?? null,
        chartBase64: chartImage?.base64 ?? null,
        chartCaptureError,
        assistantText: null,
        toolTrace: llm.toolTrace,
        exchangeAfter: null,
        agentOk: false,
        agentError: agentResult.text,
        systemPrompt,
        messagesOut: agentResult.messagesOut,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (win && !win.isDestroyed()) {
        win.webContents.send("market-status", { text: `Agent 记录落库失败：${msg}` });
      }
    }
    win.webContents.send("llm-stream-error", {
      barCloseId,
      message: agentResult.text,
      toolTrace: llm.toolTrace,
    });
  }
}

module.exports = { emitBarClose, requestChartCapture };
