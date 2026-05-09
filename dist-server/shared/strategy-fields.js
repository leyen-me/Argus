/**
 * 策略维度的决策周期与扩展字段（前后端共用，避免散落魔法字符串）。
 * TradingView / OKX 周期写法：`5`、`15`、`60`、`240`（4H）、`1D`。
 */
export const STRATEGY_DECISION_INTERVAL_TV = ["5", "15", "60", "240", "1D"];
/** 「市场数据」多选最多条数（5 个周期里最多勾选 4 个用于投喂上下文）。 */
export const MAX_STRATEGY_MARKET_TIMEFRAMES = 4;
/**
 * 默认投喂 / 缺省勾选的周期（至多 {@link MAX_STRATEGY_MARKET_TIMEFRAMES} 个）；升级库后仍与旧版四周期面一致。
 */
export const STRATEGY_DEFAULT_MARKET_TIMEFRAMES = ["5", "15", "60", "1D"];
/** 送入 LLM 的附图 / K 线多周期（小周期在前、大周期在后，与提示词 `## 多周期上下文` 一致）。 */
export const MULTI_TIMEFRAME_CAPTURE_SPECS = [
    { interval: "5", label: "5m" },
    { interval: "15", label: "15m" },
    { interval: "60", label: "1H" },
    { interval: "240", label: "4H" },
    { interval: "1D", label: "1D" },
];
/** K 线表追加列顺序（与策略中心勾选顺序无关，固定此序输出） */
export const STRATEGY_INDICATOR_ORDER = [
    "VOL",
    "EM20",
    "EM50",
    "EM200",
    "BB",
    "ATR",
    "RSI14",
    "MACD",
    "SUPERTREND",
];
/**
 * 免费 TradingView「Advanced Chart」嵌入（`tv.js` widget）里可通过 `studies` 预置的指标。
 * SuperTrend 等仅在自托管 Charting Library 提供；嵌入里使用会触发 `cannot_get_metainfo`。
 */
export const STRATEGY_CHART_TV_EMBED_SUPPORTED_IDS = [
    "VOL",
    "EM20",
    "EM50",
    "EM200",
    "BB",
    "ATR",
    "RSI14",
    "MACD",
];
export const STRATEGY_TOKEN_SYMBOL_OPTIONS = ["BTC", "ETH", "SOL", "DOGE"];
const TOKEN_SYMBOL_SET = new Set(STRATEGY_TOKEN_SYMBOL_OPTIONS);
export function normalizeStrategyTokenSymbol(raw) {
    if (Array.isArray(raw)) {
        for (const t of raw) {
            const u = String(t).trim().toUpperCase();
            if (TOKEN_SYMBOL_SET.has(u))
                return u;
        }
    }
    else if (raw != null && raw !== "") {
        const u = String(raw).trim().toUpperCase();
        if (TOKEN_SYMBOL_SET.has(u))
            return u;
    }
    return "BTC";
}
/** TradingView / 行情订阅用 OKX 永续 U 本位代码 */
export function okxTvSymbolFromStrategyToken(token) {
    return `OKX:${token}USDT`;
}
export function listOkxStrategySymbolOptions() {
    return STRATEGY_TOKEN_SYMBOL_OPTIONS.map((s) => ({
        label: `${s}/USDT`,
        value: okxTvSymbolFromStrategyToken(s),
    }));
}
export function defaultStrategyExtras() {
    return {
        tokenSymbols: ["BTC"],
        marketTimeframes: [...STRATEGY_DEFAULT_MARKET_TIMEFRAMES],
        indicators: [],
        chartIndicators: ["EM20"],
    };
}
export function normalizeStrategyDecisionIntervalTv(raw) {
    let v = String(raw ?? "5").trim();
    if (v.toUpperCase() === "D")
        v = "1D";
    return STRATEGY_DECISION_INTERVAL_TV.includes(v)
        ? v
        : "5";
}
export function decisionIntervalLabel(tv) {
    switch (tv) {
        case "15":
            return "15 分钟";
        case "60":
            return "1 小时";
        case "240":
            return "4 小时";
        case "1D":
            return "日线";
        default:
            return "5 分钟";
    }
}
/** 与会话跳过提示中的周期描述一致（非一律加 m 后缀）。 */
export function decisionIntervalExplain(tv) {
    switch (tv) {
        case "15":
            return "15 分钟";
        case "60":
            return "1 小时";
        case "240":
            return "4 小时";
        case "1D":
            return "日线";
        default:
            return "5 分钟";
    }
}
const INDICATORS = [...STRATEGY_INDICATOR_ORDER];
function isIndicator(id) {
    return typeof id === "string" && INDICATORS.includes(id);
}
export function normalizeStrategyIndicators(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = raw.filter(isIndicator);
    return out.length ? [...new Set(out)] : [];
}
/** 按 {@link STRATEGY_INDICATOR_ORDER} 排列策略勾选（用于 LLM 表头列序） */
export function orderStrategyIndicatorsForPrompt(ids) {
    if (!ids?.length)
        return [];
    const set = new Set(ids);
    return STRATEGY_INDICATOR_ORDER.filter((id) => set.has(id));
}
/** 图表图层顺序：主图叠加 → 副图指标（与 {@link STRATEGY_INDICATOR_ORDER} 一致）。 */
export function orderStrategyChartIndicators(ids) {
    return orderStrategyIndicatorsForPrompt(ids);
}
export function normalizeStrategyMarketTimeframes(raw) {
    if (!Array.isArray(raw))
        return [...STRATEGY_DEFAULT_MARKET_TIMEFRAMES];
    let out = raw
        .map((x) => normalizeStrategyDecisionIntervalTv(x))
        .filter((x, i, a) => a.indexOf(x) === i);
    if (!out.length)
        return [...STRATEGY_DEFAULT_MARKET_TIMEFRAMES];
    if (out.length > MAX_STRATEGY_MARKET_TIMEFRAMES) {
        const asc = [...out].sort((a, b) => (TV_INTERVAL_RANK_SMALL_FIRST[a] ?? 99) - (TV_INTERVAL_RANK_SMALL_FIRST[b] ?? 99));
        out = asc.slice(-MAX_STRATEGY_MARKET_TIMEFRAMES);
    }
    return sortMultiTimeframeSpecsSmallestFirst(out.map((interval) => ({ interval }))).map((s) => s.interval);
}
/**
 * 在「周期从小到大」的固定次序中筛出已勾选项，供左侧附图宫格 DOM 顺序与策略中心「市场数据」按钮顺序使用。
 * 次序与 {@link STRATEGY_DECISION_INTERVAL_TV} 一致。
 */
export function sortMarketTimeframesForChartGrid(selected) {
    const set = new Set(selected);
    return STRATEGY_DECISION_INTERVAL_TV.filter((id) => set.has(id));
}
/** 从策略 `extras.marketTimeframes` 或配置字段推导左侧应挂载的附图周期序列（从小到大）。 */
export function intervalsForTradingViewChartGrid(marketTimeframesField) {
    return sortMarketTimeframesForChartGrid(normalizeStrategyMarketTimeframes(marketTimeframesField));
}
export function parseStrategyExtrasJson(raw) {
    let o = {};
    if (typeof raw === "string" && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                o = parsed;
        }
        catch {
            o = {};
        }
    }
    const def = defaultStrategyExtras();
    const tokenSymbols = [normalizeStrategyTokenSymbol(o.tokenSymbols !== undefined ? o.tokenSymbols : def.tokenSymbols)];
    const marketTf = normalizeStrategyMarketTimeframes(o.marketTimeframes);
    let indicators = normalizeStrategyIndicators(o.indicators);
    if (!indicators.length && Array.isArray(o.indicators))
        indicators = def.indicators;
    const legacyNoChartKey = !Object.prototype.hasOwnProperty.call(o, "chartIndicators");
    let chartIndicators = normalizeStrategyChartIndicators(o.chartIndicators);
    if (legacyNoChartKey)
        chartIndicators = ["EM20"];
    const tvEmbedOk = new Set(STRATEGY_CHART_TV_EMBED_SUPPORTED_IDS);
    chartIndicators = chartIndicators.filter((id) => tvEmbedOk.has(id));
    return {
        tokenSymbols,
        marketTimeframes: marketTf.length ? marketTf : def.marketTimeframes,
        indicators,
        chartIndicators,
    };
}
function normalizeStrategyChartIndicators(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = raw.filter((x) => isIndicator(x));
    return out.length ? [...new Set(out)] : [];
}
export function stringifyStrategyExtras(extras) {
    return JSON.stringify(extras);
}
/** 与 OKX WS / TradingView `interval` 比较用（统一 `D` ≈ `1D`）。 */
export function canonTradingViewInterval(tv) {
    const raw = String(tv ?? "").trim();
    if (!raw)
        return "";
    const u = raw.toUpperCase();
    if (u === "D" || u === "1D")
        return "1D";
    if (/^[0-9]+$/.test(raw))
        return raw;
    return raw;
}
/** TV 周期：从小到大（5m → … → 1D），用于「多周期上下文」与附图顺序。 */
const TV_INTERVAL_RANK_SMALL_FIRST = {
    "5": 0,
    "15": 1,
    "60": 2,
    "240": 3,
    "1D": 4,
};
/**
 * 将多周期 spec 排成「小周期在上、大周期在下」（与 `## 多周期上下文` 及附图顺序一致）。
 */
export function sortMultiTimeframeSpecsSmallestFirst(specs) {
    return [...specs].sort((a, b) => (TV_INTERVAL_RANK_SMALL_FIRST[canonTradingViewInterval(a.interval)] ?? 99) -
        (TV_INTERVAL_RANK_SMALL_FIRST[canonTradingViewInterval(b.interval)] ?? 99));
}
/**
 * 按策略勾选保留条目，并统一为**小周期在上、大周期在下**。
 * `selected` 为空时返回完整 `specs`（容错），仍会做从小到大排序。
 */
export function filterMultiTimeframeSpecsByMarketSelection(specs, selected) {
    let base;
    if (!selected.length) {
        base = [...specs];
    }
    else {
        const want = new Set(selected.map((tv) => canonTradingViewInterval(tv)));
        const out = specs.filter((s) => want.has(canonTradingViewInterval(s.interval)));
        base = out.length ? out : [...specs];
    }
    return sortMultiTimeframeSpecsSmallestFirst(base);
}
//# sourceMappingURL=strategy-fields.js.map