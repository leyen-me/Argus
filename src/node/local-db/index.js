/**
 * 本地持久化（SQLite）
 *
 * 设计要点：
 * - 单库文件位于 userData/argus.sqlite，WAL 模式。
 * - 版本用 PRAGMA user_version；升级时在 applyMigrations() 中按版本递增追加 DDL。
 * - 通用键值：`kv_store(namespace, key)`，适合配置、功能开关、缓存等；值一般为 JSON 文本。
 * - 后续若有强关系数据（成交记录、审计日志等），在同一库中新建表并增加 user_version 迁移即可，
 *   与 kv 并存；业务代码可放在独立模块中，仅依赖本文件导出的 `getDatabase()`。
 *
 * 约定命名空间（namespace）示例：
 * - app — 应用级；键 `settings` 存可序列化的应用设置（不含运行时注入的 systemPromptCrypto 正文）。
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { app } = require("electron");

/** @type {import("better-sqlite3").Database | null} */
let _db = null;

const KV_NS_APP = "app";
const KV_KEY_SETTINGS = "settings";

function databasePath() {
  return path.join(app.getPath("userData"), "argus.sqlite");
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
  }
}

/**
 * 打开数据库（懒加载）。须在 Electron app 已可解析 userData 路径之后调用。
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
