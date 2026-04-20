/**
 * 本地持久化（SQLite）
 *
 * 设计要点：
 * - 单库文件位于仓库根目录、与 `src` 同级：`argus.sqlite`（WAL 模式）。
 * - 版本用 PRAGMA user_version；升级时在 applyMigrations() 中按版本递增追加 DDL。
 * - 通用键值：`kv_store(namespace, key)`，适合配置、功能开关、缓存等；值一般为 JSON 文本。
 * - `agent_bar_turns`：历史表（user_version ≥ 3）；v6 起新数据写入 `agent_sessions` + `agent_session_messages`，旧行由迁移复制到 `agent_sessions`。
 * - `agent_sessions` / `agent_session_messages`：收盘 Agent 会话与有序消息（user_version ≥ 6）。
 * - 其他强关系数据可在同一库中新建表并递增 user_version；业务模块仅依赖 `getDatabase()`。
 *
 * 约定命名空间（namespace）示例：
 * - app — 应用级；键 `settings` 存可序列化的应用设置（不含运行时注入的 systemPromptCrypto 正文）。
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

/** @type {import("better-sqlite3").Database | null} */
let _db = null;

const KV_NS_APP = "app";
const KV_KEY_SETTINGS = "settings";

function databasePath() {
  // 本文件在 src/node/local-db → 上级两级为仓库根（与 src 同级）
  return path.join(__dirname, "..", "..", "argus.sqlite");
}

function applyMigrations(database) {
  let v = database.pragma("user_version", { simple: true });
  if (v < 1) {
    database.exec(`
      CREATE TABLE kv_store (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (namespace, key)
      );
      CREATE INDEX idx_kv_namespace ON kv_store (namespace);
    `);
    database.pragma("user_version = 1");
    v = 1;
  }
  if (v < 2) {
    database.exec(`
      CREATE TABLE prompt_strategies (
        id TEXT NOT NULL PRIMARY KEY,
        label TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_prompt_strategies_sort ON prompt_strategies (sort_order, id);
    `);
    database.pragma("user_version = 2");
    v = 2;
  }
  if (v < 3) {
    database.exec(`
      CREATE TABLE agent_bar_turns (
        bar_close_id TEXT NOT NULL PRIMARY KEY,
        tv_symbol TEXT NOT NULL,
        interval TEXT NOT NULL,
        period_label TEXT NOT NULL DEFAULT '',
        captured_at TEXT NOT NULL,
        text_for_llm TEXT NOT NULL DEFAULT '',
        llm_user_full_text TEXT NOT NULL,
        exchange_context_json TEXT,
        chart_mime TEXT,
        chart_png BLOB,
        chart_capture_error TEXT,
        assistant_text TEXT,
        exchange_after_json TEXT,
        agent_ok INTEGER NOT NULL DEFAULT 0,
        agent_error TEXT,
        estimated_prompt_tokens INTEGER,
        context_window_tokens INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_agent_bar_turns_tv_captured ON agent_bar_turns (tv_symbol, captured_at DESC);
    `);
    database.pragma("user_version = 3");
    v = 3;
  }
  if (v < 4) {
    database.exec(`
      CREATE INDEX idx_agent_bar_turns_list ON agent_bar_turns (tv_symbol, interval, captured_at DESC, bar_close_id DESC);
      DROP INDEX IF EXISTS idx_agent_bar_turns_tv_captured;
    `);
    database.pragma("user_version = 4");
    v = 4;
  }
  if (v < 5) {
    database.exec(`
      ALTER TABLE agent_bar_turns ADD COLUMN tool_trace_json TEXT;
    `);
    database.pragma("user_version = 5");
    v = 5;
  }
  if (v < 6) {
    database.exec(`
      CREATE TABLE agent_sessions (
        bar_close_id TEXT NOT NULL PRIMARY KEY,
        tv_symbol TEXT NOT NULL,
        interval TEXT NOT NULL,
        period_label TEXT NOT NULL DEFAULT '',
        captured_at TEXT NOT NULL,
        text_for_llm TEXT NOT NULL DEFAULT '',
        llm_user_full_text TEXT NOT NULL,
        exchange_context_json TEXT,
        chart_mime TEXT,
        chart_png BLOB,
        chart_capture_error TEXT,
        assistant_text TEXT,
        tool_trace_json TEXT,
        exchange_after_json TEXT,
        agent_ok INTEGER NOT NULL DEFAULT 0,
        agent_error TEXT,
        estimated_prompt_tokens INTEGER,
        context_window_tokens INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        system_prompt_text TEXT
      );
      CREATE INDEX idx_agent_sessions_list ON agent_sessions (tv_symbol, interval, captured_at DESC, bar_close_id DESC);
      CREATE TABLE agent_session_messages (
        bar_close_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content_json TEXT,
        tool_calls_json TEXT,
        tool_call_id TEXT,
        name TEXT,
        PRIMARY KEY (bar_close_id, seq),
        FOREIGN KEY (bar_close_id) REFERENCES agent_sessions(bar_close_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_session_messages_bar ON agent_session_messages (bar_close_id);
    `);
    database.exec(`
      INSERT INTO agent_sessions (
        bar_close_id, tv_symbol, interval, period_label, captured_at,
        text_for_llm, llm_user_full_text, exchange_context_json,
        chart_mime, chart_png, chart_capture_error,
        assistant_text, tool_trace_json, exchange_after_json,
        agent_ok, agent_error, estimated_prompt_tokens, context_window_tokens, updated_at,
        system_prompt_text
      )
      SELECT
        bar_close_id, tv_symbol, interval, period_label, captured_at,
        text_for_llm, llm_user_full_text, exchange_context_json,
        chart_mime, chart_png, chart_capture_error,
        assistant_text, tool_trace_json, exchange_after_json,
        agent_ok, agent_error, estimated_prompt_tokens, context_window_tokens, updated_at,
        NULL
      FROM agent_bar_turns abt
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_sessions s WHERE s.bar_close_id = abt.bar_close_id
      );
    `);
    database.pragma("user_version = 6");
    backfillLegacyAgentSessionMessages(database);
  }
}

/**
 * 从旧列构造简易 message 行（无完整 system/assistant 工具链，仅便于列表外排查）。
 * @param {import("better-sqlite3").Database} database
 */
function backfillLegacyAgentSessionMessages(database) {
  const sessions = database
    .prepare(
      `SELECT s.bar_close_id, s.llm_user_full_text, s.assistant_text, s.tool_trace_json, s.agent_ok
       FROM agent_sessions s
       WHERE NOT EXISTS (
         SELECT 1 FROM agent_session_messages m WHERE m.bar_close_id = s.bar_close_id
       )`,
    )
    .all();
  const ins = database.prepare(`
    INSERT INTO agent_session_messages (
      bar_close_id, seq, role, content_json, tool_calls_json, tool_call_id, name
    ) VALUES (
      @bar_close_id, @seq, @role, @content_json, @tool_calls_json, @tool_call_id, @name
    )
  `);
  for (const row of sessions) {
    const barCloseId = String(row.bar_close_id || "");
    if (!barCloseId) continue;
    let seq = 0;
    ins.run({
      bar_close_id: barCloseId,
      seq: seq++,
      role: "user",
      content_json: JSON.stringify(String(row.llm_user_full_text || "")),
      tool_calls_json: null,
      tool_call_id: null,
      name: null,
    });
    const asst = row.assistant_text != null ? String(row.assistant_text).trim() : "";
    if (asst) {
      ins.run({
        bar_close_id: barCloseId,
        seq: seq++,
        role: "assistant",
        content_json: JSON.stringify(asst),
        tool_calls_json: null,
        tool_call_id: null,
        name: null,
      });
    }
    const rawTrace = row.tool_trace_json;
    if (typeof rawTrace !== "string" || !rawTrace.trim()) continue;
    let trace;
    try {
      trace = JSON.parse(rawTrace);
    } catch {
      continue;
    }
    if (!Array.isArray(trace)) continue;
    for (let i = 0; i < trace.length; i++) {
      const t = trace[i];
      const name = t && typeof t === "object" && t.name != null ? String(t.name) : "";
      const payload = t && typeof t === "object" && "result" in t ? t.result : null;
      const contentStr =
        typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
      ins.run({
        bar_close_id: barCloseId,
        seq: seq++,
        role: "tool",
        content_json: JSON.stringify(contentStr),
        tool_calls_json: null,
        tool_call_id: `legacy-${i}`,
        name: name || null,
      });
    }
  }
}

/**
 * 打开数据库（懒加载）。
 * @returns {import("better-sqlite3").Database}
 */
function getDatabase() {
  if (_db) return _db;
  const p = databasePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  _db = new Database(p);
  _db.pragma("journal_mode = WAL");
  applyMigrations(_db);
  return _db;
}

function kvGet(namespace, key) {
  const row = getDatabase()
    .prepare(`SELECT value FROM kv_store WHERE namespace = ? AND key = ?`)
    .get(namespace, key);
  return row ? row.value : null;
}

function kvSet(namespace, key, value) {
  getDatabase()
    .prepare(
      `INSERT INTO kv_store (namespace, key, value, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(namespace, key) DO UPDATE SET
         value = excluded.value,
         updated_at = datetime('now')`,
    )
    .run(namespace, key, value);
}

function kvHas(namespace, key) {
  const row = getDatabase()
    .prepare(`SELECT 1 AS ok FROM kv_store WHERE namespace = ? AND key = ? LIMIT 1`)
    .get(namespace, key);
  return !!row;
}

function closeDatabase() {
  if (_db) {
    try {
      _db.close();
    } catch {
      /* ignore */
    }
    _db = null;
  }
}

module.exports = {
  KV_NS_APP,
  KV_KEY_SETTINGS,
  databasePath,
  getDatabase,
  kvGet,
  kvSet,
  kvHas,
  closeDatabase,
};
