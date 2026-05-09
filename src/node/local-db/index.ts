/**
 * 本地持久化（MySQL 5.7）
 *
 * - 连接串由环境变量 `MYSQL_*` 提供；启动时由 `initDatabase()` 建连并执行 `drizzle` 迁移。
 * - 通用 KV：`kv_store(namespace, key)`，应用设置存 `app/settings`。
 */
import { and, eq } from "drizzle-orm";

import {
  closeDatabase,
  getDb,
  getMysqlEnv,
  initDatabase,
  mysqlConnectionLabel,
} from "../db/client.js";
import { kvStore } from "../db/schema.js";

export { closeDatabase, getDb, getMysqlEnv, initDatabase, mysqlConnectionLabel };

const KV_NS_APP = "app";
const KV_KEY_SETTINGS = "settings";

/** @deprecated 历史为 SQLite 路径；现返回 `host:port/database` 摘要 */
function databasePath() {
  return mysqlConnectionLabel();
}

function nowDbString() {
  return new Date().toISOString();
}

async function kvGet(namespace: string, key: string): Promise<unknown> {
  const db = getDb();
  const rows = await db
    .select({ value: kvStore.value })
    .from(kvStore)
    .where(and(eq(kvStore.namespace, namespace), eq(kvStore.key, key)))
    .limit(1);
  const row = rows[0];
  return row ? row.value : null;
}

async function kvSet(namespace: string, key: string, value: string): Promise<void> {
  const db = getDb();
  const updatedAt = nowDbString();
  await db
    .insert(kvStore)
    .values({ namespace, key, value, updatedAt })
    .onDuplicateKeyUpdate({
      set: { value, updatedAt },
    });
}

async function kvHas(namespace: string, key: string): Promise<boolean> {
  const row = await kvGet(namespace, key);
  return row != null;
}

export { KV_NS_APP, KV_KEY_SETTINGS, databasePath, kvGet, kvSet, kvHas };
