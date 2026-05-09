import { asc, eq, max } from "drizzle-orm";

import { getDb } from "./db/client.js";
import { promptStrategies } from "./db/schema.js";
import {
  STRATEGY_DEFAULT_MARKET_TIMEFRAMES,
  STRATEGY_INDICATOR_ORDER,
  defaultStrategyExtras,
  normalizeStrategyDecisionIntervalTv,
  normalizeStrategyMarketTimeframes,
  normalizeStrategyTokenSymbol,
  okxTvSymbolFromStrategyToken,
  parseStrategyExtrasJson,
  stringifyStrategyExtras,
  orderStrategyChartIndicators,
  type StrategyChartIndicatorId,
  type StrategyDecisionIntervalTv,
  type StrategyExtrasV1,
  type StrategyIndicatorId,
} from "../shared/strategy-fields.js";

const DEFAULT_PROMPT_STRATEGY = "default";

const LEGACY_STRATEGY_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
/** 与 `crypto.randomUUID()` 一致的小写 UUID v4 */
const STRATEGY_UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidPromptStrategyId(id: string): boolean {
  return LEGACY_STRATEGY_ID_RE.test(id) || STRATEGY_UUID_V4_RE.test(id);
}

/** 仅占打开数据库 Side Effect；MySQL 下无额外种子写入 */
async function seedFromDiskIfEmpty(): Promise<void> {
  getDb();
}

function normalizeBody(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const t = raw.trim();
  return t.length ? t : fallback;
}

async function listStrategyIds(): Promise<string[]> {
  await seedFromDiskIfEmpty();
  const db = getDb();
  const rows = await db
    .select({ id: promptStrategies.id })
    .from(promptStrategies)
    .orderBy(asc(promptStrategies.sortOrder), asc(promptStrategies.id));
  return rows.map((r) => r.id);
}

/**
 * @param {string} strategyId id 为空或表中无此行 / 正文为空时返回 ""
 */
async function getStrategyBody(strategyId: unknown): Promise<string> {
  await seedFromDiskIfEmpty();
  if (typeof strategyId !== "string" || !strategyId.trim()) return "";
  const id = strategyId.trim();
  const db = getDb();
  const rows = await db
    .select({ body: promptStrategies.body })
    .from(promptStrategies)
    .where(eq(promptStrategies.id, id))
    .limit(1);
  const row = rows[0];
  if (row && typeof row.body === "string" && row.body.trim()) {
    return row.body.trim();
  }
  return "";
}

/** @returns {{ id: string, label: string, sort_order: number }[]} */
async function listStrategiesMeta(): Promise<{ id: string; label: string; sort_order: number }[]> {
  await seedFromDiskIfEmpty();
  const db = getDb();
  return await db
    .select({
      id: promptStrategies.id,
      label: promptStrategies.label,
      sort_order: promptStrategies.sortOrder,
    })
    .from(promptStrategies)
    .orderBy(asc(promptStrategies.sortOrder), asc(promptStrategies.id));
}

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
 */
function mapStrategyRow(row: Record<string, unknown> | undefined): StrategyRowNormalized | null {
  if (!row || typeof row.id !== "string" || !row.id.trim()) return null;
  const extrasSrc = typeof row.extras_json === "string" ? row.extras_json : "{}";
  return {
    id: row.id.trim(),
    label: typeof row.label === "string" ? row.label : "",
    body: typeof row.body === "string" ? row.body : "",
    sort_order: Number(row.sort_order) || 0,
    decisionIntervalTv: normalizeStrategyDecisionIntervalTv(row.decision_interval_tv),
    extras: parseStrategyExtrasJson(extrasSrc),
  };
}

async function getStrategy(id: unknown): Promise<StrategyRowNormalized | null> {
  await seedFromDiskIfEmpty();
  if (typeof id !== "string" || !id.trim()) return null;
  const db = getDb();
  const rows = await db
    .select({
      id: promptStrategies.id,
      label: promptStrategies.label,
      body: promptStrategies.body,
      sort_order: promptStrategies.sortOrder,
      decision_interval_tv: promptStrategies.decisionIntervalTv,
      extras_json: promptStrategies.extrasJson,
    })
    .from(promptStrategies)
    .where(eq(promptStrategies.id, id.trim()))
    .limit(1);
  const row = rows[0];
  return row ? mapStrategyRow(row as Record<string, unknown>) : null;
}

async function getDecisionIntervalTvForStrategyId(strategyId: unknown): Promise<StrategyDecisionIntervalTv> {
  await seedFromDiskIfEmpty();
  if (typeof strategyId !== "string" || !strategyId.trim()) return "5";
  const row = await getStrategy(strategyId.trim());
  return row ? row.decisionIntervalTv : "5";
}

async function getOkxTvSymbolForStrategyId(strategyId: unknown): Promise<string> {
  await seedFromDiskIfEmpty();
  if (typeof strategyId !== "string" || !strategyId.trim()) {
    return okxTvSymbolFromStrategyToken(normalizeStrategyTokenSymbol(undefined));
  }
  const row = await getStrategy(strategyId.trim());
  const token = row
    ? normalizeStrategyTokenSymbol(row.extras.tokenSymbols)
    : normalizeStrategyTokenSymbol(undefined);
  return okxTvSymbolFromStrategyToken(token);
}

async function getMarketTimeframesForStrategyId(strategyId: unknown): Promise<StrategyDecisionIntervalTv[]> {
  await seedFromDiskIfEmpty();
  if (typeof strategyId !== "string" || !strategyId.trim()) {
    return [...STRATEGY_DEFAULT_MARKET_TIMEFRAMES];
  }
  const row = await getStrategy(strategyId.trim());
  return row ? [...row.extras.marketTimeframes] : [...STRATEGY_DEFAULT_MARKET_TIMEFRAMES];
}

async function getIndicatorsForStrategyId(strategyId: unknown): Promise<StrategyIndicatorId[]> {
  await seedFromDiskIfEmpty();
  if (typeof strategyId !== "string" || !strategyId.trim()) {
    return ["EM20"];
  }
  const row = await getStrategy(strategyId.trim());
  const raw = row ? [...row.extras.indicators] : ["EM20"];
  return STRATEGY_INDICATOR_ORDER.filter((x) => raw.includes(x));
}

async function getChartIndicatorsForStrategyId(strategyId: unknown): Promise<StrategyChartIndicatorId[]> {
  await seedFromDiskIfEmpty();
  if (typeof strategyId !== "string" || !strategyId.trim()) {
    return orderStrategyChartIndicators(["EM20"]);
  }
  const row = await getStrategy(strategyId.trim());
  if (!row) return orderStrategyChartIndicators(["EM20"]);
  return orderStrategyChartIndicators(row.extras.chartIndicators);
}

function applyExtrasPatch(base: StrategyExtrasV1, patch: Partial<StrategyExtrasV1>): StrategyExtrasV1 {
  return {
    tokenSymbols: patch.tokenSymbols !== undefined ? [...patch.tokenSymbols] : [...base.tokenSymbols],
    marketTimeframes:
      patch.marketTimeframes !== undefined
        ? normalizeStrategyMarketTimeframes(patch.marketTimeframes)
        : [...base.marketTimeframes],
    indicators: patch.indicators !== undefined ? [...patch.indicators] : [...base.indicators],
    chartIndicators: patch.chartIndicators !== undefined ? [...patch.chartIndicators] : [...base.chartIndicators],
  };
}

async function saveStrategy(payload: {
  id: string;
  label?: string;
  body: string;
  decisionIntervalTv?: unknown;
  extras?: Partial<StrategyExtrasV1>;
}): Promise<StrategyRowNormalized | null> {
  await seedFromDiskIfEmpty();
  const id = typeof payload?.id === "string" ? payload.id.trim() : "";
  if (!isValidPromptStrategyId(id)) {
    throw new Error("策略 ID 须为字母开头的字母数字/下划线/连字符（≤64），或为标准 UUID v4。");
  }
  const body = normalizeBody(payload?.body, "");
  if (!body) throw new Error("提示词正文不能为空。");
  let label = typeof payload?.label === "string" ? payload.label.trim() : "";
  if (!label) label = id;

  const db = getDb();
  const existingRows = await db
    .select({
      id: promptStrategies.id,
      extras_json: promptStrategies.extrasJson,
      decision_interval_tv: promptStrategies.decisionIntervalTv,
    })
    .from(promptStrategies)
    .where(eq(promptStrategies.id, id))
    .limit(1);
  const existingRow = existingRows[0] as
    | { id: string; extras_json: string; decision_interval_tv: string }
    | undefined;

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

  const updatedAt = new Date().toISOString();

  if (existingRow) {
    await db
      .update(promptStrategies)
      .set({
        label,
        body,
        decisionIntervalTv: decisionIv,
        extrasJson: extrasMerged,
        updatedAt,
      })
      .where(eq(promptStrategies.id, id));
  } else {
    const extrasNew = stringifyStrategyExtras(
      payload.extras && typeof payload.extras === "object"
        ? applyExtrasPatch(defaultStrategyExtras(), payload.extras)
        : defaultStrategyExtras(),
    );
    const maxRows = await db.select({ m: max(promptStrategies.sortOrder) }).from(promptStrategies);
    const maxVal = maxRows[0]?.m;
    const sortOrder = (typeof maxVal === "number" ? maxVal : Number(maxVal) || -1) + 1;
    await db.insert(promptStrategies).values({
      id,
      label,
      body,
      sortOrder,
      decisionIntervalTv: decisionIv,
      extrasJson: extrasNew,
      updatedAt,
    });
  }
  return getStrategy(id);
}

async function deleteStrategy(strategyId: unknown): Promise<void> {
  await seedFromDiskIfEmpty();
  const id = typeof strategyId === "string" ? strategyId.trim() : "";
  if (!id) throw new Error("缺少策略 ID。");
  const db = getDb();
  await db.delete(promptStrategies).where(eq(promptStrategies.id, id));
}

function validateStrategyId(id: unknown): boolean {
  return isValidPromptStrategyId(typeof id === "string" ? id.trim() : "");
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
  getChartIndicatorsForStrategyId,
  saveStrategy,
  deleteStrategy,
  validateStrategyId,
};
