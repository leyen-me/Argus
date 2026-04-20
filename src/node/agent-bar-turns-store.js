/**
 * 每根 K 线收盘 Agent 单轮：完整用户提示（含 OKX 快照）与图表落库（SQLite）。
 */
const { getDatabase } = require("./local-db");

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
 * @param {object | null} [row.exchangeAfter]
 * @param {boolean} [row.agentOk]
 * @param {string | null} [row.agentError]
 * @param {{ estimatedPromptTokens?: number, contextWindowTokens?: number } | null} [row.usage]
 */
function persistAgentBarTurn(row) {
  const db = getDatabase();
  const encBefore = row.exchangeContext != null ? JSON.stringify(row.exchangeContext) : null;
  const encAfter = row.exchangeAfter != null ? JSON.stringify(row.exchangeAfter) : null;
  let pngBuf = null;
  if (row.chartBase64 && typeof row.chartBase64 === "string" && row.chartBase64.length > 0) {
    try {
      pngBuf = Buffer.from(row.chartBase64, "base64");
    } catch {
      pngBuf = null;
    }
  }
  const stmt = db.prepare(`
    INSERT INTO agent_bar_turns (
      bar_close_id, tv_symbol, interval, period_label, captured_at,
      text_for_llm, llm_user_full_text, exchange_context_json,
      chart_mime, chart_png, chart_capture_error,
      assistant_text, exchange_after_json, agent_ok, agent_error,
      estimated_prompt_tokens, context_window_tokens, updated_at
    ) VALUES (
      @bar_close_id, @tv_symbol, @interval, @period_label, @captured_at,
      @text_for_llm, @llm_user_full_text, @exchange_context_json,
      @chart_mime, @chart_png, @chart_capture_error,
      @assistant_text, @exchange_after_json, @agent_ok, @agent_error,
      @estimated_prompt_tokens, @context_window_tokens, datetime('now')
    )
  `);
  stmt.run({
    bar_close_id: String(row.barCloseId || ""),
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
    exchange_after_json: encAfter,
    agent_ok: row.agentOk !== false ? 1 : 0,
    agent_error:
      row.agentError != null && String(row.agentError).trim() !== "" ? String(row.agentError) : null,
    estimated_prompt_tokens:
      row.usage && Number.isFinite(Number(row.usage.estimatedPromptTokens))
        ? Math.floor(Number(row.usage.estimatedPromptTokens))
        : null,
    context_window_tokens:
      row.usage && Number.isFinite(Number(row.usage.contextWindowTokens))
        ? Math.floor(Number(row.usage.contextWindowTokens))
        : null,
  });
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
      assistant_text, exchange_after_json, agent_ok, agent_error,
      estimated_prompt_tokens, context_window_tokens,
      CASE WHEN chart_png IS NOT NULL AND length(chart_png) > 0 THEN 1 ELSE 0 END AS has_chart
    FROM agent_bar_turns
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
  const rows = raw.map((r) => ({
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
    agentOk: r.agent_ok === 1,
    agentError: r.agent_error,
    estimatedPromptTokens: r.estimated_prompt_tokens,
    contextWindowTokens: r.context_window_tokens,
  }));

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
    .prepare(`SELECT chart_mime, chart_png FROM agent_bar_turns WHERE bar_close_id = ?`)
    .get(id);
  if (!row || !row.chart_png) return null;
  const mime = typeof row.chart_mime === "string" && row.chart_mime.trim() ? row.chart_mime : "image/png";
  const buf = row.chart_png;
  const b64 = Buffer.isBuffer(buf) ? buf.toString("base64") : Buffer.from(buf).toString("base64");
  return { mimeType: mime, base64: b64, dataUrl: `data:${mime};base64,${b64}` };
}

module.exports = {
  persistAgentBarTurn,
  listAgentBarTurnsPage,
  getAgentBarTurnChart,
};
