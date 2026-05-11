/**
 * K 线收盘后：将行情文本上下文组装为 payload，供收盘 LLM Agent + OKX 工具调用。
 */
import crypto from "node:crypto";
import { publish } from "./runtime-bus.js";
import { loadAppConfig, type AppConfig } from "./app-config.js";
import { conversationKey } from "./llm-context.js";
import {
  isLlmEnabled,
  buildMultiTimeframeUserPrompt,
  buildMultimodalUserContent,
  buildUserTextForHistory,
  runTradingAgentTurn,
  resolveSystemPrompt,
  resolveTradingAgentSystemPrompt,
  RECENT_CANDLES_FETCH_LIMIT,
  mdCell,
  mdTable,
  summarizeAgentAnalysisForCard,
} from "./llm.js";
import { requestChartCaptureFromBrowser } from "./chart-capture-browser-bridge.js";
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
import { maybeEnqueueTradeReviewAfterBarTurn } from "./trade-review-service.js";
import { getDashboardSnapshot } from "./dashboard-service.js";
import { ensureHeadlessCaptureReady, headlessCaptureRequestTimeoutMs } from "./headless-browser-service.js";
import * as promptStrategiesStore from "./prompt-strategies-store.js";
import {
  MULTI_TIMEFRAME_CAPTURE_SPECS,
  canonTradingViewInterval,
  decisionIntervalExplain,
  filterMultiTimeframeSpecsByMarketSelection,
} from "../shared/strategy-fields.js";

type MultiTimeframeChartImage = {
  interval: string;
  label: string;
  mimeType: string;
  base64: string;
  dataUrl: string;
};

type PrimaryChartImage = { mimeType: string; base64: string; dataUrl: string };

const RECENT_AGENT_MEMORY_LIMIT = 10;
const MARKET_DATA_MULTI_TIMEFRAME_HEADING = "## 市场数据多周期上下文";

/**
 * 历史仓位注入 LLM 时的下界：与仪表盘「启动策略」写入的会话起点对齐（优先 `strategyRuntimeById.startedAt`，其次仪表盘 `statsSince` / 首段 `startedAt`）。
 * @returns 毫秒时间戳；无法解析则 `null`（此时 OKX 请求不按会话过滤，与旧行为一致）。
 */
function resolveStrategyPositionHistorySinceMs(cfg: AppConfig): number | null {
  const id = typeof cfg.promptStrategy === "string" ? cfg.promptStrategy.trim() : "";
  if (!id) return null;
  const runRow = cfg.strategyRuntimeById[id];
  const dashRow = cfg.dashboardStrategyRanges[id];
  const candidates = [
    runRow?.startedAt,
    dashRow?.statsSince,
    Array.isArray(dashRow?.segments) ? dashRow.segments[0]?.startedAt : undefined,
  ];
  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (!t) continue;
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * 当前策略执行态是否允许收盘 Agent；若非 `running` 则返回跳过原因（与仪表盘统计会话独立）。
 */
function describeBarCloseStrategyExecutionSkipReason(cfg: AppConfig): string | null {
  const id = typeof cfg.promptStrategy === "string" ? cfg.promptStrategy.trim() : "";
  if (!id) return "未调用 LLM：请先在策略中心创建并选用策略。";
  const row = cfg.strategyRuntimeById[id];
  const st = row?.status ?? "idle";
  if (st === "running") return null;
  if (st === "paused") {
    return "未调用 LLM：当前策略已暂停（执行态），请在仪表盘「恢复策略」或重新「启动策略」。";
  }
  if (st === "stopped") {
    return "未调用 LLM：当前策略已停止，请在仪表盘点击「启动策略」以允许收盘自动 Agent。";
  }
  return "未调用 LLM：当前策略未启动，请在仪表盘点击「启动策略」。";
}

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

const OKX_FIELD_LABELS: Record<string, string> = Object.freeze({
  accFillSz: "累计成交张数",
  absContracts: "持仓绝对张数",
  algoId: "算法单 ID",
  availPos: "可平张数",
  avgPx: "开仓均价",
  cTime: "创建时间",
  ccy: "保证金币种",
  clOrdId: "客户自定义订单 ID",
  closeAvgPx: "平仓均价",
  closeTotalPos: "已平张数",
  ct_val: "合约面值",
  direction: "方向",
  estimated_contracts: "预估张数",
  hasPosition: "有持仓",
  instId: "合约",
  last: "最新成交价",
  last_px: "最新价格",
  lever: "杠杆",
  leverage: "杠杆",
  liqPx: "预估强平价",
  lot_sz: "下单步长",
  margin: "保证金",
  margin_fraction: "保证金占用比例",
  meets_min_sz: "满足最小张数",
  mgnMode: "保证金模式",
  min_sz: "最小下单张数",
  notionalUsd: "名义价值",
  ordId: "订单 ID",
  ordPx: "委托价格",
  ordType: "订单类型",
  openAvgPx: "开仓均价",
  openMaxPos: "最大持仓张数",
  pnlRatio: "实现收益率",
  pos: "持仓张数",
  posNum: "持仓张数",
  posSide: "持仓方向",
  px: "委托价格",
  reduceOnly: "只减仓",
  side: "买卖方向",
  slOrdPx: "止损委托价",
  slTriggerPx: "止损触发价",
  slTriggerPxType: "止损触发价类型",
  state: "订单状态",
  sz: "委托张数",
  tdMode: "交易模式",
  tick_sz: "报价步长",
  tpOrdPx: "止盈委托价",
  tpTriggerPx: "止盈触发价",
  tpTriggerPxType: "止盈触发价类型",
  triggerPx: "触发价",
  triggerPxType: "触发价类型",
  upl: "未实现收益",
  uplRatio: "未实现收益率",
  usdt_avail_eq: "USDT 可用权益",
  realizedPnl: "已实现收益",
  uTime: "更新时间",
});

const OKX_POSITION_HISTORY_LLM_HEADERS = [
  "合约（instId）",
  "持仓方向（direction/posSide）",
  "保证金模式（mgnMode）",
  "杠杆（lever）",
  "开仓均价（openAvgPx）",
  "已实现收益（realizedPnl）",
  "最大持仓张数（openMaxPos）",
  "平仓均价（closeAvgPx）",
  "实现收益率（pnlRatio）",
  "已平张数（closeTotalPos）",
  "创建时间（cTime）",
  "更新时间（uTime）",
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

function compactPromptUtcTime(raw) {
  if (raw == null || raw === "") return "—";
  const s = String(raw).trim();
  if (!s) return "—";
  const numericMs = typeof raw === "number" || /^\d+$/.test(s) ? Number(s) : NaN;
  const text = Number.isFinite(numericMs) ? new Date(numericMs).toISOString() : s;
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2})/);
  if (m) return `${m[2]}-${m[3]} ${m[4]}`;
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return compactPromptUtcTime(parsed);
  return text.length > 16 ? text.slice(0, 16) : text;
}

function formatPromptTimeReferenceBlock(now = new Date()) {
  const iso = now.toISOString();
  const year = iso.slice(0, 4);
  return ["## 时间基准", "", `当前 UTC：${year}-${compactPromptUtcTime(iso)}；下文表内时间均为 UTC，格式 MM-DD HH:mm。`].join(
    "\n",
  );
}

function finiteNumberOrNull(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function formatPromptUsdt(raw) {
  const n = finiteNumberOrNull(raw);
  if (n == null) return "—";
  return stripPromptNumber(n, 2);
}

function formatPromptSignedUsdt(raw) {
  const n = finiteNumberOrNull(raw);
  if (n == null) return "—";
  const prefix = n > 0 ? "+" : "";
  return `${prefix}${stripPromptNumber(n, 2)}`;
}

function formatPromptPercent(raw) {
  const n = finiteNumberOrNull(raw);
  if (n == null) return "—";
  return `${stripPromptNumber(n * 100, 2)}%`;
}

function stripPromptNumber(n, maxDecimals = 2) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(maxDecimals).replace(/\.?0+$/, "");
}

function formatDashboardStatsBlock(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return ["## 策略资金与表现", "", "（暂无策略资金与表现数据。）"].join("\n");
  }
  if (snapshot.ok !== true) {
    return [
      "## 策略资金与表现",
      "",
      `（策略资金与表现数据不可用：${mdCell(snapshot.message || snapshot.reason || "未知原因")}。）`,
    ].join("\n");
  }
  if (snapshot.skipped === true) {
    return [
      "## 策略资金与表现",
      "",
      `（策略资金与表现数据已跳过：${mdCell(snapshot.reason || "未启用 OKX 永续")}。）`,
    ].join("\n");
  }

  const equity = finiteNumberOrNull(snapshot.equityUsdt);
  const avail = finiteNumberOrNull(snapshot.availEqUsdt);
  const baseline = finiteNumberOrNull(snapshot.baselineEquityUsdt);
  const pnl = finiteNumberOrNull(snapshot.pnlVsBaselineUsdt);
  const pnlRatio = pnl != null && baseline != null && baseline > 0 ? pnl / baseline : null;
  const freeRatio = avail != null && equity != null && equity > 0 ? avail / equity : null;
  const closeStats = snapshot.swapClosePositionStats;
  const winRate =
    closeStats && typeof closeStats === "object" ? finiteNumberOrNull(closeStats.winRate) : null;
  const closeFills =
    closeStats && typeof closeStats === "object" ? finiteNumberOrNull(closeStats.closeFills) : null;
  const since =
    typeof snapshot.dashboardAgentToolStatsSince === "string" && snapshot.dashboardAgentToolStatsSince.trim()
      ? compactPromptUtcTime(snapshot.dashboardAgentToolStatsSince)
      : "—";

  return [
    "## 策略资金与表现",
    "",
    mdTable(
      [
        "统计起点",
        "胜率（winRate）",
        "平仓次数（closeFills）",
        "总盈亏（pnlVsBaselineUsdt）",
        "收益率",
        "初始资金（baselineEquityUsdt）",
        "总权益（equityUsdt）",
        "未实现盈亏（uplUsdt）",
        "可用资金（availEqUsdt）",
        "空闲比例",
      ],
      [
        [
          since,
          formatPromptPercent(winRate),
          closeFills ?? "—",
          formatPromptSignedUsdt(pnl),
          formatPromptPercent(pnlRatio),
          formatPromptUsdt(baseline),
          formatPromptUsdt(equity),
          formatPromptSignedUsdt(snapshot.uplUsdt),
          formatPromptUsdt(avail),
          formatPromptPercent(freeRatio),
        ],
      ],
    ),
  ].join("\n");
}

/**
 * @param {string | number | null | undefined} ms
 */
function okxPosHistTimeCompact(ms) {
  return compactPromptUtcTime(ms);
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
    const sinceCompact =
      ph.sessionSinceMs != null && Number.isFinite(ph.sessionSinceMs)
        ? compactPromptUtcTime(ph.sessionSinceMs)
        : null;
    const emptyHint =
      sinceCompact != null
        ? `> **说明**：以下为自本轮策略在仪表盘「启动策略」以来（起算 UTC：\`${sinceCompact}\`）的平仓记录；当前列表为空表示该时段内该合约无历史仓位（或尚无已结仓位）。`
        : "> **说明**：数据来自 OKX `positions-history`；若为空，可能近约 3 个月该 `instId` 无记录。";
    return [
      "",
      "### 最近仓位历史",
      "",
      emptyHint,
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
      okxPosHistTimeCompact(/** @type {string} */ (o.cTime)),
      okxPosHistTimeCompact(/** @type {string} */ (o.uTime)),
    ];
  });
  return [
    "",
    "### 最近仓位历史",
    "",
    mdTable(OKX_POSITION_HISTORY_LLM_HEADERS, tableRows),
  ].join("\n");
}

function splitMarketDataMultiTimeframeBlock(userText) {
  const text = String(userText ?? "");
  const marker = `\n\n${MARKET_DATA_MULTI_TIMEFRAME_HEADING}`;
  const idx = text.indexOf(marker);
  if (idx === -1) {
    return { primaryText: text, marketDataBlock: "" };
  }
  return {
    primaryText: text.slice(0, idx).trimEnd(),
    marketDataBlock: text.slice(idx + 2).trim(),
  };
}

/**
 * @param {Record<string, unknown>} o
 * @param {string[]} keys
 */
function pickRow(o, keys) {
  return keys.map((k) => o[k]);
}

function okxFieldLabel(key) {
  const label = OKX_FIELD_LABELS[key];
  return label ? `${label}（${key}）` : key;
}

function okxHeaderLabels(keys) {
  return keys.map(okxFieldLabel);
}

function clipText(text, maxLen = 120) {
  const s = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  return s.length > maxLen ? `${s.slice(0, Math.max(0, maxLen - 3))}...` : s;
}

function formatRecentAgentMemoryBlock(memories, _exchangeCtx) {
  const rows = Array.isArray(memories) ? memories : [];
  if (rows.length === 0) {
    return [
      "### 最近操作",
      "",
      "（当前无最近操作）",
    ].join("\n");
  }

  const lines = rows.map((row, idx) => {
    const action = clipText(row?.toolSummary || "无工具动作", 80) || "无工具动作";
    const holding = clipText(row?.holdingState || "空仓", 20) || "空仓";
    const note =
      clipText(row?.cardSummary || row?.assistantText || row?.agentError || "", 110) || "无补充说明";
    return `${idx + 1}. ${compactPromptUtcTime(row?.capturedAt)}｜${holding}｜${action}｜${note}`;
  });

  return [
    "### 最近动作",
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
    entries.map(([k, v]) => [okxFieldLabel(k), v]),
  );
}

function buildOkxContextUserText(marketText, exchangeCtx, positionsHistory, recentAgentMemories, dashboardSnapshot) {
  const timeReferenceBlock = formatPromptTimeReferenceBlock();
  const dashboardStatsBlock = formatDashboardStatsBlock(dashboardSnapshot);
  if (!exchangeCtx || exchangeCtx.enabled !== true) {
    let note;
    if (exchangeCtx?.reason === "okx_swap_disabled") {
      note = "（未启用 OKX 永续或未配置 API — 无交易所数据。）";
    } else if (exchangeCtx?.reason === "not_crypto_chart") {
      note = "（当前图表非 OKX 加密永续 — 无交易所数据。）";
    } else {
      note = `（无快照：${exchangeCtx?.reason || "OKX 永续未启用或未配置 API"}。）`;
    }
    return [marketText, "", timeReferenceBlock, "", dashboardStatsBlock, "", "## OKX 永续快照", "", note].join("\n");
  }

  if (exchangeCtx.ok !== true) {
    const err = mdCell(exchangeCtx.message || "交易所快照失败");
    return [
      marketText,
      "",
      timeReferenceBlock,
      "",
      dashboardStatsBlock,
      "",
      "## OKX 永续快照",
      "",
      `**接口错误**：${err}`,
    ].join("\n");
  }

  const cs = exchangeCtx.contract_sizing;
  const accountHeaders = ["usdt_avail_eq", "ct_val", "lot_sz", "min_sz", "tick_sz", "last_px"];
  const accountBlock = mdTable(
    okxHeaderLabels(accountHeaders),
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
  const posSummaryHeaders = ["hasPosition", "posSide", "posNum", "absContracts"];
  const posSummary = mdTable(
    okxHeaderLabels(posSummaryHeaders),
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
          okxHeaderLabels(MD_PENDING_ORDER_HEADERS),
          pending.map((o) => pickRow(o, MD_PENDING_ORDER_HEADERS)),
        )
      : "（暂无普通挂单）";

  const algos = Array.isArray(exchangeCtx.pending_algo_orders) ? exchangeCtx.pending_algo_orders : [];
  const algoBlock =
    algos.length > 0
      ? mdTable(
          okxHeaderLabels(MD_ALGO_ORDER_HEADERS),
          algos.map((o) => pickRow(o, MD_ALGO_ORDER_HEADERS)),
        )
      : "（暂无算法挂单）";

  const recentMemoryBlock = formatRecentAgentMemoryBlock(recentAgentMemories, exchangeCtx);

  const contractBlock = mdTable(
    ["项目", "值"],
    [
      [okxFieldLabel("instId"), exchangeCtx.instId],
      // ["模拟盘", sim ? "是" : "否"],
    ],
  );

  return [
    marketText,
    "",
    timeReferenceBlock,
    "",
    dashboardStatsBlock,
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
    "### 算法挂单/条件单",
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

async function requestChartCapture(tvSymbol: string, marketTimeframes?: string[]) {
  try {
    await ensureHeadlessCaptureReady();
  } catch {
    /* fallback to any already-connected interactive page */
  }
  return requestChartCaptureFromBrowser(tvSymbol, headlessCaptureRequestTimeoutMs(), marketTimeframes, {
    preferredRole: "headless_capture",
    allowRoleFallback: true,
  });
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
  const cfg = await loadAppConfig();
  const marketTfs = await promptStrategiesStore.getMarketTimeframesForStrategyId(cfg.promptStrategy);
  const strategyIndicators = await promptStrategiesStore.getIndicatorsForStrategyId(cfg.promptStrategy);
  const multiCaptureSpecs = filterMultiTimeframeSpecsByMarketSelection(
    MULTI_TIMEFRAME_CAPTURE_SPECS,
    marketTfs,
  );

  let chartImage: PrimaryChartImage | null = null;
  let chartImages: MultiTimeframeChartImage[] = [];
  let chartCaptureError: string | null = null;
  const decisionIvCanon = canonTradingViewInterval(cfg.promptStrategyDecisionIntervalTv ?? "5");
  const ctxIvCanon = canonTradingViewInterval(ctx.interval);
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

  const convKey = conversationKey(ctx.tvSymbol, canonTradingViewInterval(ctx.interval));
  const sessionSinceMs = resolveStrategyPositionHistorySinceMs(cfg);
  const [exchangeCtx, recentCandlesPack, positionsHistory, recentAgentMemories, dashboardSnapshot] = await Promise.all([
    getOkxExchangeContextForBar(cfg, ctx.tvSymbol, ctx.interval),
    Promise.all(
      multiCaptureSpecs.map(async (spec) => [
        spec.interval,
        await fetchRecentCandlesForTv(ctx.tvSymbol, spec.interval, RECENT_CANDLES_FETCH_LIMIT),
      ]),
    ),
    fetchRecentSwapPositionsHistoryForBar(cfg, ctx.tvSymbol, 10, sessionSinceMs),
    listRecentAgentMemories({ tvSymbol: ctx.tvSymbol, interval: ctx.interval, limit: RECENT_AGENT_MEMORY_LIMIT }),
    getDashboardSnapshot(cfg),
  ]);
  const recentCandles = Object.fromEntries(recentCandlesPack);
  const textForLlm = buildMultiTimeframeUserPrompt(
    ctx.tvSymbol,
    ctx.periodLabel,
    ctx.candle,
    recentCandles,
    marketTfs,
    strategyIndicators,
  );
  const { primaryText, marketDataBlock } = splitMarketDataMultiTimeframeBlock(textForLlm);
  const okxUserText = buildOkxContextUserText(
    primaryText,
    exchangeCtx,
    positionsHistory,
    recentAgentMemories,
    dashboardSnapshot,
  );
  const llmUserText = [okxUserText, marketDataBlock].filter(Boolean).join("\n\n");
  const systemPrompt = resolveTradingAgentSystemPrompt(cfg);
  const intervalSkipReason =
    ctxIvCanon !== decisionIvCanon
      ? `未调用 LLM：当前触发周期不是 ${decisionIntervalExplain(cfg.promptStrategyDecisionIntervalTv ?? "5")}。`
      : null;
  const exchangeSkipReason = isOkxExchangeContextReadyForBarAgent(exchangeCtx)
    ? null
    : describeOkxExchangeContextGateFailure(exchangeCtx);
  const autoAgentSkipReason =
    cfg.barCloseAgentAutoEnabled === false ? "未调用 LLM：右侧面板已关闭「K 线收盘自动 Agent」。" : null;
  const execSkipReason = describeBarCloseStrategyExecutionSkipReason(cfg);
  const promptSkipReason = String(resolveSystemPrompt(cfg) || "").trim()
    ? null
    : "未调用 LLM：请在「策略中心」创建策略并填写系统提示词；无策略则不运行 Agent。";
  const shouldAttemptChartCapture =
    llm.enabled &&
    !intervalSkipReason &&
    !exchangeSkipReason &&
    !autoAgentSkipReason &&
    !execSkipReason &&
    !promptSkipReason;

  if (shouldAttemptChartCapture) {
    try {
      const capturePack = await requestChartCapture(ctx.tvSymbol, marketTfs);
      chartImage = {
        mimeType: capturePack.mimeType,
        base64: capturePack.base64,
        dataUrl: capturePack.dataUrl,
      };
      chartImages = Array.isArray(capturePack.charts) ? capturePack.charts : [];
    } catch (e) {
      chartCaptureError = e instanceof Error ? e.message : String(e);
    }
  }

  const orderedChartImages = multiCaptureSpecs
    .map((spec) => {
      const found = chartImages.find((item) => String(item.interval) === spec.interval);
      if (!found?.base64) return null;
      return {
        ...found,
        label: found.label || spec.label,
      };
    })
    .filter(Boolean) as MultiTimeframeChartImage[];
  const hasExpectedMultiChartImages =
    multiCaptureSpecs.length > 0 ? orderedChartImages.length === multiCaptureSpecs.length : true;
  if (!chartCaptureError && multiCaptureSpecs.length > 0 && !hasExpectedMultiChartImages) {
    chartCaptureError = "多周期图表截图不完整。";
  }
  const multimodalImageInput =
    orderedChartImages.length > 0
      ? orderedChartImages
      : chartImage?.base64
        ? chartImage.base64
        : null;
  if (shouldAttemptChartCapture && !chartCaptureError && !multimodalImageInput) {
    chartCaptureError = "图表截图为空。";
  }
  const canUseMultimodal =
    !chartCaptureError &&
    !!multimodalImageInput &&
    (orderedChartImages.length > 0 ? hasExpectedMultiChartImages : !!chartImage?.base64);
  const llmUserFullText = buildUserTextForHistory(llmUserText, canUseMultimodal);

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
    fullUserPromptForDisplay: llmUserFullText,
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

  if (intervalSkipReason) {
    finishSkipped(intervalSkipReason);
    return;
  }

  if (exchangeSkipReason) {
    finishSkipped(exchangeSkipReason);
    return;
  }

  if (autoAgentSkipReason) {
    finishSkipped(autoAgentSkipReason);
    return;
  }

  if (execSkipReason) {
    finishSkipped(execSkipReason);
    return;
  }

  if (promptSkipReason) {
    finishSkipped(promptSkipReason);
    return;
  }

  const currentUserContent = canUseMultimodal
    ? buildMultimodalUserContent(
        llmUserText,
        multimodalImageInput as string | MultiTimeframeChartImage[],
        chartImage?.mimeType || "image/png",
      )
    : llmUserText;
  // 每根 K 线独立单轮：优先走带图的多模态输入，截图失败时自动回退到纯文本。
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
    onRetry: ({ retryCount, maxRetries, delayMs, error }) => {
      const rawMessage =
        error && typeof error === "object" && "message" in error ? String(error.message || "") : String(error || "");
      const reason = /timed out|timeout/i.test(rawMessage)
        ? "请求超时"
        : /429/.test(rawMessage)
          ? "请求过于频繁"
          : "请求失败";
      const delaySec = delayMs >= 1000 ? (delayMs / 1000).toFixed(delayMs % 1000 === 0 ? 0 : 1) : null;
      const delayText = delaySec ? `，${delaySec} 秒后继续` : "";
      publish("market-status", {
        text: `LLM ${reason}，正在第 ${retryCount}/${maxRetries} 轮重试${delayText}…`,
      });
    },
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
        : Promise.resolve({ ok: false } as { ok: boolean; text?: string });
    const [sumResult, exchangeAfter] = await Promise.all([
      summaryP,
      getOkxExchangeContextForBar(cfg, ctx.tvSymbol, ctx.interval),
    ]);
    if (sumResult.ok && sumResult.text) {
      llm.cardSummary = sumResult.text;
    }
    payloadBase.exchangeContext = exchangeAfter;
    let persisted = false;
    try {
      await persistAgentBarTurn({
        barCloseId,
        tvSymbol: ctx.tvSymbol,
        interval: ctx.interval,
        periodLabel: ctx.periodLabel,
        capturedAt: payloadBase.capturedAt,
        textForLlm,
        llmUserFullText,
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
      persisted = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      publish("market-status", { text: `Agent 记录落库失败：${msg}` });
    }
    if (persisted) {
      void maybeEnqueueTradeReviewAfterBarTurn({
        cfg,
        tvSymbol: ctx.tvSymbol,
        interval: ctx.interval,
        barCloseId,
        capturedAt: payloadBase.capturedAt,
        toolTrace: llm.toolTrace,
        exchangeContext: exchangeCtx,
        exchangeAfter,
        strategyId: typeof cfg.promptStrategy === "string" ? cfg.promptStrategy : null,
      }).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        publish("market-status", { text: `交易复盘触发失败：${msg}` });
      });
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
      await persistAgentBarTurn({
        barCloseId,
        tvSymbol: ctx.tvSymbol,
        interval: ctx.interval,
        periodLabel: ctx.periodLabel,
        capturedAt: payloadBase.capturedAt,
        textForLlm,
        llmUserFullText,
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

export { emitBarClose };
