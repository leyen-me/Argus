/**
 * 每根 K 线收盘 Agent：`agent_sessions`（会话元数据 + 图）+ `agent_session_messages`（有序 API 消息，便于排查）。
 */
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";

import { getDb } from "./db/client.js";
import { agentSessionMessages, agentSessions } from "./db/schema.js";

/**
 * 多模态 user 中的 data: 大图不落 messages 表，避免与 chart_png 重复；排查时对照 session 行。
 */
function redactContentForStorage(content) {
  if (content == null) return null;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const p = /** @type {{ type?: string, image_url?: { url?: string } }} */ (part);
    if (p.type === "image_url" && p.image_url && typeof p.image_url.url === "string") {
      const u = p.image_url.url;
      if (u.startsWith("data:image")) {
        return {
          type: "image_url",
          image_url: {
            url: "<omitted: chart_png in agent_sessions for this bar_close_id>",
          },
        };
      }
    }
    return part;
  });
}

function extractAssistantDecision(content) {
  if (content == null) return null;
  let text = "";
  if (typeof content === "string") text = content.trim();
  else if (Array.isArray(content)) {
    text = content
      .map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
  } else {
    text = String(content).trim();
  }
  if (!text) return null;
  const lineMatch = text.match(/(?:^|\n)\s*decision\s*[:：=]\s*(hold|open|close|amend)\b/i);
  if (lineMatch) return /** @type {"hold" | "open" | "close" | "amend"} */ (lineMatch[1].toLowerCase());
  const jsonMatch = text.match(/"decision"\s*:\s*"(hold|open|close|amend)"/i);
  if (jsonMatch) return /** @type {"hold" | "open" | "close" | "amend"} */ (jsonMatch[1].toLowerCase());
  return null;
}

function nonNegativeIntOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function isoStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return Number.isNaN(new Date(trimmed).getTime()) ? null : trimmed;
}

function metricValue(row: Record<string, unknown>, key: string): unknown {
  const metrics = row.llmMetrics && typeof row.llmMetrics === "object" ? row.llmMetrics : row.metrics;
  if (!metrics || typeof metrics !== "object") return null;
  return (metrics as Record<string, unknown>)[key];
}

function buildSessionMetrics(row: {
  llmPromptTokens?: unknown;
  llmCompletionTokens?: unknown;
  llmTotalTokens?: unknown;
  llmStartedAt?: unknown;
  llmEndedAt?: unknown;
  llmDurationMs?: unknown;
}) {
  const promptTokens = nonNegativeIntOrNull(row.llmPromptTokens);
  const completionTokens = nonNegativeIntOrNull(row.llmCompletionTokens);
  const totalTokens = nonNegativeIntOrNull(row.llmTotalTokens);
  const startedAt = isoStringOrNull(row.llmStartedAt);
  const endedAt = isoStringOrNull(row.llmEndedAt);
  const durationMs = nonNegativeIntOrNull(row.llmDurationMs);
  if (
    promptTokens == null &&
    completionTokens == null &&
    totalTokens == null &&
    startedAt == null &&
    endedAt == null &&
    durationMs == null
  ) {
    return null;
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    startedAt,
    endedAt,
    durationMs,
  };
}

function messageToRow(m, seq) {
  const msg = m && typeof m === "object" ? m : {};
  const role = String(/** @type {{ role?: string }} */ (msg).role || "");
  let contentJson: string | null = null;
  if ("content" in msg && msg.content !== undefined && msg.content !== null) {
    contentJson = JSON.stringify(redactContentForStorage(/** @type {unknown} */ (msg.content)));
  }
  let toolCallsJson: string | null = null;
  const tcs = /** @type {{ tool_calls?: unknown[] }} */ (msg).tool_calls;
  if (Array.isArray(tcs) && tcs.length > 0) {
    toolCallsJson = JSON.stringify(tcs);
  }
  const toolCallId = /** @type {{ tool_call_id?: string }} */ (msg).tool_call_id;
  const name = /** @type {{ name?: string }} */ (msg).name;
  const assistantDecision = role === "assistant" ? extractAssistantDecision(msg.content) : null;
  return {
    seq,
    role,
    content_json: contentJson,
    tool_calls_json: toolCallsJson,
    tool_call_id: toolCallId != null ? String(toolCallId) : null,
    name: name != null ? String(name) : null,
    assistant_decision: assistantDecision,
  };
}

async function persistAgentBarTurn(row) {
  const db = getDb();
  const encBefore = row.exchangeContext != null ? JSON.stringify(row.exchangeContext) : null;
  const encAfter = row.exchangeAfter != null ? JSON.stringify(row.exchangeAfter) : null;
  const encToolTrace = Array.isArray(row.toolTrace) ? JSON.stringify(row.toolTrace) : null;
  let pngBuf: Buffer | null = null;
  if (row.chartBase64 && typeof row.chartBase64 === "string" && row.chartBase64.length > 0) {
    try {
      pngBuf = Buffer.from(row.chartBase64, "base64");
    } catch {
      pngBuf = null;
    }
  }
  const barCloseId = String(row.barCloseId || "");
  const systemPrompt =
    row.systemPrompt != null && String(row.systemPrompt).trim() !== ""
      ? String(row.systemPrompt)
      : null;
  const assistantDecision = row.assistantDecision || extractAssistantDecision(row.assistantText);

  const messagesRaw = Array.isArray(row.messagesOut) ? row.messagesOut : [];
  const messageRows = messagesRaw.map((m, i) => messageToRow(m, i));

  const updatedAt = new Date().toISOString();
  const rowRecord = row && typeof row === "object" ? (row as Record<string, unknown>) : {};

  await db.transaction(async (tx) => {
    await tx.insert(agentSessions).values({
      barCloseId,
      tvSymbol: String(row.tvSymbol || ""),
      interval: String(row.interval || ""),
      periodLabel: String(row.periodLabel || ""),
      capturedAt: String(row.capturedAt || ""),
      textForLlm: String(row.textForLlm || ""),
      llmUserFullText: String(row.llmUserFullText || ""),
      exchangeContextJson: encBefore,
      chartMime: row.chartMime != null ? String(row.chartMime) : null,
      chartPng: pngBuf,
      chartCaptureError:
        row.chartCaptureError != null && String(row.chartCaptureError).trim() !== ""
          ? String(row.chartCaptureError)
          : null,
      assistantText: row.assistantText != null ? String(row.assistantText) : null,
      cardSummary:
        row.cardSummary != null && String(row.cardSummary).trim() !== "" ? String(row.cardSummary) : null,
      toolTraceJson: encToolTrace,
      exchangeAfterJson: encAfter,
      agentOk: row.agentOk !== false ? 1 : 0,
      agentError:
        row.agentError != null && String(row.agentError).trim() !== "" ? String(row.agentError) : null,
      estimatedPromptTokens: null,
      contextWindowTokens: null,
      llmPromptTokens: nonNegativeIntOrNull(metricValue(rowRecord, "promptTokens")),
      llmCompletionTokens: nonNegativeIntOrNull(metricValue(rowRecord, "completionTokens")),
      llmTotalTokens: nonNegativeIntOrNull(metricValue(rowRecord, "totalTokens")),
      llmStartedAt: isoStringOrNull(metricValue(rowRecord, "startedAt")),
      llmEndedAt: isoStringOrNull(metricValue(rowRecord, "endedAt")),
      llmDurationMs: nonNegativeIntOrNull(metricValue(rowRecord, "durationMs")),
      updatedAt,
      systemPromptText: systemPrompt,
      assistantReasoningText:
        row.assistantReasoningText != null && String(row.assistantReasoningText).trim() !== ""
          ? String(row.assistantReasoningText)
          : null,
      assistantDecision,
    });

    for (const mr of messageRows) {
      await tx.insert(agentSessionMessages).values({
        barCloseId,
        seq: mr.seq,
        role: mr.role,
        contentJson: mr.content_json,
        toolCallsJson: mr.tool_calls_json,
        toolCallId: mr.tool_call_id,
        name: mr.name,
        assistantDecision: mr.assistant_decision,
      });
    }
  });
}

async function listAgentBarTurnsPage(args: Record<string, unknown> = {}) {
  const tvSymbol = String(args.tvSymbol || "").trim();
  const interval = String(args.interval || "").trim();
  const limit = Math.min(100, Math.max(1, Math.floor(Number(args.limit) || 20)));
  const cursorRaw =
    args.cursor && typeof args.cursor === "object" && !Array.isArray(args.cursor)
      ? (args.cursor as Record<string, unknown>)
      : null;

  if (!tvSymbol || !interval) {
    return { rows: [], nextCursor: null, hasMore: false };
  }

  const cap =
    cursorRaw &&
    typeof cursorRaw.capturedAt === "string" &&
    typeof cursorRaw.barCloseId === "string"
      ? {
          capturedAt: cursorRaw.capturedAt.trim(),
          barCloseId: cursorRaw.barCloseId.trim(),
        }
      : null;

  const db = getDb();

  const hasChartSql = sql<number>`CASE WHEN ${agentSessions.chartPng} IS NOT NULL AND LENGTH(${agentSessions.chartPng}) > 0 THEN 1 ELSE 0 END`;

  const whereClause =
    cap && cap.capturedAt && cap.barCloseId
      ? and(
          eq(agentSessions.tvSymbol, tvSymbol),
          eq(agentSessions.interval, interval),
          or(
            lt(agentSessions.capturedAt, cap.capturedAt),
            and(
              eq(agentSessions.capturedAt, cap.capturedAt),
              lt(agentSessions.barCloseId, cap.barCloseId),
            ),
          ),
        )
      : and(eq(agentSessions.tvSymbol, tvSymbol), eq(agentSessions.interval, interval));

  const raw = await db
    .select({
      barCloseId: agentSessions.barCloseId,
      tvSymbol: agentSessions.tvSymbol,
      interval: agentSessions.interval,
      periodLabel: agentSessions.periodLabel,
      capturedAt: agentSessions.capturedAt,
      textForLlm: agentSessions.textForLlm,
      llmUserFullText: agentSessions.llmUserFullText,
      exchangeContextJson: agentSessions.exchangeContextJson,
      chartMime: agentSessions.chartMime,
      chartCaptureError: agentSessions.chartCaptureError,
      assistantText: agentSessions.assistantText,
      cardSummary: agentSessions.cardSummary,
      toolTraceJson: agentSessions.toolTraceJson,
      exchangeAfterJson: agentSessions.exchangeAfterJson,
      agentOk: agentSessions.agentOk,
      agentError: agentSessions.agentError,
      assistantReasoningText: agentSessions.assistantReasoningText,
      assistantDecision: agentSessions.assistantDecision,
      has_chart: hasChartSql,
    })
    .from(agentSessions)
    .where(whereClause)
    .orderBy(desc(agentSessions.capturedAt), desc(agentSessions.barCloseId))
    .limit(limit);

  const rows = raw.map((r) => {
    let toolTrace: unknown[] | null = null;
    if (typeof r.toolTraceJson === "string" && r.toolTraceJson.trim()) {
      try {
        const parsed = JSON.parse(r.toolTraceJson);
        toolTrace = Array.isArray(parsed) ? parsed : null;
      } catch {
        toolTrace = null;
      }
    }
    return {
      barCloseId: r.barCloseId,
      tvSymbol: r.tvSymbol,
      interval: r.interval,
      periodLabel: r.periodLabel,
      capturedAt: r.capturedAt,
      textForLlm: r.textForLlm,
      llmUserFullText: r.llmUserFullText,
      hasChart: Number(r.has_chart) === 1,
      chartMime: r.chartMime,
      chartCaptureError: r.chartCaptureError,
      assistantText: r.assistantText,
      assistantReasoningText:
        r.assistantReasoningText != null && String(r.assistantReasoningText).trim()
          ? String(r.assistantReasoningText).trim()
          : null,
      assistantDecision:
        r.assistantDecision != null && String(r.assistantDecision).trim() ? String(r.assistantDecision) : null,
      cardSummary: r.cardSummary != null && String(r.cardSummary).trim() ? String(r.cardSummary) : null,
      toolTrace,
      agentOk: Number(r.agentOk) === 1,
      agentError: r.agentError,
    };
  });

  const hasMore = rows.length === limit;
  const tail = rows[rows.length - 1];
  const nextCursor =
    hasMore && tail ? { capturedAt: tail.capturedAt, barCloseId: tail.barCloseId } : null;

  return { rows, nextCursor, hasMore };
}

async function getAgentBarTurnChart(barCloseId) {
  const id = String(barCloseId || "").trim();
  if (!id) return null;
  const db = getDb();
  const rows = await db
    .select({
      chartMime: agentSessions.chartMime,
      chartPng: agentSessions.chartPng,
    })
    .from(agentSessions)
    .where(eq(agentSessions.barCloseId, id))
    .limit(1);
  const row = rows[0];
  if (!row || !row.chartPng) return null;
  const mime = typeof row.chartMime === "string" && row.chartMime.trim() ? row.chartMime : "image/png";
  const bufUnknown = row.chartPng as unknown;
  let b64: string;
  if (Buffer.isBuffer(bufUnknown)) {
    b64 = bufUnknown.toString("base64");
  } else if (bufUnknown instanceof Uint8Array) {
    b64 = Buffer.from(bufUnknown).toString("base64");
  } else {
    b64 = Buffer.from(String(bufUnknown)).toString("base64");
  }
  return { mimeType: mime, base64: b64, dataUrl: `data:${mime};base64,${b64}` };
}

async function getAgentSessionMessages(barCloseId) {
  const id = String(barCloseId || "").trim();
  if (!id) return { messages: [], assistantReasoningText: null, assistantDecision: null, metrics: null };
  const db = getDb();
  const reasoningRows = await db
    .select({
      assistantReasoningText: agentSessions.assistantReasoningText,
      assistantDecision: agentSessions.assistantDecision,
      llmPromptTokens: agentSessions.llmPromptTokens,
      llmCompletionTokens: agentSessions.llmCompletionTokens,
      llmTotalTokens: agentSessions.llmTotalTokens,
      llmStartedAt: agentSessions.llmStartedAt,
      llmEndedAt: agentSessions.llmEndedAt,
      llmDurationMs: agentSessions.llmDurationMs,
    })
    .from(agentSessions)
    .where(eq(agentSessions.barCloseId, id))
    .limit(1);
  const reasoningRow = reasoningRows[0];
  let assistantReasoningText: string | null = null;
  let assistantDecision: string | null = null;
  if (
    reasoningRow &&
    reasoningRow.assistantReasoningText != null &&
    String(reasoningRow.assistantReasoningText).trim()
  ) {
    assistantReasoningText = String(reasoningRow.assistantReasoningText).trim();
  }
  if (reasoningRow && reasoningRow.assistantDecision != null && String(reasoningRow.assistantDecision).trim()) {
    assistantDecision = String(reasoningRow.assistantDecision).trim();
  }
  const metrics = reasoningRow ? buildSessionMetrics(reasoningRow) : null;
  const raw = await db
    .select({
      seq: agentSessionMessages.seq,
      role: agentSessionMessages.role,
      contentJson: agentSessionMessages.contentJson,
      toolCallsJson: agentSessionMessages.toolCallsJson,
      toolCallId: agentSessionMessages.toolCallId,
      name: agentSessionMessages.name,
      assistantDecision: agentSessionMessages.assistantDecision,
    })
    .from(agentSessionMessages)
    .where(eq(agentSessionMessages.barCloseId, id))
    .orderBy(asc(agentSessionMessages.seq));
  const messages = raw.map((r) => {
    let content: unknown = null;
    if (typeof r.contentJson === "string" && r.contentJson.length > 0) {
      try {
        content = JSON.parse(r.contentJson);
      } catch {
        content = r.contentJson;
      }
    }
    let toolCalls: unknown[] | null = null;
    if (typeof r.toolCallsJson === "string" && r.toolCallsJson.trim()) {
      try {
        const p = JSON.parse(r.toolCallsJson);
        toolCalls = Array.isArray(p) ? p : null;
      } catch {
        toolCalls = null;
      }
    }
    return {
      seq: r.seq,
      role: String(r.role || ""),
      content,
      toolCalls,
      toolCallId: r.toolCallId != null ? String(r.toolCallId) : null,
      name: r.name != null ? String(r.name) : null,
      assistantDecision:
        r.assistantDecision != null && String(r.assistantDecision).trim() ? String(r.assistantDecision) : null,
    };
  });
  return { messages, assistantReasoningText, assistantDecision, metrics };
}

function safeJsonParse(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function holdingStateFromExchangeAfter(exchangeAfter) {
  const pos = exchangeAfter && typeof exchangeAfter === "object" ? exchangeAfter.position : null;
  if (!pos || typeof pos !== "object" || pos.hasPosition !== true) return "空仓";
  if (pos.posSide === "long") return "持多";
  if (pos.posSide === "short") return "持空";
  const n = Number(pos.posNum);
  if (Number.isFinite(n) && n > 0) return "持多";
  if (Number.isFinite(n) && n < 0) return "持空";
  return "持仓";
}

function summarizeToolTrace(toolTrace) {
  if (!Array.isArray(toolTrace) || toolTrace.length === 0) return "无工具动作";
  const names: string[] = [];
  for (const item of toolTrace) {
    if (!item || typeof item !== "object") continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) continue;
    const ok = item.result && typeof item.result === "object" ? item.result.ok === true : false;
    names.push(ok ? name : `${name}(失败)`);
  }
  return names.length ? names.join(" -> ") : "无工具动作";
}

async function listRecentAgentMemories(args: Record<string, unknown> = {}) {
  const tvSymbol = String(args.tvSymbol || "").trim();
  const interval = String(args.interval || "").trim();
  const limit = Math.min(20, Math.max(1, Math.floor(Number(args.limit) || 6)));
  if (!tvSymbol || !interval) return [];

  const db = getDb();
  const rows = await db
    .select({
      barCloseId: agentSessions.barCloseId,
      capturedAt: agentSessions.capturedAt,
      assistantText: agentSessions.assistantText,
      cardSummary: agentSessions.cardSummary,
      toolTraceJson: agentSessions.toolTraceJson,
      exchangeAfterJson: agentSessions.exchangeAfterJson,
      agentOk: agentSessions.agentOk,
      agentError: agentSessions.agentError,
    })
    .from(agentSessions)
    .where(and(eq(agentSessions.tvSymbol, tvSymbol), eq(agentSessions.interval, interval)))
    .orderBy(desc(agentSessions.capturedAt), desc(agentSessions.barCloseId))
    .limit(limit);

  return rows.map((row) => {
    const toolTrace = safeJsonParse(row.toolTraceJson);
    const exchangeAfter = safeJsonParse(row.exchangeAfterJson);
    return {
      barCloseId: String(row.barCloseId || ""),
      capturedAt: String(row.capturedAt || ""),
      agentOk: Number(row.agentOk) === 1,
      agentError: row.agentError != null ? String(row.agentError) : null,
      assistantText: row.assistantText != null ? String(row.assistantText) : null,
      cardSummary: row.cardSummary != null ? String(row.cardSummary) : null,
      toolTrace: Array.isArray(toolTrace) ? toolTrace : [],
      exchangeAfter,
      holdingState: holdingStateFromExchangeAfter(exchangeAfter),
      toolSummary: summarizeToolTrace(toolTrace),
    };
  });
}

export {
  persistAgentBarTurn,
  listAgentBarTurnsPage,
  getAgentBarTurnChart,
  getAgentSessionMessages,
  listRecentAgentMemories,
  redactContentForStorage,
};
