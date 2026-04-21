const { getDatabase } = require("./local-db");

const TRADE_TOOLS = new Set(["open_position", "close_position"]);

/**
 * @param {unknown} result tool_trace 条目的 result 字段
 * @returns {boolean | null} true/false 表示明确成功/失败，null 表示无法判断
 */
function parseToolOk(result) {
  if (result && typeof result === "object" && "ok" in result) {
    if (result.ok === true) return true;
    if (result.ok === false) return false;
  }
  return null;
}

/**
 * 聚合本应用 `agent_sessions.tool_trace` 中的开平仓工具结果（不含 preview 等）。
 * 不表示交易胜率，仅反映 Agent 工具返回值。
 *
 * @param {string | null} [sinceIso] 仅统计 `captured_at >= sinceIso` 的回合（换策略时可设新起点）
 */
function aggregateAgentToolStats(sinceIso) {
  const db = getDatabase();
  let sql = `
    SELECT tool_trace_json FROM agent_sessions
    WHERE tool_trace_json IS NOT NULL AND trim(tool_trace_json) != ''
  `;
  const params = [];
  if (sinceIso != null && typeof sinceIso === "string" && sinceIso.trim()) {
    const ts = Date.parse(sinceIso.trim());
    if (Number.isFinite(ts)) {
      sql += ` AND captured_at >= ?`;
      params.push(sinceIso.trim());
    }
  }

  const rows = db.prepare(sql).all(...params);
  const out = {
    openOk: 0,
    openFail: 0,
    closeOk: 0,
    closeFail: 0,
    sessionsWithTrace: rows.length,
  };

  for (const row of rows) {
    let trace;
    try {
      trace = JSON.parse(row.tool_trace_json);
    } catch {
      continue;
    }
    if (!Array.isArray(trace)) continue;
    for (const t of trace) {
      const name = t && typeof t === "object" && t.name != null ? String(t.name) : "";
      if (!TRADE_TOOLS.has(name)) continue;
      const result = t && typeof t === "object" && "result" in t ? t.result : undefined;
      const okFlag = parseToolOk(result);
      if (name === "open_position") {
        if (okFlag === true) out.openOk += 1;
        else if (okFlag === false) out.openFail += 1;
      } else if (name === "close_position") {
        if (okFlag === true) out.closeOk += 1;
        else if (okFlag === false) out.closeFail += 1;
      }
    }
  }
  return out;
}

module.exports = { aggregateAgentToolStats };
