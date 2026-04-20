/**
 * 每根 K 线收盘 Agent：`agent_sessions`（会话元数据 + 图）+ `agent_session_messages`（有序 API 消息，便于排查）。
 * 历史表 `agent_bar_turns` 仅迁移保留，新数据不再写入该表。
 */
const { getDatabase } = require("./local-db");

/**
 * 多模态 user 中的 data: 大图不落 messages 表，避免与 chart_png 重复；排查时对照 session 行。
 * @param {unknown} content
 * @returns {unknown}
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

/**
 * @param {unknown} m
 * @param {number} seq
 */
function messageToRow(m, seq) {
  const msg = m && typeof m === "object" ? m : {};
  const role = String(/** @type {{ role?: string }} */ (msg).role || "");
  let contentJson = null;
  if ("content" in msg && msg.content !== undefined && msg.content !== null) {
    contentJson = JSON.stringify(redactContentForStorage(/** @type {unknown} */ (msg.content)));
  }
  let toolCallsJson = null;
  const tcs = /** @type {{ tool_calls?: unknown[] }} */ (msg).tool_calls;
  if (Array.isArray(tcs) && tcs.length > 0) {
    toolCallsJson = JSON.stringify(tcs);
  }
  const toolCallId = /** @type {{ tool_call_id?: string }} */ (msg).tool_call_id;
  const name = /** @type {{ name?: string }} */ (msg).name;
  return {
    seq,
    role,
    content_json: contentJson,
    tool_calls_json: toolCallsJson,
    tool_call_id: toolCallId != null ? String(toolCallId) : null,
    name: name != null ? String(name) : null,
  };
}

/**
 * @param {object} row
 * @param {string} row.barCloseId
 * @param {string} row.tvSymbol
 * @param {string} row.interval
 * @param {string} [row.periodLabel]
 * @param {string} row.capturedAt
 * @param {string} row.textForLlm
 * @param {string} row.llmUserFullText
 * @param {object | null} [row.exchangeContext]
 * @param {string | null} [row.chartMime]
 * @param {string | null} [row.chartBase64] 裸 base64，无 data: 前缀
 * @param {string | null} [row.chartCaptureError]
 * @param {string | null} [row.assistantText]
 * @param {unknown[] | null} [row.toolTrace]
 * @param {object | null} [row.exchangeAfter]
 * @param {boolean} [row.agentOk]
 * @param {string | null} [row.agentError]
 * @param {string | null} [row.systemPrompt] 当次请求使用的 system 全文快照
 * @param {unknown[] | null} [row.messagesOut] runTradingAgentTurn 返回的完整 messages 线程
 */
function persistAgentBarTurn(row) {
  const db = getDatabase();
  const encBefore = row.exchangeContext != null ? JSON.stringify(row.exchangeContext) : null;
  const encAfter = row.exchangeAfter != null ? JSON.stringify(row.exchangeAfter) : null;
  const encToolTrace = Array.isArray(row.toolTrace) ? JSON.stringify(row.toolTrace) : null;
  let pngBuf = null;
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

  const messagesRaw = Array.isArray(row.messagesOut) ? row.messagesOut : [];
  const messageRows = messagesRaw.map((m, i) => messageToRow(m, i));

  const insertSession = db.prepare(`
    INSERT INTO agent_sessions (
      bar_close_id, tv_symbol, interval, period_label, captured_at,
      text_for_llm, llm_user_full_text, exchange_context_json,
      chart_mime, chart_png, chart_capture_error,
      assistant_text, tool_trace_json, exchange_after_json, agent_ok, agent_error,
      estimated_prompt_tokens, context_window_tokens, updated_at, system_prompt_text
    ) VALUES (
      @bar_close_id, @tv_symbol, @interval, @period_label, @captured_at,
      @text_for_llm, @llm_user_full_text, @exchange_context_json,
      @chart_mime, @chart_png, @chart_capture_error,
      @assistant_text, @tool_trace_json, @exchange_after_json, @agent_ok, @agent_error,
      @estimated_prompt_tokens, @context_window_tokens, datetime('now'), @system_prompt_text
    )
  `);
  const insertMsg = db.prepare(`
    INSERT INTO agent_session_messages (
      bar_close_id, seq, role, content_json, tool_calls_json, tool_call_id, name
    ) VALUES (
      @bar_close_id, @seq, @role, @content_json, @tool_calls_json, @tool_call_id, @name
    )
  `);

  const run = db.transaction(() => {
    insertSession.run({
      bar_close_id: barCloseId,
      tv_symbol: String(row.tvSymbol || ""),
      interval: String(row.interval || ""),
      period_label: String(row.periodLabel || ""),
      captured_at: String(row.capturedAt || ""),
      text_for_llm: String(row.textForLlm || ""),
      llm_user_full_text: String(row.llmUserFullText || ""),
      exchange_context_json: encBefore,
      chart_mime: row.chartMime != null ? String(row.chartMime) : null,
      chart_png: pngBuf,
      chart_capture_error:
        row.chartCaptureError != null && String(row.chartCaptureError).trim() !== ""
          ? String(row.chartCaptureError)
          : null,
      assistant_text: row.assistantText != null ? String(row.assistantText) : null,
      tool_trace_json: encToolTrace,
      exchange_after_json: encAfter,
      agent_ok: row.agentOk !== false ? 1 : 0,
      agent_error:
        row.agentError != null && String(row.agentError).trim() !== ""
          ? String(row.agentError)
          : null,
      estimated_prompt_tokens: null,
      context_window_tokens: null,
      system_prompt_text: systemPrompt,
    });
    for (const mr of messageRows) {
      insertMsg.run({
        bar_close_id: barCloseId,
        seq: mr.seq,
        role: mr.role,
        content_json: mr.content_json,
        tool_calls_json: mr.tool_calls_json,
        tool_call_id: mr.tool_call_id,
        name: mr.name,
      });
    }
  });
  run();
}

/**
 * 分页列出某品种+周期的收盘 Agent 记录；不含 chart_png，按时间倒序（最新在前）。
 * @param {object} [args]
 * @param {string} args.tvSymbol
 * @param {string} args.interval
 * @param {number} [args.limit=20]
 * @param {{ capturedAt: string, barCloseId: string } | null} [args.cursor] 上一页最后一条，用于加载更早的记录
 * @returns {{ rows: object[], nextCursor: { capturedAt: string, barCloseId: string } | null, hasMore: boolean }}
 */
function listAgentBarTurnsPage(args = {}) {
  const tvSymbol = String(args.tvSymbol || "").trim();
  const interval = String(args.interval || "").trim();
  const limit = Math.min(100, Math.max(1, Math.floor(Number(args.limit) || 20)));
  const cursor = args.cursor && typeof args.cursor === "object" ? args.cursor : null;

  if (!tvSymbol || !interval) {
    return { rows: [], nextCursor: null, hasMore: false };
  }

  const cap =
    cursor && typeof cursor.capturedAt === "string" && typeof cursor.barCloseId === "string"
      ? { capturedAt: cursor.capturedAt.trim(), barCloseId: cursor.barCloseId.trim() }
      : null;

  const db = getDatabase();
  let sql = `
    SELECT
      bar_close_id, tv_symbol, interval, period_label, captured_at,
      text_for_llm, llm_user_full_text, exchange_context_json,
      chart_mime, chart_capture_error,
      assistant_text, tool_trace_json, exchange_after_json, agent_ok, agent_error,
      CASE WHEN chart_png IS NOT NULL AND length(chart_png) > 0 THEN 1 ELSE 0 END AS has_chart
    FROM agent_sessions
    WHERE tv_symbol = ? AND interval = ?
  `;
  /** @type {(string | number)[]} */
  const params = [tvSymbol, interval];

  if (cap && cap.capturedAt && cap.barCloseId) {
    sql += ` AND (captured_at < ? OR (captured_at = ? AND bar_close_id < ?))`;
    params.push(cap.capturedAt, cap.capturedAt, cap.barCloseId);
  }

  sql += ` ORDER BY captured_at DESC, bar_close_id DESC LIMIT ?`;
  params.push(limit);

  const raw = db.prepare(sql).all(...params);
  const rows = raw.map((r) => {
    let toolTrace = null;
    if (typeof r.tool_trace_json === "string" && r.tool_trace_json.trim()) {
      try {
        const parsed = JSON.parse(r.tool_trace_json);
        toolTrace = Array.isArray(parsed) ? parsed : null;
      } catch {
        toolTrace = null;
      }
    }
    return {
      barCloseId: r.bar_close_id,
      tvSymbol: r.tv_symbol,
      interval: r.interval,
      periodLabel: r.period_label,
      capturedAt: r.captured_at,
      textForLlm: r.text_for_llm,
      llmUserFullText: r.llm_user_full_text,
      hasChart: r.has_chart === 1,
      chartMime: r.chart_mime,
      chartCaptureError: r.chart_capture_error,
      assistantText: r.assistant_text,
      toolTrace,
      agentOk: r.agent_ok === 1,
      agentError: r.agent_error,
    };
  });

  const hasMore = rows.length === limit;
  const tail = rows[rows.length - 1];
  const nextCursor =
    hasMore && tail ? { capturedAt: tail.capturedAt, barCloseId: tail.barCloseId } : null;

  return { rows, nextCursor, hasMore };
}

/**
 * @param {string} barCloseId
 * @returns {{ mimeType: string, base64: string, dataUrl: string } | null}
 */
function getAgentBarTurnChart(barCloseId) {
  const id = String(barCloseId || "").trim();
  if (!id) return null;
  const row = getDatabase()
    .prepare(`SELECT chart_mime, chart_png FROM agent_sessions WHERE bar_close_id = ?`)
    .get(id);
  if (!row || !row.chart_png) return null;
  const mime = typeof row.chart_mime === "string" && row.chart_mime.trim() ? row.chart_mime : "image/png";
  const buf = row.chart_png;
  const b64 = Buffer.isBuffer(buf) ? buf.toString("base64") : Buffer.from(buf).toString("base64");
  return { mimeType: mime, base64: b64, dataUrl: `data:${mime};base64,${b64}` };
}

/**
 * 按 seq 返回当次会话的 API 消息行（content / tool_calls 已 JSON 解析），用于排查。
 * @param {string} barCloseId
 * @returns {Array<{
 *   seq: number,
 *   role: string,
 *   content: unknown,
 *   toolCalls: unknown[] | null,
 *   toolCallId: string | null,
 *   name: string | null,
 * }>}
 */
function getAgentSessionMessages(barCloseId) {
  const id = String(barCloseId || "").trim();
  if (!id) return [];
  const db = getDatabase();
  const raw = db
    .prepare(
      `SELECT seq, role, content_json, tool_calls_json, tool_call_id, name
       FROM agent_session_messages WHERE bar_close_id = ? ORDER BY seq ASC`,
    )
    .all(id);
  return raw.map((r) => {
    let content = null;
    if (typeof r.content_json === "string" && r.content_json.length > 0) {
      try {
        content = JSON.parse(r.content_json);
      } catch {
        content = r.content_json;
      }
    }
    let toolCalls = null;
    if (typeof r.tool_calls_json === "string" && r.tool_calls_json.trim()) {
      try {
        const p = JSON.parse(r.tool_calls_json);
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
      toolCallId: r.tool_call_id != null ? String(r.tool_call_id) : null,
      name: r.name != null ? String(r.name) : null,
    };
  });
}

module.exports = {
  persistAgentBarTurn,
  listAgentBarTurnsPage,
  getAgentBarTurnChart,
  getAgentSessionMessages,
  redactContentForStorage,
};
