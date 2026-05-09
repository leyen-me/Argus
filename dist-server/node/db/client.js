/**
 * MySQL 连接池与 Drizzle 实例；启动时须先调用 {@link initDatabase}。
 */
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import fs from "node:fs";
import mysql from "mysql2/promise";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function readMysqlEnv() {
    const host = (process.env.MYSQL_HOST || "127.0.0.1").trim() || "127.0.0.1";
    const port = Number(process.env.MYSQL_PORT || 3306);
    const user = (process.env.MYSQL_USER || "root").trim() || "root";
    const password = process.env.MYSQL_PASSWORD ?? "";
    const database = (process.env.MYSQL_DATABASE || "argus").trim() || "argus";
    return { host, port, user, password, database };
}
let pool = null;
let db = null;
let initPromise = null;
let closePromise = null;
export function getMysqlEnv() {
    return readMysqlEnv();
}
export function mysqlConnectionLabel() {
    const e = readMysqlEnv();
    return `${e.host}:${e.port}/${e.database}`;
}
export function getDb() {
    if (!db) {
        throw new Error("[Argus] 数据库未初始化：请先 await initDatabase()");
    }
    return db;
}
/**
 * 幂等：可多次 await，仅首次执行连接与迁移。
 */
export function initDatabase() {
    if (initPromise)
        return initPromise;
    initPromise = (async () => {
        const env = readMysqlEnv();
        pool = mysql.createPool({
            host: env.host,
            port: env.port,
            user: env.user,
            password: env.password,
            database: env.database,
            waitForConnections: true,
            connectionLimit: 10,
            timezone: "Z",
        });
        const drizzleDb = drizzle(pool, { schema, mode: "default" });
        db = drizzleDb;
        const migrationsFolder = path.join(__dirname, "..", "..", "..", "drizzle");
        if (!fs.existsSync(migrationsFolder)) {
            throw new Error(`[Argus] 迁移目录不存在：${migrationsFolder}`);
        }
        await migrate(drizzleDb, { migrationsFolder });
    })();
    return initPromise;
}
export async function closeDatabase() {
    if (closePromise)
        return closePromise;
    const poolToClose = pool;
    initPromise = null;
    db = null;
    pool = null;
    if (!poolToClose)
        return;
    closePromise = poolToClose
        .end()
        .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e ?? "");
        // `SIGINT` 可能被重复触发；连接池已关闭时静默跳过即可。
        if (/closed state/i.test(msg))
            return;
        throw e;
    })
        .finally(() => {
        closePromise = null;
    });
    await closePromise;
}
//# sourceMappingURL=client.js.map