import * as localDb from "./local-db/index.js";
import {
  STRATEGY_DECISION_INTERVAL_TV,
  STRATEGY_INDICATOR_ORDER,
  defaultStrategyExtras,
  normalizeStrategyDecisionIntervalTv,
  normalizeStrategyTokenSymbol,
  okxTvSymbolFromStrategyToken,
  parseStrategyExtrasJson,
  stringifyStrategyExtras,
  type StrategyDecisionIntervalTv,
  type StrategyExtrasV1,
  type StrategyIndicatorId,
} from "../shared/strategy-fields.js";

const DEFAULT_PROMPT_STRATEGY = "default";

const ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** 仅占打开数据库 Side Effect；不向 `prompt_strategies` 写入任何种子行。 */
function seedFromDiskIfEmpty() {
  localDb.getDatabase();
}

function normalizeBody(raw: unknown, fallback: string): string {
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
    .all() as { id: string }[];
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
    .get(id) as { body?: string } | undefined;
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

/** @typedef {import("../shared/strategy-fields.js").StrategyDecisionIntervalTv} StrategyDecisionIntervalTv */
/** @typedef {import("../shared/strategy-fields.js").StrategyExtrasV1} StrategyExtrasV1 */

type StrategyRowNormalized = {
  id: string;
  label: string;
  body: string;
  sort_order: number;
  decisionIntervalTv: StrategyDecisionIntervalTv;
  extras: StrategyExtrasV1;
};

/**
 * SQLite 列（snake_case）→ UI / API camelCase。
 * @param {Record<string, unknown>} row
 * @returns {StrategyRowNormalized}
 */
function mapStrategyRow(row: Record<string, unknown> | undefined): StrategyRowNormalized | null {
  if (!row || typeof row.id !== "string" || !row.id.trim()) return null;
  const extrasSrc =
    typeof row.extras_json === "string"
      ? row.extras_json
      : "{}";
  return {
    id: row.id.trim(),
    label: typeof row.label === "string" ? row.label : "",
    body: typeof row.body === "string" ? row.body : "",
    sort_order: Number(row.sort_order) || 0,
    decisionIntervalTv: normalizeStrategyDecisionIntervalTv(row.decision_interval_tv),
    extras: parseStrategyExtrasJson(extrasSrc),
  };
}

/** @param {string} id */
function getStrategy(id): StrategyRowNormalized | null {
  seedFromDiskIfEmpty();
  const row = localDb
    .getDatabase()
    .prepare(
      `SELECT id, label, body, sort_order, decision_interval_tv, extras_json FROM prompt_strategies WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapStrategyRow(row) : null;
}

/**
 * @param {unknown} strategyId
 * @returns {StrategyDecisionIntervalTv}
 */
function getDecisionIntervalTvForStrategyId(strategyId: unknown): StrategyDecisionIntervalTv {
  seedFromDiskIfEmpty();
  if (typeof strategyId !== "string" || !strategyId.trim()) return "5";
  const row = getStrategy(strategyId.trim());
  return row ? row.decisionIntervalTv : "5";
}

/**
 * 当前策略在「策略中心」绑定的代币 → OKX 图表 / 行情代码（如 OKX:BTCUSDT）。
 * @param {unknown} strategyId
 * @returns {string}
 */
function getOkxTvSymbolForStrategyId(strategyId: unknown): string {
  seedFromDiskIfEmpty();
  if (typeof strategyId !== "string" || !strategyId.trim()) {
    return okxTvSymbolFromStrategyToken(normalizeStrategyTokenSymbol(undefined));
  }
  const row = getStrategy(strategyId.trim());
  const token = row
    ? normalizeStrategyTokenSymbol(row.extras.tokenSymbols)
    : normalizeStrategyTokenSymbol(undefined);
  return okxTvSymbolFromStrategyToken(token);
}

/**
 * 策略在「市场数据」中勾选的多周期（与提示词 `## 多周期上下文` 一致）。
 * @param {unknown} strategyId
 * @returns {StrategyDecisionIntervalTv[]}
 */
function getMarketTimeframesForStrategyId(strategyId: unknown): StrategyDecisionIntervalTv[] {
  seedFromDiskIfEmpty();
  if (typeof strategyId !== "string" || !strategyId.trim()) {
    return [...STRATEGY_DECISION_INTERVAL_TV];
  }
  const row = getStrategy(strategyId.trim());
  return row ? [...row.extras.marketTimeframes] : [...STRATEGY_DECISION_INTERVAL_TV];
}

/**
 * 策略在「技术指标」中的勾选（与最近 K 线表列一致；无策略 id 或未入库时默认 EMA20）。
 * @param {unknown} strategyId
 * @returns {StrategyIndicatorId[]}
 */
function getIndicatorsForStrategyId(strategyId: unknown): StrategyIndicatorId[] {
  seedFromDiskIfEmpty();
  if (typeof strategyId !== "string" || !strategyId.trim()) {
    return ["EM20"];
  }
  const row = getStrategy(strategyId.trim());
  const raw = row ? [...row.extras.indicators] : ["EM20"];
  return STRATEGY_INDICATOR_ORDER.filter((id) => raw.includes(id));
}

/** @param {Partial<StrategyExtrasV1>} patch */
function applyExtrasPatch(base: StrategyExtrasV1, patch: Partial<StrategyExtrasV1>): StrategyExtrasV1 {
  return {
    tokenSymbols: patch.tokenSymbols !== undefined ? [...patch.tokenSymbols] : [...base.tokenSymbols],
    marketTimeframes:
      patch.marketTimeframes !== undefined ? [...patch.marketTimeframes] : [...base.marketTimeframes],
    indicators: patch.indicators !== undefined ? [...patch.indicators] : [...base.indicators],
  };
}

/**
 * @param {{
 *   id: string;
 *   label?: string;
 *   body: string;
 *   decisionIntervalTv?: unknown;
 *   extras?: Partial<StrategyExtrasV1>;
 * }} payload
 */
function saveStrategy(payload: {
  id: string;
  label?: string;
  body: string;
  decisionIntervalTv?: unknown;
  extras?: Partial<StrategyExtrasV1>;
}) {
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
  const existingRow = db
    .prepare(`SELECT id, extras_json, decision_interval_tv FROM prompt_strategies WHERE id = ?`)
    .get(id) as { id: string; extras_json?: string; decision_interval_tv?: string } | undefined;

  const existingExtras = parseStrategyExtrasJson(existingRow?.extras_json);

  const decisionIv = existingRow
    ? payload.decisionIntervalTv !== undefined
      ? normalizeStrategyDecisionIntervalTv(payload.decisionIntervalTv)
      : normalizeStrategyDecisionIntervalTv(existingRow.decision_interval_tv)
    : normalizeStrategyDecisionIntervalTv(payload.decisionIntervalTv);

  const extrasMerged = stringifyStrategyExtras(
    payload.extras && typeof payload.extras === "object"
      ? applyExtrasPatch(existingExtras, payload.extras)
      : existingExtras,
  );

  if (existingRow) {
    db.prepare(
      `UPDATE prompt_strategies SET label = ?, body = ?, decision_interval_tv = ?, extras_json = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(label, body, decisionIv, extrasMerged, id);
  } else {
    const extrasNew = stringifyStrategyExtras(
      payload.extras && typeof payload.extras === "object"
        ? applyExtrasPatch(defaultStrategyExtras(), payload.extras)
        : defaultStrategyExtras(),
    );
    const maxRow = db
      .prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM prompt_strategies`)
      .get() as { m?: number } | undefined;
    const sort_order = (maxRow?.m ?? -1) + 1;
    db.prepare(
      `INSERT INTO prompt_strategies (id, label, body, sort_order, decision_interval_tv, extras_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(id, label, body, sort_order, decisionIv, extrasNew);
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
  getDecisionIntervalTvForStrategyId,
  getOkxTvSymbolForStrategyId,
  getMarketTimeframesForStrategyId,
  getIndicatorsForStrategyId,
  saveStrategy,
  deleteStrategy,
  validateStrategyId,
};
