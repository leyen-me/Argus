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

module.exports = {
  persistAgentBarTurn,
};
