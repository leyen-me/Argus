const localDb = require("./local-db");
const { BUILTIN_DEFAULT_BODY, BUILTIN_SEED_ROWS } = require("./builtin-prompts");

const DEFAULT_PROMPT_STRATEGY = "default";

const ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** 库损坏或极端情况下的兜底（与内置 default 正文一致） */
const MIN_FALLBACK_BODY = BUILTIN_DEFAULT_BODY;

function normalizeBody(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  const t = raw.trim();
  return t.length ? t : fallback;
}

function strategyCount() {
  const row = localDb
    .getDatabase()
    .prepare(`SELECT COUNT(*) AS n FROM prompt_strategies`)
    .get();
  return row ? Number(row.n) || 0 : 0;
}

function insertSeedRows() {
  const ins = localDb
    .getDatabase()
    .prepare(
      `INSERT INTO prompt_strategies (id, label, body, sort_order, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    );
  BUILTIN_SEED_ROWS.forEach((row, i) => {
    ins.run(row.id, row.label, row.body, i);
  });
}

/** 若库中缺少 default 行则补回（保证始终可选用 default） */
function ensureDefaultRow() {
  const db = localDb.getDatabase();
  const has = db.prepare(`SELECT 1 AS ok FROM prompt_strategies WHERE id = ?`).get(DEFAULT_PROMPT_STRATEGY);
  if (has) return;
  const row = BUILTIN_SEED_ROWS.find((r) => r.id === DEFAULT_PROMPT_STRATEGY);
  const body = row ? row.body : MIN_FALLBACK_BODY;
  const maxRow = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM prompt_strategies`).get();
  const sort_order = (maxRow?.m ?? -1) + 1;
  db.prepare(
    `INSERT INTO prompt_strategies (id, label, body, sort_order, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(DEFAULT_PROMPT_STRATEGY, DEFAULT_PROMPT_STRATEGY, body, sort_order);
}

/** 补全缺失的内置 id（不覆盖已有正文） */
function ensureMissingBuiltinRows() {
  const db = localDb.getDatabase();
  const insert = db.prepare(
    `INSERT INTO prompt_strategies (id, label, body, sort_order, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  );
  for (const row of BUILTIN_SEED_ROWS) {
    const exists = db.prepare(`SELECT 1 AS ok FROM prompt_strategies WHERE id = ?`).get(row.id);
    if (exists) continue;
    const maxRow = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM prompt_strategies`).get();
    const sort_order = (maxRow?.m ?? -1) + 1;
    insert.run(row.id, row.label, row.body, sort_order);
  }
}

/**
 * 空表时写入内置 default + ema20；否则补全 default 与缺失的内置策略行。
 */
function seedFromDiskIfEmpty() {
  localDb.getDatabase();
  if (strategyCount() === 0) {
    insertSeedRows();
    return;
  }
  ensureDefaultRow();
  ensureMissingBuiltinRows();
}

/**
 * 用代码内置正文覆盖 default、ema20；缺失则插入。不读文件系统。
 * @returns {{ imported: number }}
 */
function importBundledBodies() {
  localDb.getDatabase();
  seedFromDiskIfEmpty();
  const db = localDb.getDatabase();
  const update = db.prepare(
    `UPDATE prompt_strategies SET body = ?, updated_at = datetime('now') WHERE id = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO prompt_strategies (id, label, body, sort_order, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  );
  let n = 0;
  for (const row of BUILTIN_SEED_ROWS) {
    const exists = db.prepare(`SELECT 1 AS ok FROM prompt_strategies WHERE id = ?`).get(row.id);
    if (exists) {
      update.run(row.body, row.id);
    } else {
      const maxRow = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM prompt_strategies`).get();
      const sort_order = (maxRow?.m ?? -1) + 1;
      insert.run(row.id, row.label, row.body, sort_order);
    }
    n += 1;
  }
  return { imported: n };
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
 * @param {string} strategyId
 * @returns {string}
 */
function getStrategyBody(strategyId) {
  seedFromDiskIfEmpty();
  const id = typeof strategyId === "string" && strategyId.trim() ? strategyId.trim() : DEFAULT_PROMPT_STRATEGY;
  const row = localDb
    .getDatabase()
    .prepare(`SELECT body FROM prompt_strategies WHERE id = ?`)
    .get(id);
  if (row && typeof row.body === "string" && row.body.trim()) {
    return row.body.trim();
  }
  const def = localDb
    .getDatabase()
    .prepare(`SELECT body FROM prompt_strategies WHERE id = ?`)
    .get(DEFAULT_PROMPT_STRATEGY);
  if (def && typeof def.body === "string" && def.body.trim()) return def.body.trim();
  return MIN_FALLBACK_BODY;
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
  if (id === DEFAULT_PROMPT_STRATEGY) {
    throw new Error("内置策略 default 不可删除。");
  }
  if (strategyCount() <= 1) {
    throw new Error("至少保留一条策略。");
  }
  localDb.getDatabase().prepare(`DELETE FROM prompt_strategies WHERE id = ?`).run(id);
}

function validateStrategyId(id) {
  return ID_RE.test(typeof id === "string" ? id.trim() : "");
}

module.exports = {
  DEFAULT_PROMPT_STRATEGY,
  MIN_FALLBACK_BODY,
  seedFromDiskIfEmpty,
  importBundledBodies,
  listStrategyIds,
  getStrategyBody,
  listStrategiesMeta,
  getStrategy,
  saveStrategy,
  deleteStrategy,
  validateStrategyId,
};
