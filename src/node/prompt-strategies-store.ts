// @ts-nocheck — 策略表行映射保持宽松。
import * as localDb from "./local-db/index.js";

const DEFAULT_PROMPT_STRATEGY = "default";

const ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** 仅占打开数据库 Side Effect；不向 `prompt_strategies` 写入任何种子行。 */
function seedFromDiskIfEmpty() {
  localDb.getDatabase();
}

function normalizeBody(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  const t = raw.trim();
  return t.length ? t : fallback;
}

/** @returns {string[]} */
function listStrategyIds() {
  seedFromDiskIfEmpty();
  const rows = localDb
    .getDatabase()
    .prepare(
      `SELECT id FROM prompt_strategies ORDER BY sort_order ASC, id ASC`,
    )
    .all();
  return rows.map((r) => r.id);
}

/**
 * @param {string} strategyId id 为空或表中无此行 / 正文为空时返回 ""
 */
function getStrategyBody(strategyId) {
  seedFromDiskIfEmpty();
  if (typeof strategyId !== "string" || !strategyId.trim()) return "";
  const id = strategyId.trim();
  const row = localDb
    .getDatabase()
    .prepare(`SELECT body FROM prompt_strategies WHERE id = ?`)
    .get(id);
  if (row && typeof row.body === "string" && row.body.trim()) {
    return row.body.trim();
  }
  return "";
}

/** @returns {{ id: string, label: string, sort_order: number }[]} */
function listStrategiesMeta() {
  seedFromDiskIfEmpty();
  return localDb
    .getDatabase()
    .prepare(
      `SELECT id, label, sort_order FROM prompt_strategies ORDER BY sort_order ASC, id ASC`,
    )
    .all();
}

/** @param {string} id */
function getStrategy(id) {
  seedFromDiskIfEmpty();
  const row = localDb
    .getDatabase()
    .prepare(`SELECT id, label, body, sort_order FROM prompt_strategies WHERE id = ?`)
    .get(id);
  return row || null;
}

/**
 * @param {{ id: string, label?: string, body: string }} payload
 * @returns {{ id: string, label: string, body: string, sort_order: number }}
 */
function saveStrategy(payload) {
  seedFromDiskIfEmpty();
  const id = typeof payload?.id === "string" ? payload.id.trim() : "";
  if (!ID_RE.test(id)) {
    throw new Error("策略 ID 须为字母开头，仅含字母数字、下划线、连字符，长度 1–64。");
  }
  const body = normalizeBody(payload?.body, "");
  if (!body) throw new Error("提示词正文不能为空。");
  let label = typeof payload?.label === "string" ? payload.label.trim() : "";
  if (!label) label = id;

  const db = localDb.getDatabase();
  const existing = db.prepare(`SELECT id FROM prompt_strategies WHERE id = ?`).get(id);
  if (existing) {
    db.prepare(
      `UPDATE prompt_strategies SET label = ?, body = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(label, body, id);
  } else {
    const maxRow = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM prompt_strategies`).get();
    const sort_order = (maxRow?.m ?? -1) + 1;
    db.prepare(
      `INSERT INTO prompt_strategies (id, label, body, sort_order, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run(id, label, body, sort_order);
  }
  return getStrategy(id);
}

/**
 * @param {string} strategyId
 */
function deleteStrategy(strategyId) {
  seedFromDiskIfEmpty();
  const id = typeof strategyId === "string" ? strategyId.trim() : "";
  if (!id) throw new Error("缺少策略 ID。");
  localDb.getDatabase().prepare(`DELETE FROM prompt_strategies WHERE id = ?`).run(id);
}

function validateStrategyId(id) {
  return ID_RE.test(typeof id === "string" ? id.trim() : "");
}

export {
  DEFAULT_PROMPT_STRATEGY,
  seedFromDiskIfEmpty,
  listStrategyIds,
  getStrategyBody,
  listStrategiesMeta,
  getStrategy,
  saveStrategy,
  deleteStrategy,
  validateStrategyId,
};
