/**
 * 交易复盘记录：LLM 复盘结果与压缩上下文的持久化。
 */
import crypto from "node:crypto";
import { and, desc, eq, lt, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { getDb } from "./db/client.js";
import { tradeReviews } from "./db/schema.js";

type TradeReviewStatus = "pending" | "running" | "completed" | "failed";

type TradeReviewUpsertInput = {
  id?: string;
  tvSymbol: string;
  interval: string;
  strategyId?: string | null;
  entryBarCloseId: string;
  exitBarCloseId: string;
  entryAt: string;
  exitAt: string;
  side?: string | null;
  entryPrice?: number | null;
  exitPrice?: number | null;
  pnl?: number | null;
  exitType?: string | null;
  exitReasonSource?: string | null;
  contextSummary: unknown;
  sourceSessionIds: string[];
};

function safeJsonParse(text: unknown) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function finiteOrNull(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tvSymbol: row.tvSymbol,
    interval: row.interval,
    strategyId: row.strategyId,
    entryBarCloseId: row.entryBarCloseId,
    exitBarCloseId: row.exitBarCloseId,
    entryAt: row.entryAt,
    exitAt: row.exitAt,
    side: row.side,
    entryPrice: row.entryPrice,
    exitPrice: row.exitPrice,
    pnl: row.pnl,
    exitType: row.exitType,
    exitReasonSource: row.exitReasonSource,
    contextSummary: safeJsonParse(row.contextSummaryJson),
    reviewText: row.reviewText,
    attribution: row.attribution,
    lessons: safeJsonParse(row.lessonsJson) ?? [],
    sourceSessionIds: safeJsonParse(row.sourceSessionIdsJson) ?? [],
    status: row.status,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function findTradeReviewByEntryExit(entryBarCloseId: string, exitBarCloseId: string) {
  const entry = String(entryBarCloseId || "").trim();
  const exit = String(exitBarCloseId || "").trim();
  if (!entry || !exit) return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(tradeReviews)
    .where(and(eq(tradeReviews.entryBarCloseId, entry), eq(tradeReviews.exitBarCloseId, exit)))
    .limit(1);
  return normalizeRow(rows[0]);
}

async function createTradeReviewDraft(input: TradeReviewUpsertInput) {
  const existing = await findTradeReviewByEntryExit(input.entryBarCloseId, input.exitBarCloseId);
  if (existing) return existing;

  const now = new Date().toISOString();
  const id = input.id && input.id.trim() ? input.id.trim() : crypto.randomUUID();
  const db = getDb();
  await db.insert(tradeReviews).values({
    id,
    tvSymbol: String(input.tvSymbol || ""),
    interval: String(input.interval || ""),
    strategyId: input.strategyId != null && String(input.strategyId).trim() ? String(input.strategyId) : null,
    entryBarCloseId: String(input.entryBarCloseId || ""),
    exitBarCloseId: String(input.exitBarCloseId || ""),
    entryAt: String(input.entryAt || ""),
    exitAt: String(input.exitAt || ""),
    side: input.side != null && String(input.side).trim() ? String(input.side) : null,
    entryPrice: finiteOrNull(input.entryPrice),
    exitPrice: finiteOrNull(input.exitPrice),
    pnl: finiteOrNull(input.pnl),
    exitType: input.exitType != null && String(input.exitType).trim() ? String(input.exitType) : "unknown",
    exitReasonSource:
      input.exitReasonSource != null && String(input.exitReasonSource).trim()
        ? String(input.exitReasonSource)
        : "inferred",
    contextSummaryJson: JSON.stringify(input.contextSummary ?? {}),
    reviewText: null,
    attribution: null,
    lessonsJson: null,
    sourceSessionIdsJson: JSON.stringify(Array.isArray(input.sourceSessionIds) ? input.sourceSessionIds : []),
    status: "pending",
    error: null,
    createdAt: now,
    updatedAt: now,
  });
  return getTradeReview(id);
}

async function markTradeReviewRunning(id: string) {
  const reviewId = String(id || "").trim();
  if (!reviewId) return null;
  const now = new Date().toISOString();
  await getDb()
    .update(tradeReviews)
    .set({ status: "running", error: null, updatedAt: now })
    .where(eq(tradeReviews.id, reviewId));
  return getTradeReview(reviewId);
}

async function completeTradeReview(
  id: string,
  result: { reviewText: string; attribution?: string | null; lessons?: unknown[] | null },
) {
  const reviewId = String(id || "").trim();
  if (!reviewId) return null;
  const now = new Date().toISOString();
  await getDb()
    .update(tradeReviews)
    .set({
      status: "completed",
      reviewText: String(result.reviewText || ""),
      attribution:
        result.attribution != null && String(result.attribution).trim() ? String(result.attribution).trim() : null,
      lessonsJson: JSON.stringify(Array.isArray(result.lessons) ? result.lessons : []),
      error: null,
      updatedAt: now,
    })
    .where(eq(tradeReviews.id, reviewId));
  return getTradeReview(reviewId);
}

async function failTradeReview(id: string, error: unknown) {
  const reviewId = String(id || "").trim();
  if (!reviewId) return null;
  const now = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error ?? "复盘失败");
  await getDb()
    .update(tradeReviews)
    .set({ status: "failed", error: message, updatedAt: now })
    .where(eq(tradeReviews.id, reviewId));
  return getTradeReview(reviewId);
}

async function getTradeReview(id: string) {
  const reviewId = String(id || "").trim();
  if (!reviewId) return null;
  const rows = await getDb().select().from(tradeReviews).where(eq(tradeReviews.id, reviewId)).limit(1);
  return normalizeRow(rows[0]);
}

async function listTradeReviewsPage(args: Record<string, unknown> = {}) {
  const tvSymbol = typeof args.tvSymbol === "string" ? args.tvSymbol.trim() : "";
  const interval = typeof args.interval === "string" ? args.interval.trim() : "";
  const status = typeof args.status === "string" ? args.status.trim() : "";
  const limit = Math.min(100, Math.max(1, Math.floor(Number(args.limit) || 20)));
  const cursorRaw =
    args.cursor && typeof args.cursor === "object" && !Array.isArray(args.cursor)
      ? (args.cursor as Record<string, unknown>)
      : null;
  const cap =
    cursorRaw && typeof cursorRaw.exitAt === "string" && typeof cursorRaw.id === "string"
      ? { exitAt: cursorRaw.exitAt.trim(), id: cursorRaw.id.trim() }
      : null;

  const filters: SQL[] = [];
  if (tvSymbol) filters.push(eq(tradeReviews.tvSymbol, tvSymbol));
  if (interval) filters.push(eq(tradeReviews.interval, interval));
  if (status) filters.push(eq(tradeReviews.status, status as TradeReviewStatus));
  if (cap?.exitAt && cap.id) {
    const cursorFilter = or(
      lt(tradeReviews.exitAt, cap.exitAt),
      and(eq(tradeReviews.exitAt, cap.exitAt), lt(tradeReviews.id, cap.id)),
    );
    if (cursorFilter) filters.push(cursorFilter);
  }

  const whereClause = filters.length > 0 ? and(...filters) : undefined;
  const baseQuery = getDb().select().from(tradeReviews);
  const rows = whereClause
    ? await baseQuery
        .where(whereClause)
        .orderBy(desc(tradeReviews.exitAt), desc(tradeReviews.id))
        .limit(limit)
    : await baseQuery.orderBy(desc(tradeReviews.exitAt), desc(tradeReviews.id)).limit(limit);
  const normalized = rows.map(normalizeRow).filter(Boolean);
  const hasMore = normalized.length === limit;
  const tail = normalized[normalized.length - 1];
  return {
    rows: normalized,
    nextCursor: hasMore && tail ? { exitAt: tail.exitAt, id: tail.id } : null,
    hasMore,
  };
}

export {
  createTradeReviewDraft,
  findTradeReviewByEntryExit,
  markTradeReviewRunning,
  completeTradeReview,
  failTradeReview,
  getTradeReview,
  listTradeReviewsPage,
};
