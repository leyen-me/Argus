/**
 * 策略维度的决策周期与扩展字段（前后端共用，避免散落魔法字符串）。
 * TradingView / OKX 周期写法：`5`、`15`、`60`、`1D`。
 */

export const STRATEGY_DECISION_INTERVAL_TV = ["5", "15", "60", "1D"] as const;
export type StrategyDecisionIntervalTv = (typeof STRATEGY_DECISION_INTERVAL_TV)[number];

/** 送入 LLM 的附图 / K 线多周期（小周期在前、大周期在后，与提示词 `## 多周期上下文` 一致）。 */
export const MULTI_TIMEFRAME_CAPTURE_SPECS = [
  { interval: "5", label: "5m" },
  { interval: "15", label: "15m" },
  { interval: "60", label: "1H" },
  { interval: "1D", label: "1D" },
] as const;

export type StrategyIndicatorId = "EM20" | "BB" | "ATR" | "MACD";

/** K 线表追加列顺序（与策略中心勾选顺序无关，固定此序输出） */
export const STRATEGY_INDICATOR_ORDER: readonly StrategyIndicatorId[] = ["EM20", "BB", "ATR", "MACD"];
export const STRATEGY_TOKEN_SYMBOL_OPTIONS = ["BTC", "ETH", "SOL", "DOGE"] as const;
export type StrategyTokenSymbol = (typeof STRATEGY_TOKEN_SYMBOL_OPTIONS)[number];

const TOKEN_SYMBOL_SET = new Set<string>(STRATEGY_TOKEN_SYMBOL_OPTIONS);

export function normalizeStrategyTokenSymbol(raw: unknown): StrategyTokenSymbol {
  if (Array.isArray(raw)) {
    for (const t of raw) {
      const u = String(t).trim().toUpperCase();
      if (TOKEN_SYMBOL_SET.has(u)) return u as StrategyTokenSymbol;
    }
  } else if (raw != null && raw !== "") {
    const u = String(raw).trim().toUpperCase();
    if (TOKEN_SYMBOL_SET.has(u)) return u as StrategyTokenSymbol;
  }
  return "BTC";
}

/** TradingView / 行情订阅用 OKX 永续 U 本位代码 */
export function okxTvSymbolFromStrategyToken(token: StrategyTokenSymbol): string {
  return `OKX:${token}USDT`;
}

export function listOkxStrategySymbolOptions(): { label: string; value: string }[] {
  return STRATEGY_TOKEN_SYMBOL_OPTIONS.map((s) => ({
    label: `${s}/USDT`,
    value: okxTvSymbolFromStrategyToken(s),
  }));
}

export type StrategyExtrasV1 = {
  /** 单选：代币 / 合约范围，持久化为 length-1 数组 */
  tokenSymbols: string[];
  /** 多选：投喂模型的 K 线多周期（与 `## 多周期上下文` 及附图子集一致） */
  marketTimeframes: StrategyDecisionIntervalTv[];
  /** 多选：技术指标列（EMA / 布林 / ATR / MACD），拼入各周期「最近 K 线」表 */
  indicators: StrategyIndicatorId[];
};

export function defaultStrategyExtras(): StrategyExtrasV1 {
  return {
    tokenSymbols: ["BTC"],
    marketTimeframes: [...STRATEGY_DECISION_INTERVAL_TV],
    indicators: [],
  };
}

export function normalizeStrategyDecisionIntervalTv(raw: unknown): StrategyDecisionIntervalTv {
  let v = String(raw ?? "5").trim();
  if (v.toUpperCase() === "D") v = "1D";
  return STRATEGY_DECISION_INTERVAL_TV.includes(v as StrategyDecisionIntervalTv)
    ? (v as StrategyDecisionIntervalTv)
    : "5";
}

export function decisionIntervalLabel(tv: StrategyDecisionIntervalTv): string {
  switch (tv) {
    case "15":
      return "15 分钟";
    case "60":
      return "1 小时";
    case "1D":
      return "日线";
    default:
      return "5 分钟";
  }
}

/** 与会话跳过提示中的周期描述一致（非一律加 m 后缀）。 */
export function decisionIntervalExplain(tv: StrategyDecisionIntervalTv): string {
  switch (tv) {
    case "15":
      return "15 分钟";
    case "60":
      return "1 小时";
    case "1D":
      return "日线";
    default:
      return "5 分钟";
  }
}

const INDICATORS: StrategyIndicatorId[] = [...STRATEGY_INDICATOR_ORDER];

function isIndicator(id: unknown): id is StrategyIndicatorId {
  return typeof id === "string" && INDICATORS.includes(id as StrategyIndicatorId);
}

export function normalizeStrategyIndicators(raw: unknown): StrategyIndicatorId[] {
  if (!Array.isArray(raw)) return [];
  const out = raw.filter(isIndicator);
  return out.length ? [...new Set(out)] : [];
}

/** 按 {@link STRATEGY_INDICATOR_ORDER} 排列策略勾选（用于 LLM 表头列序） */
export function orderStrategyIndicatorsForPrompt(ids: readonly StrategyIndicatorId[] | undefined): StrategyIndicatorId[] {
  if (!ids?.length) return [];
  const set = new Set(ids);
  return STRATEGY_INDICATOR_ORDER.filter((id) => set.has(id));
}

export function normalizeStrategyMarketTimeframes(raw: unknown): StrategyDecisionIntervalTv[] {
  if (!Array.isArray(raw)) return [...STRATEGY_DECISION_INTERVAL_TV];
  const out = raw
    .map((x) => normalizeStrategyDecisionIntervalTv(x))
    .filter((x, i, a) => a.indexOf(x) === i);
  return out.length ? out : [...STRATEGY_DECISION_INTERVAL_TV];
}

export function parseStrategyExtrasJson(raw: unknown): StrategyExtrasV1 {
  let o: Record<string, unknown> = {};
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) o = parsed as Record<string, unknown>;
    } catch {
      o = {};
    }
  }
  const def = defaultStrategyExtras();
  const tokenSymbols = [normalizeStrategyTokenSymbol(o.tokenSymbols !== undefined ? o.tokenSymbols : def.tokenSymbols)];
  const marketTf = normalizeStrategyMarketTimeframes(o.marketTimeframes);
  let indicators = normalizeStrategyIndicators(o.indicators);
  if (!indicators.length && Array.isArray(o.indicators)) indicators = def.indicators;
  return {
    tokenSymbols,
    marketTimeframes: marketTf.length ? marketTf : def.marketTimeframes,
    indicators,
  };
}

export function stringifyStrategyExtras(extras: StrategyExtrasV1): string {
  return JSON.stringify(extras);
}

/** 与 OKX WS / TradingView `interval` 比较用（统一 `D` ≈ `1D`）。 */
export function canonTradingViewInterval(tv: unknown): string {
  const raw = String(tv ?? "").trim();
  if (!raw) return "";
  const u = raw.toUpperCase();
  if (u === "D" || u === "1D") return "1D";
  if (/^[0-9]+$/.test(raw)) return raw;
  return raw;
}

/** TV 周期：从小到大（5m → … → 1D），用于「多周期上下文」与附图顺序。 */
const TV_INTERVAL_RANK_SMALL_FIRST: Record<string, number> = {
  "5": 0,
  "15": 1,
  "60": 2,
  "1D": 3,
};

/**
 * 将多周期 spec 排成「小周期在上、大周期在下」（与 `## 多周期上下文` 及附图顺序一致）。
 */
export function sortMultiTimeframeSpecsSmallestFirst<T extends { interval: string }>(specs: readonly T[]): T[] {
  return [...specs].sort(
    (a, b) =>
      (TV_INTERVAL_RANK_SMALL_FIRST[canonTradingViewInterval(a.interval)] ?? 99) -
      (TV_INTERVAL_RANK_SMALL_FIRST[canonTradingViewInterval(b.interval)] ?? 99),
  );
}

/**
 * 按策略勾选保留条目，并统一为**小周期在上、大周期在下**。
 * `selected` 为空时返回完整 `specs`（容错），仍会做从小到大排序。
 */
export function filterMultiTimeframeSpecsByMarketSelection<T extends { interval: string }>(
  specs: readonly T[],
  selected: readonly StrategyDecisionIntervalTv[],
): T[] {
  let base: T[];
  if (!selected.length) {
    base = [...specs];
  } else {
    const want = new Set(selected.map((tv) => canonTradingViewInterval(tv)));
    const out = specs.filter((s) => want.has(canonTradingViewInterval(s.interval)));
    base = out.length ? out : [...specs];
  }
  return sortMultiTimeframeSpecsSmallestFirst(base);
}
