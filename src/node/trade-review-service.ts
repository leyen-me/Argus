/**
 * 交易完成后排队生成复盘。入口只做轻量判定，真正 LLM 复盘进入全局 Agent 队列。
 */
import { and, desc, eq, lt } from "drizzle-orm";

import { enqueueAgentJob } from "./agent-job-queue.js";
import { loadAppConfig } from "./app-config.js";
import { buildTradeReviewContext } from "./trade-review-context.js";
import { runTradeReviewAgent } from "./trade-review-agent.js";
import {
  completeTradeReview,
  createTradeReviewDraft,
  failTradeReview,
  markTradeReviewRunning,
} from "./trade-reviews-store.js";
import { getDb } from "./db/client.js";
import { agentSessions } from "./db/schema.js";
import { publish } from "./runtime-bus.js";

type ReviewTriggerArgs = {
  cfg: Record<string, unknown>;
  tvSymbol: string;
  interval: string;
  barCloseId: string;
  capturedAt: string;
  toolTrace?: unknown[];
  exchangeContext?: unknown;
  exchangeAfter?: unknown;
  strategyId?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function safeJsonParse(text: unknown) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function exchangeHasPosition(exchange: unknown) {
  const pos = asRecord(asRecord(exchange)?.position);
  return pos?.hasPosition === true;
}

function hasSuccessfulMarketClose(toolTrace: unknown[]) {
  if (!Array.isArray(toolTrace)) return false;
  return toolTrace.some((item) => {
    const o = asRecord(item);
    if (o?.name !== "close_position") return false;
    const result = asRecord(o.result);
    if (result?.ok !== true) return false;
    const args = asRecord(o.args);
    const orderType = String(args?.order_type || "market").toLowerCase();
    return orderType !== "limit";
  });
}

async function previousSessionHadPosition(args: { tvSymbol: string; interval: string; capturedAt: string; barCloseId: string }) {
  const rows = await getDb()
    .select({
      exchangeAfterJson: agentSessions.exchangeAfterJson,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.tvSymbol, args.tvSymbol),
        eq(agentSessions.interval, args.interval),
        lt(agentSessions.capturedAt, args.capturedAt),
      ),
    )
    .orderBy(desc(agentSessions.capturedAt), desc(agentSessions.barCloseId))
    .limit(1);
  const prev = rows[0];
  if (!prev) return false;
  return exchangeHasPosition(safeJsonParse(prev.exchangeAfterJson));
}

async function shouldTriggerPassiveReview(args: ReviewTriggerArgs) {
  const beforeHad = exchangeHasPosition(args.exchangeContext);
  const afterHad = exchangeHasPosition(args.exchangeAfter);
  if (beforeHad && !afterHad) return true;
  if (beforeHad || afterHad) return false;
  return previousSessionHadPosition({
    tvSymbol: args.tvSymbol,
    interval: args.interval,
    capturedAt: args.capturedAt,
    barCloseId: args.barCloseId,
  });
}

async function runReviewJob(args: ReviewTriggerArgs, exitHint: "active_close" | "passive" | "unknown") {
  const cfg = await loadAppConfig().catch(() => args.cfg);
  const ctx = await buildTradeReviewContext({
    cfg,
    tvSymbol: args.tvSymbol,
    interval: args.interval,
    exitBarCloseId: args.barCloseId,
    strategyId: args.strategyId ?? null,
    exitHint,
  });
  if (!ctx) return;

  const draft = await createTradeReviewDraft(ctx);
  if (!draft || draft.status === "completed" || draft.status === "running") return;
  await markTradeReviewRunning(draft.id);
  publish("market-status", {
    text: `交易复盘开始：${args.tvSymbol} · ${ctx.entryAt} → ${ctx.exitAt}`,
  });

  const result = await runTradeReviewAgent(ctx.prompt, {
    appConfig: cfg,
    baseUrl: typeof cfg.openaiBaseUrl === "string" ? cfg.openaiBaseUrl : undefined,
    model: typeof cfg.openaiModel === "string" ? cfg.openaiModel : undefined,
  });
  if (result.ok === true) {
    await completeTradeReview(draft.id, {
      reviewText: result.text,
      attribution: "attribution" in result ? result.attribution : null,
      lessons: "lessons" in result ? result.lessons : [],
    });
    publish("market-status", { text: `交易复盘完成：${args.tvSymbol}` });
    return;
  }
  await failTradeReview(draft.id, result.text);
  publish("market-status", { text: `交易复盘失败：${result.text}` });
}

async function maybeEnqueueTradeReviewAfterBarTurn(args: ReviewTriggerArgs) {
  const active = hasSuccessfulMarketClose(args.toolTrace ?? []);
  const passive = active ? false : await shouldTriggerPassiveReview(args);
  if (!active && !passive) return false;

  const exitHint = active ? "active_close" : "passive";
  enqueueAgentJob(() => runReviewJob(args, exitHint), {
    kind: "trade_review",
    label: args.barCloseId,
  }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    publish("market-status", { text: `交易复盘任务失败：${msg}` });
  });
  return true;
}

export { maybeEnqueueTradeReviewAfterBarTurn, hasSuccessfulMarketClose };
