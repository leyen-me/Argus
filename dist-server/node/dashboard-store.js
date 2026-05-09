import { asc, count, desc, inArray } from "drizzle-orm";
import { getDb } from "./db/client.js";
import { dashboardEquitySamples } from "./db/schema.js";
const MAX_ROWS = 2500;
const DEDUP_EPS = 1e-6;
const DEDUP_MIN_MS = 120_000;
/**
 * 在权益变化或距上次采样超过阈值时写入，避免刷新过于密集。
 */
async function appendEquitySampleIfNeeded(equityUsdt) {
    if (!Number.isFinite(equityUsdt) || equityUsdt < 0)
        return;
    const db = getDb();
    const rows = await db
        .select({
        equity_usdt: dashboardEquitySamples.equityUsdt,
        captured_at: dashboardEquitySamples.capturedAt,
    })
        .from(dashboardEquitySamples)
        .orderBy(desc(dashboardEquitySamples.id))
        .limit(1);
    const last = rows[0];
    const now = Date.now();
    if (last && typeof last.captured_at === "string") {
        const lastMs = Date.parse(last.captured_at);
        const lastEq = Number(last.equity_usdt);
        const same = Number.isFinite(lastEq) && Math.abs(lastEq - equityUsdt) < DEDUP_EPS;
        if (same && Number.isFinite(lastMs) && now - lastMs < DEDUP_MIN_MS)
            return;
    }
    const iso = new Date(now).toISOString();
    await db.insert(dashboardEquitySamples).values({
        capturedAt: iso,
        equityUsdt: equityUsdt,
    });
    await pruneOldSamples(db);
}
/**
 * @param {number} [limit=400]
 */
async function listRecentEquitySamples(limit = 400) {
    const n = Math.min(2000, Math.max(1, Math.floor(limit)));
    const db = getDb();
    const rows = await db
        .select({
        t: dashboardEquitySamples.capturedAt,
        equity: dashboardEquitySamples.equityUsdt,
    })
        .from(dashboardEquitySamples)
        .orderBy(desc(dashboardEquitySamples.id))
        .limit(n);
    return rows
        .map((r) => ({
        t: String(r.t || ""),
        equity: Number(r.equity),
    }))
        .filter((r) => r.t && Number.isFinite(r.equity))
        .reverse();
}
async function pruneOldSamples(db) {
    const [cntRow] = await db.select({ n: count() }).from(dashboardEquitySamples);
    const n = cntRow?.n ?? 0;
    if (n <= MAX_ROWS)
        return;
    const del = n - MAX_ROWS;
    const ids = await db
        .select({ id: dashboardEquitySamples.id })
        .from(dashboardEquitySamples)
        .orderBy(asc(dashboardEquitySamples.id))
        .limit(del);
    const idList = ids.map((r) => r.id);
    if (idList.length === 0)
        return;
    await db.delete(dashboardEquitySamples).where(inArray(dashboardEquitySamples.id, idList));
}
export { appendEquitySampleIfNeeded, listRecentEquitySamples };
//# sourceMappingURL=dashboard-store.js.map