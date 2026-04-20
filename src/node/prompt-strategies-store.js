const fs = require("fs");
const path = require("path");

const localDb = require("./local-db");

const SRC_ROOT = path.join(__dirname, "..");
const PROMPTS_DIR = path.join(SRC_ROOT, "prompts");
const STRATEGY_PROMPT_BASENAME = "system-crypto.txt";
const DEFAULT_PROMPT_STRATEGY = "default";

const ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/**
 * 与 app-config 中兜底文案一致（表为空且磁盘也无内容时用）。
 */
const MIN_FALLBACK_BODY =
  "你是资深加密市场价格行为分析助手，核心方法参考 Al Brooks，但输出必须服务于一个由代码维护的交易状态机。" +
  "先判断趋势、震荡或过渡，再分析本根收盘 K 线在当前位置是延续、测试、拒绝、突破、失败突破还是噪音。" +
  "重点看价格行为本身，不机械复述原始 OHLCV；所有结论都基于概率，没有足够 edge 时优先保守。" +
  "你必须严格服从状态机：只能从 allowed_intents 中选择一个 intent；若当前为 HOLDING_*，禁止重复开仓；若当前为 LOOKING_*，只有确认成立才允许 ENTER_*。" +
  "若信号一般、位置不佳、盈亏比不清晰或只是震荡中部，优先 WAIT / HOLD / CANCEL_LOOKING。" +
  "请只返回严格 JSON，不要输出 Markdown、代码块或额外解释。";

function normalizeBody(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  const t = raw.trim();
  return t.length ? t : fallback;
}

/**
 * 枚举内置目录下可用的策略 id 与正文（不读库）。
 * @returns {{ id: string, body: string }[]}
 */
function readBundledStrategiesFromDisk() {
  const out = [];
  try {
    if (!fs.existsSync(PROMPTS_DIR)) return [];
    const entries = fs.readdirSync(PROMPTS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const id = e.name;
      const f = path.join(PROMPTS_DIR, id, STRATEGY_PROMPT_BASENAME);
      if (!fs.existsSync(f)) continue;
      let body = "";
      try {
        body = fs.readFileSync(f, "utf8");
      } catch {
        body = "";
      }
      out.push({
        id,
        body: normalizeBody(body, MIN_FALLBACK_BODY),
      });
    }
  } catch {
    return [];
  }
  out.sort((a, b) => {
    if (a.id === DEFAULT_PROMPT_STRATEGY) return -1;
    if (b.id === DEFAULT_PROMPT_STRATEGY) return 1;
    return a.id.localeCompare(b.id);
  });
  return out;
}

function strategyCount() {
  const row = localDb
    .getDatabase()
    .prepare(`SELECT COUNT(*) AS n FROM prompt_strategies`)
    .get();
  return row ? Number(row.n) || 0 : 0;
}

/**
 * 首次空表时从内置 prompts 各策略子目录的 system-crypto.txt 导入。
 */
function seedFromDiskIfEmpty() {
  localDb.getDatabase();
  if (strategyCount() > 0) return;
  const bundled = readBundledStrategiesFromDisk();
  if (bundled.length === 0) {
    const ins = localDb
      .getDatabase()
      .prepare(
        `INSERT INTO prompt_strategies (id, label, body, sort_order, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      );
    ins.run(DEFAULT_PROMPT_STRATEGY, DEFAULT_PROMPT_STRATEGY, MIN_FALLBACK_BODY, 0);
    return;
  }
  const ins = localDb
    .getDatabase()
    .prepare(
      `INSERT INTO prompt_strategies (id, label, body, sort_order, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    );
  bundled.forEach((row, i) => {
    ins.run(row.id, row.id, row.body, i);
  });
}

/**
 * 用内置目录覆盖各 id 的 body；新 id 会插入，已有 id 仅更新正文与 updated_at。
 * @returns {{ imported: number }}
 */
function importBundledBodies() {
  localDb.getDatabase();
  seedFromDiskIfEmpty();
  const bundled = readBundledStrategiesFromDisk();
  const db = localDb.getDatabase();
  const update = db.prepare(
    `UPDATE prompt_strategies SET body = ?, updated_at = datetime('now') WHERE id = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO prompt_strategies (id, label, body, sort_order, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  );
  let n = 0;
  for (const row of bundled) {
    const exists = db.prepare(`SELECT 1 AS ok FROM prompt_strategies WHERE id = ?`).get(row.id);
    if (exists) {
      update.run(row.body, row.id);
    } else {
      const maxRow = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM prompt_strategies`).get();
      const sort_order = (maxRow?.m ?? -1) + 1;
      insert.run(row.id, row.id, row.body, sort_order);
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
  readBundledStrategiesFromDisk,
  listStrategyIds,
  getStrategyBody,
  listStrategiesMeta,
  getStrategy,
  saveStrategy,
  deleteStrategy,
  validateStrategyId,
};
