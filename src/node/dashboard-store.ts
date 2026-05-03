import { getDatabase } from "./local-db/index.js";

type EquitySampleLastRow = { captured_at?: string; equity_usdt?: unknown };
type EquitySampleRow = { t?: unknown; equity?: unknown };

const MAX_ROWS = 2500;
const DEDUP_EPS = 1e-6;
const DEDUP_MIN_MS = 120_000;

/**
 * 在权益变化或距上次采样超过阈值时写入，避免刷新过于密集。
 * @param {number} equityUsdt
 */
function appendEquitySampleIfNeeded(equityUsdt) {
  if (!Number.isFinite(equityUsdt) || equityUsdt < 0) return;
  const db = getDatabase();
  const last = db
    .prepare(
      `SELECT equity_usdt, captured_at FROM dashboard_equity_samples ORDER BY id DESC LIMIT 1`,
    )
    .get() as EquitySampleLastRow | undefined;
  const now = Date.now();
  if (last && typeof last.captured_at === "string") {
    const lastMs = Date.parse(last.captured_at);
    const lastEq = Number(last.equity_usdt);
    const same = Number.isFinite(lastEq) && Math.abs(lastEq - equityUsdt) < DEDUP_EPS;
    if (same && Number.isFinite(lastMs) && now - lastMs < DEDUP_MIN_MS) return;
  }
  const iso = new Date(now).toISOString();
  db.prepare(
    `INSERT INTO dashboard_equity_samples (captured_at, equity_usdt) VALUES (?, ?)`,
  ).run(iso, equityUsdt);
  pruneOldSamples(db);
}

/**
 * @param {number} [limit=400]
 * @returns {{ t: string, equity: number }[]}
 */
function listRecentEquitySamples(limit = 400) {
  const n = Math.min(2000, Math.max(1, Math.floor(limit)));
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT captured_at AS t, equity_usdt AS equity
       FROM dashboard_equity_samples
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(n) as EquitySampleRow[];
  return rows
    .map((r) => ({
      t: String(r.t || ""),
      equity: Number(r.equity),
    }))
    .filter((r) => r.t && Number.isFinite(r.equity))
    .reverse();
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function pruneOldSamples(db) {
  const c = db.prepare(`SELECT COUNT(*) AS n FROM dashboard_equity_samples`).get();
  const n = c && typeof c.n === "number" ? c.n : 0;
  if (n <= MAX_ROWS) return;
  const del = n - MAX_ROWS;
  db.prepare(
    `DELETE FROM dashboard_equity_samples WHERE id IN (
       SELECT id FROM dashboard_equity_samples ORDER BY id ASC LIMIT ?
     )`,
  ).run(del);
}

export { appendEquitySampleIfNeeded, listRecentEquitySamples };
