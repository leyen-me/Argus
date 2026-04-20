/**
 * 本地持久化（SQLite）
 *
 * 设计要点：
 * - 单库文件位于仓库根目录、与 `src` 同级：`argus.sqlite`（WAL 模式）。
 * - 版本用 PRAGMA user_version；升级时在 applyMigrations() 中按版本递增追加 DDL。
 * - 通用键值：`kv_store(namespace, key)`，适合配置、功能开关、缓存等；值一般为 JSON 文本。
 * - `agent_bar_turns`：每根 K 线收盘 Agent 单轮的完整用户提示、OKX 快照 JSON、图表 BLOB、助手输出等（user_version ≥ 3）。
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
