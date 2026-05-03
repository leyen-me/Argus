// @ts-nocheck — K 线收盘链路与捕获包形状复杂，与历史 CJS 脚本同级宽松校验。
/**
 * K 线收盘后：请求渲染进程截取左侧 TradingView，与行情数据组装为统一 payload（供后续多模态 LLM + OKX Agent）。
 */
import crypto from "node:crypto";
import { publish } from "./runtime-bus.js";
import { requestChartCaptureFromBrowser } from "./chart-capture-browser-bridge.js";
import { loadAppConfig } from "./app-config.js";
import { conversationKey } from "./llm-context.js";
import {
  isLlmEnabled,
  buildMultiTimeframeUserPrompt,
  runTradingAgentTurn,
  buildMultimodalUserContent,
  resolveSystemPrompt,
  resolveTradingAgentSystemPrompt,
  RECENT_CANDLES_FETCH_LIMIT,
  mdCell,
  mdTable,
  summarizeAgentAnalysisForCard,
} from "./llm.js";
import {
  getOkxExchangeContextForBar,
  isOkxExchangeContextReadyForBarAgent,
  describeOkxExchangeContextGateFailure,
  fetchRecentCandlesForTv,
  fetchRecentSwapPositionsHistoryForBar,
} from "./okx-perp.js";
import { buildTradingAgentToolsForContext } from "./trading-agent-tools.js";
import { createTradingToolExecutor } from "./trading-agent-executor.js";
import { persistAgentBarTurn, listRecentAgentMemories } from "./agent-bar-turns-store.js";

const AGENT_DECISION_INTERVAL = "5";
const MULTI_TIMEFRAME_CAPTURE_SPECS = [
  { interval: "1D", label: "1D" },
  { interval: "60", label: "1H" },
  { interval: "15", label: "15m" },
  { interval: "5", label: "5m" },
] as const;

type MultiTimeframeChartImage = {
  interval: string;
  label: string;
  mimeType: string;
  base64: string;
  dataUrl: string;
};

type PrimaryChartImage = { mimeType: string; base64: string; dataUrl: string };

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

const OKX_POSITION_HISTORY_LLM_HEADERS = [
  "标的",
  "方向",
  "全仓/逐仓",
  "杠杆",
  "开仓均价",
  "已实现收益",
  "最大持仓",
  "平仓均价",
  "实现收益率",
  "已平量",
  "开仓时间",
  "平仓时间",
];

/**
 * @param {string | null | undefined} m
 */
function okxMgnModeZh(m) {
  if (m === "cross") return "全仓";
  if (m === "isolated") return "逐仓";
  if (m == null || m === "") return "—";
  return String(m);
}

/**
 * @param {string | number | null | undefined} ms
 */
function okxPosHistTimeIso(ms) {
  if (ms == null || ms === "") return "—";
  const n = Number(ms);
  if (!Number.isFinite(n)) return String(ms);
  return new Date(n).toISOString();
}

/**
 * @param {string | number | null | undefined} ratio
 */
function okxPnlRatioDisplay(ratio) {
  if (ratio == null || ratio === "") return "—";
  const x = Number(ratio);
  if (!Number.isFinite(x)) return String(ratio);
  return `${(x * 100).toFixed(4)}%`;
}

/**
 * 将 `fetchRecentSwapPositionsHistoryForBar` 的返回格式化为可注入 user 的 Markdown；未启用/跳过/非本轮标的时传 `null`。
 * @param {Awaited<ReturnType<typeof fetchRecentSwapPositionsHistoryForBar>> | null} ph
 */
function formatOkxPositionHistoryForPrompt(ph) {
  if (!ph || ph.skipped) return "";
  if (!ph.ok) {
    return [
      "",
      "### 最近仓位历史",
      "",
      `> **说明**：数据来自 OKX \`GET /api/v5/account/positions-history\`（**非**当前「持仓」页统计，仅作近期盈亏参考）`,
      "",
      `（拉取失败：${mdCell(ph.message)}。）`,
    ].join("\n");
  }
  if (!ph.rows || ph.rows.length === 0) {
    return [
      "",
      "### 最近仓位历史",
      "",
      "> **说明**：数据来自 OKX `positions-history`；若为空，可能近约 3 个月该 `instId` 无记录。",
      "",
      "（无历史仓位行。）",
    ].join("\n");
  }
  const tableRows = ph.rows.map((r) => {
    if (!r || typeof r !== "object") {
      return ["—", "—", "—", "—", "—", "—", "—", "—", "—", "—", "—", "—"];
    }
    const o = /** @type {Record<string, unknown>} */ (r);
    const side =
      o.direction != null && String(o.direction) !== ""
        ? String(o.direction)
        : o.posSide != null
          ? String(o.posSide)
          : "—";
    return [
      o.instId != null ? String(o.instId) : "—",
      side,
      okxMgnModeZh(o.mgnMode != null ? String(o.mgnMode) : ""),
      o.lever != null ? String(o.lever) : "—",
      o.openAvgPx != null ? String(o.openAvgPx) : "—",
      o.realizedPnl != null ? String(o.realizedPnl) : "—",
      o.openMaxPos != null ? String(o.openMaxPos) : "—",
      o.closeAvgPx != null ? String(o.closeAvgPx) : "—",
      okxPnlRatioDisplay(/** @type {string} */ (o.pnlRatio)),
      o.closeTotalPos != null ? String(o.closeTotalPos) : "—",
      okxPosHistTimeIso(/** @type {string} */ (o.cTime)),
      okxPosHistTimeIso(/** @type {string} */ (o.uTime)),
    ];
  });
  return [
    "",
    "### 最近仓位历史",
    "",
    "> **说明**：最近交易的 10 条历史仓位记录，供你参考盈亏情况。",
    "",
    mdTable(OKX_POSITION_HISTORY_LLM_HEADERS, tableRows),
  ].join("\n");
}

/**
 * @param {Record<string, unknown>} o
 * @param {string[]} keys
 */
function pickRow(o, keys) {
  return keys.map((k) => o[k]);
}

function clipText(text, maxLen = 120) {
  const s = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  return s.length > maxLen ? `${s.slice(0, Math.max(0, maxLen - 3))}...` : s;
}

function formatRecentAgentMemoryBlock(memories, exchangeCtx) {
  const rows = Array.isArray(memories) ? memories : [];
  if (rows.length === 0) {
    return [
      "### 最近操作",
      "",
      "> **说明**：这里会提醒你最近几轮自己做过什么，避免把刚刚止盈/止损/离场过的结构当成从未交易过的新世界。",
      "",
      "（当前无最近操作）",
    ].join("\n");
  }

  const lines = rows.map((row, idx) => {
    const action = clipText(row?.toolSummary || "无工具动作", 80) || "无工具动作";
    const holding = clipText(row?.holdingState || "空仓", 20) || "空仓";
    const note =
      clipText(row?.cardSummary || row?.assistantText || row?.agentError || "", 110) || "无补充说明";
    return `${idx + 1}. ${row?.capturedAt || "—"}｜${holding}｜${action}｜${note}`;
  });

  const latest = rows[0];
  const latestAfter =
    latest && latest.exchangeAfter && typeof latest.exchangeAfter === "object" ? latest.exchangeAfter : null;
  const latestPos =
    latestAfter && latestAfter.position && typeof latestAfter.position === "object" ? latestAfter.position : null;
  const latestHadPosition = latestPos && latestPos.hasPosition === true;
  const currentPos =
    exchangeCtx && exchangeCtx.position && typeof exchangeCtx.position === "object" ? exchangeCtx.position : null;
  const currentHasPosition = currentPos && currentPos.hasPosition === true;

  let transitionNote = "";
  if (latestHadPosition && !currentHasPosition) {
    transitionNote =
      "最新记忆显示：上一轮结束时你仍有仓位，但本轮开始已空仓。这说明仓位是在两轮之间离场了（可能止盈、止损或手动平仓）。不要把它当成“从未开过仓”的新机会；若要再进，必须确认有新的结构与新的 5m 触发。";
  } else if (!latestHadPosition && currentHasPosition) {
    transitionNote =
      "最新记忆显示：上一轮结束时空仓，但本轮开始已有仓位。说明这段时间出现了新成交或外部手动操作；优先先解释现有仓位，而不是忽略它。";
  }

  return [
    "### 最近动作",
    "",
    "> **说明**：以下是同品种同周期最近几轮自己的动作和结果。用于管理交易频率与纪律。",
    transitionNote ? "" : null,
    transitionNote || null,
    "",
    ...lines,
  ]
    .filter((v) => v != null)
    .join("\n");
}

/**
 * @param {object | null | undefined} fields
 */
function positionFieldsTable(fields) {
  if (!fields || typeof fields !== "object") return "（暂无仓位明细）";
  const entries = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return "（暂无仓位明细）";
  return mdTable(
    ["字段", "值"],
    entries.map(([k, v]) => [k, v]),
  );
}

function buildOkxContextUserText(marketText, exchangeCtx, positionsHistory, recentAgentMemories) {
  if (!exchangeCtx || exchangeCtx.enabled !== true) {
    let note;
    if (exchangeCtx?.reason === "okx_swap_disabled") {
      note = "（未启用 OKX 永续或未配置 API — 无交易所数据。）";
    } else if (exchangeCtx?.reason === "not_crypto_chart") {
      note = "（当前图表非 OKX 加密永续 — 无交易所数据。）";
    } else {
      note = `（无快照：${exchangeCtx?.reason || "OKX 永续未启用或未配置 API"}。）`;
    }
    return [marketText, "", "## OKX 永续快照", "", note].join("\n");
  }

  if (exchangeCtx.ok !== true) {
    const err = mdCell(exchangeCtx.message || "交易所快照失败");
    return [marketText, "", "## OKX 永续快照", "", `**接口错误**：${err}`].join("\n");
  }

  const cs = exchangeCtx.contract_sizing;
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
  const posFieldsSection = ["#### 仓位明细", "", positionFieldsTable(pos?.fields)].join("\n");

  const pending = Array.isArray(exchangeCtx.pending_orders) ? exchangeCtx.pending_orders : [];
  const pendingBlock =
    pending.length > 0
      ? mdTable(
          MD_PENDING_ORDER_HEADERS,
          pending.map((o) => pickRow(o, MD_PENDING_ORDER_HEADERS)),
        )
      : "（暂无普通挂单）";

  const algos = Array.isArray(exchangeCtx.pending_algo_orders) ? exchangeCtx.pending_algo_orders : [];
  const algoBlock =
    algos.length > 0
      ? mdTable(
          MD_ALGO_ORDER_HEADERS,
          algos.map((o) => pickRow(o, MD_ALGO_ORDER_HEADERS)),
        )
      : "（暂无算法挂单）";

  const recentMemoryBlock = formatRecentAgentMemoryBlock(recentAgentMemories, exchangeCtx);

  const contractBlock = mdTable(
    ["项目", "值"],
    [
      ["instId", exchangeCtx.instId],
      // ["模拟盘", sim ? "是" : "否"],
    ],
  );

  return [
    marketText,
    "",
    "## OKX 永续快照",
    "",
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
    recentMemoryBlock,
    "",
    "### 普通挂单",
    "",
    pendingBlock,
    "",
    "### 算法挂单（条件单等）",
    "",
    algoBlock,
    formatOkxPositionHistoryForPrompt(
      exchangeCtx?.ok === true && exchangeCtx?.enabled === true ? positionsHistory ?? null : null,
    ),
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
 * @param {string} tvSymbol
 * @param {number} [timeoutMs]
 */
async function requestChartCapture(tvSymbol, timeoutMs = 45000) {
  return requestChartCaptureFromBrowser(tvSymbol, timeoutMs);
}

/**
 * @param {{
 *   source: "okx_ws",
 *   tvSymbol: string,
 *   interval: string,
 *   periodLabel: string,
 *   candle: object,
 * }} ctx
 */
async function emitBarClose(ctx) {
  let chartImage: PrimaryChartImage | null = null;
  let chartImages: MultiTimeframeChartImage[] = [];
  let chartCaptureError: string | null = null;
  try {
    const capturePack = await requestChartCapture(ctx.tvSymbol);
    chartImage = {
      mimeType: capturePack.mimeType,
      base64: capturePack.base64,
      dataUrl: capturePack.dataUrl,
    };
    chartImages = Array.isArray(capturePack.charts) ? capturePack.charts : [];
  } catch (e) {
    chartCaptureError = e instanceof Error ? e.message : String(e);
  }

  const cfg = loadAppConfig();
  const barCloseId = crypto.randomUUID();

  const llm: {
    enabled: boolean;
    streaming: boolean;
    reasoningEnabled?: boolean;
    reasoningText?: string | null;
    analysisText: string | null;
    cardSummary?: string | null;
    skippedReason: string | null;
    error: string | null;
    toolTrace: unknown[];
  } = {
    enabled: isLlmEnabled(cfg),
    reasoningEnabled: cfg.llmReasoningEnabled === true,
    reasoningText: null,
    analysisText: null,
    cardSummary: null,
    skippedReason: null,
    error: null,
    streaming: false,
    toolTrace: [],
  };

  const convKey = conversationKey(ctx.tvSymbol, ctx.interval);
  const [exchangeCtx, recentCandlesPack, positionsHistory, recentAgentMemories] = await Promise.all([
    getOkxExchangeContextForBar(cfg, ctx.tvSymbol, ctx.interval),
    Promise.all(
      MULTI_TIMEFRAME_CAPTURE_SPECS.map(async (spec) => [
        spec.interval,
        await fetchRecentCandlesForTv(ctx.tvSymbol, spec.interval, RECENT_CANDLES_FETCH_LIMIT),
      ]),
    ),
    fetchRecentSwapPositionsHistoryForBar(cfg, ctx.tvSymbol, 10),
    Promise.resolve(listRecentAgentMemories({ tvSymbol: ctx.tvSymbol, interval: ctx.interval, limit: 6 })),
  ]);
  const recentCandles = Object.fromEntries(recentCandlesPack);
  const textForLlm = buildMultiTimeframeUserPrompt(
    ctx.tvSymbol,
    ctx.periodLabel,
    ctx.candle,
    recentCandles,
  );
  const llmUserText = buildOkxContextUserText(textForLlm, exchangeCtx, positionsHistory, recentAgentMemories);

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
    multiChartImages: chartImages,
    chartCaptureError,
    textForLlm,
    exchangeContext: exchangeCtx,
    fullUserPromptForDisplay: llmUserText,
    llm,
  };

  const finishSkipped = (reason) => {
    llm.skippedReason = reason;
    llm.analysisText = null;
    llm.streaming = false;
    llm.error = null;
    publish("market-bar-close", payloadBase);
  };

  if (!llm.enabled) {
    llm.skippedReason =
      "未调用 LLM：请在配置中心填写 API Key（或环境变量 OPENAI_API_KEY）。";
    publish("market-bar-close", payloadBase);
    return;
  }

  const orderedChartImages = MULTI_TIMEFRAME_CAPTURE_SPECS.map((spec) => {
    const found = chartImages.find((item) => String(item.interval) === spec.interval);
    if (!found?.base64) return null;
    return {
      ...found,
      label: spec.label,
    };
  }).filter(Boolean);

  if (
    chartCaptureError ||
    !chartImage?.base64 ||
    ctx.interval !== AGENT_DECISION_INTERVAL ||
    orderedChartImages.length !== MULTI_TIMEFRAME_CAPTURE_SPECS.length
  ) {
    finishSkipped(
      chartCaptureError
        ? `未调用 LLM：图表截图失败（${chartCaptureError}）。`
        : ctx.interval !== AGENT_DECISION_INTERVAL
          ? `未调用 LLM：当前触发周期不是 ${AGENT_DECISION_INTERVAL}m。`
          : "未调用 LLM：多周期图表截图不完整。",
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

  if (!String(resolveSystemPrompt(cfg) || "").trim()) {
    finishSkipped("未调用 LLM：请在「策略中心」创建策略并填写系统提示词；无策略则不运行 Agent。");
    return;
  }

  const systemPrompt = resolveTradingAgentSystemPrompt(cfg);
  const currentUserContent = buildMultimodalUserContent(
    llmUserText,
    orderedChartImages,
    chartImage.mimeType || "image/png",
  );
  /** 每根 K 线独立单轮：不传历史 messages，仅 system + 本轮 user（含完整 OKX 快照与图）。 */
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: currentUserContent },
  ];

  llm.streaming = true;
  llm.analysisText = "";
  publish("market-bar-close", payloadBase);

  const streamOpts = {
    appConfig: cfg,
    baseUrl: cfg.openaiBaseUrl,
    model: cfg.openaiModel,
  };

  const executeTool = createTradingToolExecutor({
    cfg,
    tvSymbol: ctx.tvSymbol,
    interval: ctx.interval,
    barCloseId,
  });
  const toolsForTurn = buildTradingAgentToolsForContext(exchangeCtx);

  let streamAcc = "";
  let streamToolAcc = "";
  let streamReasonAcc = "";
  const agentResult = await runTradingAgentTurn(messages, streamOpts, {
    tools: toolsForTurn,
    executeTool,
    maxSteps: 8,
    onStep: ({ toolCalls, assistantPreview, reasoningPreview }) => {
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
      if (cfg.llmReasoningEnabled === true && reasoningPreview != null && String(reasoningPreview).trim()) {
        streamReasonAcc = String(reasoningPreview).trim();
        changed = true;
      }
      if (changed) {
        publish("llm-stream-delta", {
          barCloseId,
          full: streamAcc,
          reasoningFull: cfg.llmReasoningEnabled === true ? streamReasonAcc : "",
          toolFull: streamToolAcc,
        });
      }
    },
  });

  if (agentResult.ok) {
    llm.analysisText = agentResult.text;
    llm.toolTrace = Array.isArray(agentResult.toolTrace) ? agentResult.toolTrace : [];
    llm.reasoningText =
      cfg.llmReasoningEnabled === true && agentResult.reasoningText ? String(agentResult.reasoningText) : "";
    llm.streaming = false;
    llm.cardSummary = null;
    const summaryP =
      agentResult.text && String(agentResult.text).trim()
        ? summarizeAgentAnalysisForCard(agentResult.text, streamOpts, {
            messagesOut: agentResult.messagesOut,
          })
        : Promise.resolve(/** @type {{ ok: boolean, text?: string }} */ ({ ok: false }));
    const [sumResult, exchangeAfter] = await Promise.all([
      summaryP,
      getOkxExchangeContextForBar(cfg, ctx.tvSymbol, ctx.interval),
    ]);
    if (sumResult.ok && sumResult.text) {
      llm.cardSummary = sumResult.text;
    }
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
        cardSummary: llm.cardSummary,
        toolTrace: llm.toolTrace,
        exchangeAfter,
        agentOk: true,
        systemPrompt,
        messagesOut: agentResult.messagesOut,
        assistantReasoningText:
          cfg.llmReasoningEnabled === true && String(agentResult.reasoningText || "").trim()
            ? String(agentResult.reasoningText).trim()
            : null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      publish("market-status", { text: `Agent 记录落库失败：${msg}` });
    }
    publish("llm-stream-end", {
      barCloseId,
      conversationKey: convKey,
      exchangeContext: exchangeAfter,
      analysisText: llm.analysisText,
      cardSummary: llm.cardSummary,
      reasoningText: llm.reasoningText || "",
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
        assistantReasoningText:
          cfg.llmReasoningEnabled === true && String(agentResult.reasoningText || "").trim()
            ? String(agentResult.reasoningText).trim()
            : null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      publish("market-status", { text: `Agent 记录落库失败：${msg}` });
    }
    publish("llm-stream-error", {
      barCloseId,
      message: agentResult.text,
      toolTrace: llm.toolTrace,
    });
  }
}

export { emitBarClose, requestChartCapture };
