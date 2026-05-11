/**
 * 交易复盘上下文构建：从开仓回合到退出回合提炼短时间线，避免把完整持仓过程塞给 LLM。
 */
import { and, asc, desc, eq, lte } from "drizzle-orm";

import { getDb } from "./db/client.js";
import { agentSessions } from "./db/schema.js";
import { fetchRecentSwapPositionsHistoryForBar } from "./okx-perp.js";

type AgentSessionRow = typeof agentSessions.$inferSelect;

type TradeReviewBuildArgs = {
  cfg?: Record<string, unknown> | null;
  tvSymbol: string;
  interval: string;
  exitBarCloseId: string;
  strategyId?: string | null;
  exitHint?: "active_close" | "passive" | "unknown";
};

function safeJsonParse(text: unknown) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseToolTrace(row: AgentSessionRow): Array<Record<string, unknown>> {
  const parsed = safeJsonParse(row.toolTraceJson);
  return Array.isArray(parsed) ? (parsed.filter((x) => x && typeof x === "object") as Array<Record<string, unknown>>) : [];
}

function toolResultOk(item: Record<string, unknown>) {
  const result = asRecord(item.result);
  return result?.ok === true;
}

function successfulToolCalls(row: AgentSessionRow, name: string) {
  return parseToolTrace(row).filter((item) => item.name === name && toolResultOk(item));
}

function firstSuccessfulToolCall(row: AgentSessionRow, name: string) {
  return successfulToolCalls(row, name)[0] ?? null;
}

function hasSuccessfulToolCall(row: AgentSessionRow, name: string) {
  return successfulToolCalls(row, name).length > 0;
}

function exchangePosition(exchange: unknown) {
  const ctx = asRecord(exchange);
  const pos = asRecord(ctx?.position);
  if (!pos || pos.hasPosition !== true) return { hasPosition: false, side: null, avgPx: null, posNum: null };
  const rawSide = pos.posSide != null ? String(pos.posSide) : "";
  const posNum = finiteNumber(pos.posNum);
  const side =
    rawSide === "long" || rawSide === "short"
      ? rawSide
      : posNum != null && posNum > 0
        ? "long"
        : posNum != null && posNum < 0
          ? "short"
          : null;
  return {
    hasPosition: true,
    side,
    avgPx: finiteNumber(pos.avgPx ?? pos.openAvgPx),
    posNum,
  };
}

function rowExchangeContext(row: AgentSessionRow) {
  return safeJsonParse(row.exchangeContextJson);
}

function rowExchangeAfter(row: AgentSessionRow) {
  return safeJsonParse(row.exchangeAfterJson);
}

function rowHadPositionBefore(row: AgentSessionRow) {
  return exchangePosition(rowExchangeContext(row)).hasPosition;
}

function rowHasPositionAfter(row: AgentSessionRow) {
  return exchangePosition(rowExchangeAfter(row)).hasPosition;
}

function holdingLabel(exchange: unknown) {
  const pos = exchangePosition(exchange);
  if (!pos.hasPosition) return "空仓";
  if (pos.side === "long") return "持多";
  if (pos.side === "short") return "持空";
  return "持仓";
}

function extractToolArgs(item: Record<string, unknown> | null) {
  return asRecord(item?.args) ?? {};
}

function extractToolExchange(item: Record<string, unknown> | null) {
  return asRecord(asRecord(item?.result)?.exchange) ?? {};
}

function pickOpenSide(openCall: Record<string, unknown> | null, entryAfter: unknown) {
  const args = extractToolArgs(openCall);
  const sideRaw = args.side != null ? String(args.side).toLowerCase() : "";
  if (sideRaw === "long" || sideRaw === "short") return sideRaw;
  return exchangePosition(entryAfter).side;
}

function pickEntryPrice(openCall: Record<string, unknown> | null, entryAfter: unknown) {
  const ex = extractToolExchange(openCall);
  const args = extractToolArgs(openCall);
  return finiteNumber(ex.avgPx) ?? finiteNumber(args.limit_price) ?? exchangePosition(entryAfter).avgPx;
}

function pickExitPrice(closeCall: Record<string, unknown> | null, positionHistoryRow: Record<string, unknown> | null, exitRow: AgentSessionRow) {
  const histPx = finiteNumber(positionHistoryRow?.closeAvgPx);
  if (histPx != null) return histPx;
  const ex = extractToolExchange(closeCall);
  const toolPx = finiteNumber(ex.avgPx ?? ex.closeAvgPx);
  if (toolPx != null) return toolPx;
  const candle = asRecord(safeJsonParse(exitRow.textForLlm)) ?? null;
  return finiteNumber(candle?.close);
}

function parsePositionHistoryEffectiveTime(row: Record<string, unknown> | null) {
  return finiteNumber(row?.uTime) ?? finiteNumber(row?.cTime);
}

function pickLikelyPositionHistoryRow(rows: unknown[], exitAt: string, side: string | null) {
  const exitMs = Date.parse(exitAt);
  const candidates = rows
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .map((row) => ({ row, ms: parsePositionHistoryEffectiveTime(row) }))
    .filter((x) => x.ms != null && (!Number.isFinite(exitMs) || Math.abs((x.ms ?? 0) - exitMs) <= 48 * 60 * 60 * 1000));
  if (!candidates.length) return null;
  candidates.sort((a, b) => Math.abs((a.ms ?? 0) - exitMs) - Math.abs((b.ms ?? 0) - exitMs));
  if (!side) return candidates[0].row;
  return (
    candidates.find(({ row }) => {
      const dir = row.direction != null ? String(row.direction).toLowerCase() : "";
      const posSide = row.posSide != null ? String(row.posSide).toLowerCase() : "";
      return dir === side || posSide === side;
    })?.row ?? candidates[0].row
  );
}

function latestTpSlArgs(timeline: AgentSessionRow[]) {
  let current: Record<string, unknown> = {};
  for (const row of timeline) {
    for (const item of parseToolTrace(row)) {
      if (!toolResultOk(item)) continue;
      if (item.name === "open_position" || item.name === "amend_tp_sl") {
        current = { ...current, ...extractToolArgs(item) };
      }
    }
  }
  return current;
}

function inferPassiveExitType(side: string | null, pnl: number | null, tpSl: Record<string, unknown>) {
  const tp = finiteNumber(tpSl.take_profit_trigger_price ?? tpSl.tp_trigger_price);
  const sl = finiteNumber(tpSl.stop_loss_trigger_price ?? tpSl.sl_trigger_price);
  if (pnl != null) {
    if (pnl > 0 && tp != null) return "passive_take_profit";
    if (pnl < 0 && sl != null) return "passive_stop_loss";
  }
  if (side && (tp != null || sl != null)) return "unknown";
  return "manual_or_external";
}

function inferExitType(args: {
  exitHint?: string;
  exitRow: AgentSessionRow;
  side: string | null;
  pnl: number | null;
  tpSl: Record<string, unknown>;
}) {
  if (hasSuccessfulToolCall(args.exitRow, "close_position") || args.exitHint === "active_close") {
    return { exitType: "active_close", exitReasonSource: "agent_tool" };
  }
  const beforeHad = rowHadPositionBefore(args.exitRow);
  const afterHas = rowHasPositionAfter(args.exitRow);
  if (args.exitHint === "passive" || (beforeHad && !afterHas)) {
    return {
      exitType: inferPassiveExitType(args.side, args.pnl, args.tpSl),
      exitReasonSource: "inferred",
    };
  }
  return { exitType: "unknown", exitReasonSource: "inferred" };
}

function summarizeTrace(row: AgentSessionRow) {
  const trace = parseToolTrace(row);
  if (!trace.length) return [];
  return trace.map((item) => {
    const args = extractToolArgs(item);
    const result = asRecord(item.result);
    return {
      name: String(item.name || ""),
      ok: result?.ok === true,
      message: result?.message != null ? String(result.message) : null,
      side: args.side != null ? String(args.side) : null,
      orderType: args.order_type != null ? String(args.order_type) : null,
      takeProfit: args.take_profit_trigger_price ?? args.tp_trigger_price ?? null,
      stopLoss: args.stop_loss_trigger_price ?? args.sl_trigger_price ?? null,
      limitPrice: args.limit_price ?? null,
    };
  });
}

function buildTimelineItem(row: AgentSessionRow) {
  return {
    barCloseId: row.barCloseId,
    capturedAt: row.capturedAt,
    decision: row.assistantDecision,
    cardSummary: row.cardSummary,
    holdingBefore: holdingLabel(rowExchangeContext(row)),
    holdingAfter: holdingLabel(rowExchangeAfter(row)),
    tools: summarizeTrace(row),
  };
}

function clipText(text: unknown, max = 6000) {
  const s = text == null ? "" : String(text).trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n...（已截断）`;
}

function buildPrompt(summary: Record<string, unknown>) {
  return [
    "请复盘以下已完成交易。重点判断：入场时的原假设是什么，持仓期间是否遵守计划，出场是市场验证/否定了假设，还是执行问题。",
    "",
    "请输出中文 Markdown，包含：",
    "1. 结论归因：市场错 / 自己错 / 执行问题 / 风控问题 / 数据不足，可多选但要给主因。",
    "2. 入场假设与实际走势对照。",
    "3. 持仓过程关键节点。",
    "4. 出场质量与 TP/SL 设置评价。",
    "5. 下次可执行的改进清单。",
    "",
    "复盘上下文 JSON：",
    "```json",
    JSON.stringify(summary, null, 2),
    "```",
  ].join("\n");
}

async function loadExitAndCandidateRows(tvSymbol: string, interval: string, exitBarCloseId: string) {
  const db = getDb();
  const exitRows = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.barCloseId, exitBarCloseId))
    .limit(1);
  const exitRow = exitRows[0];
  if (!exitRow) return { exitRow: null, candidates: [] as AgentSessionRow[] };

  const candidatesDesc = await db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.tvSymbol, tvSymbol),
        eq(agentSessions.interval, interval),
        lte(agentSessions.capturedAt, exitRow.capturedAt),
      ),
    )
    .orderBy(desc(agentSessions.capturedAt), desc(agentSessions.barCloseId))
    .limit(300);
  return { exitRow, candidates: candidatesDesc.reverse() };
}

async function loadTimeline(tvSymbol: string, interval: string, entryAt: string, exitAt: string) {
  return getDb()
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.tvSymbol, tvSymbol),
        eq(agentSessions.interval, interval),
        lte(agentSessions.capturedAt, exitAt),
      ),
    )
    .orderBy(asc(agentSessions.capturedAt), asc(agentSessions.barCloseId))
    .then((rows) => rows.filter((row) => row.capturedAt >= entryAt && row.capturedAt <= exitAt));
}

function findEntryRow(candidates: AgentSessionRow[], exitRow: AgentSessionRow) {
  let entry: AgentSessionRow | null = null;
  for (const row of candidates) {
    if (hasSuccessfulToolCall(row, "open_position")) entry = row;
    if (row.barCloseId !== exitRow.barCloseId && hasSuccessfulToolCall(row, "close_position")) entry = null;
  }
  return entry;
}

async function fetchLikelyPositionHistory(cfg: Record<string, unknown> | null | undefined, tvSymbol: string, exitAt: string, side: string | null) {
  if (!cfg) return null;
  const exitMs = Date.parse(exitAt);
  const sinceMs = Number.isFinite(exitMs) ? exitMs - 7 * 24 * 60 * 60 * 1000 : null;
  const ph = await fetchRecentSwapPositionsHistoryForBar(cfg, tvSymbol, 20, sinceMs);
  if (!ph.ok || ph.skipped) return null;
  return pickLikelyPositionHistoryRow(Array.isArray(ph.rows) ? ph.rows : [], exitAt, side);
}

async function buildTradeReviewContext(args: TradeReviewBuildArgs) {
  const tvSymbol = String(args.tvSymbol || "").trim();
  const interval = String(args.interval || "").trim();
  const exitBarCloseId = String(args.exitBarCloseId || "").trim();
  if (!tvSymbol || !interval || !exitBarCloseId) return null;

  const { exitRow, candidates } = await loadExitAndCandidateRows(tvSymbol, interval, exitBarCloseId);
  if (!exitRow) return null;
  const entryRow = findEntryRow(candidates, exitRow);
  if (!entryRow) return null;

  const timelineRows = await loadTimeline(tvSymbol, interval, entryRow.capturedAt, exitRow.capturedAt);
  const openCall = firstSuccessfulToolCall(entryRow, "open_position");
  const closeCall = firstSuccessfulToolCall(exitRow, "close_position");
  const side = pickOpenSide(openCall, rowExchangeAfter(entryRow));
  const positionHistoryRow = await fetchLikelyPositionHistory(args.cfg, tvSymbol, exitRow.capturedAt, side);
  const tpSl = latestTpSlArgs(timelineRows);
  const pnl = finiteNumber(positionHistoryRow?.realizedPnl ?? positionHistoryRow?.pnl);
  const { exitType, exitReasonSource } = inferExitType({
    exitHint: args.exitHint,
    exitRow,
    side,
    pnl,
    tpSl,
  });

  const sourceSessionIds = timelineRows.map((row) => row.barCloseId);
  const summary = {
    tvSymbol,
    interval,
    strategyId: args.strategyId ?? null,
    entry: {
      barCloseId: entryRow.barCloseId,
      at: entryRow.capturedAt,
      side,
      price: pickEntryPrice(openCall, rowExchangeAfter(entryRow)),
      reason: clipText(entryRow.assistantText, 5000),
      reasoning: clipText(entryRow.assistantReasoningText, 3000),
      toolArgs: extractToolArgs(openCall),
    },
    exit: {
      barCloseId: exitRow.barCloseId,
      at: exitRow.capturedAt,
      price: pickExitPrice(closeCall, positionHistoryRow, exitRow),
      type: exitType,
      reasonSource: exitReasonSource,
      reason: clipText(exitRow.assistantText, 5000),
      reasoning: clipText(exitRow.assistantReasoningText, 3000),
      toolArgs: extractToolArgs(closeCall),
      positionHistory: positionHistoryRow,
      pnl,
    },
    riskPlan: {
      takeProfit: tpSl.take_profit_trigger_price ?? tpSl.tp_trigger_price ?? null,
      stopLoss: tpSl.stop_loss_trigger_price ?? tpSl.sl_trigger_price ?? null,
      triggerPriceType: tpSl.tp_sl_trigger_price_type ?? null,
    },
    timeline: timelineRows.map(buildTimelineItem),
  };

  return {
    tvSymbol,
    interval,
    strategyId: args.strategyId ?? null,
    entryBarCloseId: entryRow.barCloseId,
    exitBarCloseId: exitRow.barCloseId,
    entryAt: entryRow.capturedAt,
    exitAt: exitRow.capturedAt,
    side,
    entryPrice: summary.entry.price,
    exitPrice: summary.exit.price,
    pnl,
    exitType,
    exitReasonSource,
    contextSummary: summary,
    sourceSessionIds,
    prompt: buildPrompt(summary),
  };
}

export {
  buildTradeReviewContext,
  hasSuccessfulToolCall,
  parseToolTrace,
  rowHadPositionBefore,
  rowHasPositionAfter,
};
