import { orderStrategyChartIndicators, type StrategyChartIndicatorId } from "./strategy-fields.js";

/** 传入 TradingView.widget 的 `studies` 项（免费 embed / tv-basicstudies）。 */
export type TradingViewStudySpec = { id: string; inputs?: Record<string, number> };

/**
 * 将策略「图表指标」映射为 TradingView 预置 studies，并给出是否隐藏成交量副图。
 * 仅包含 {@link STRATEGY_CHART_TV_EMBED_SUPPORTED_IDS}；SuperTrend 在免费嵌入中不可用，勿加入 `studies`。
 */
export function tradingViewStudiesFromChartIndicators(
  ids: readonly StrategyChartIndicatorId[] | undefined,
): { studies: TradingViewStudySpec[]; hide_volume: boolean } {
  const ordered = orderStrategyChartIndicators(ids);
  /** TradingView：`hide_volume: true` 表示隐藏成交量副图 */
  const hide_volume = !ordered.includes("VOL");
  const studies: TradingViewStudySpec[] = [];

  for (const id of ordered) {
    switch (id) {
      case "VOL":
        break;
      case "EM20":
        studies.push({ id: "MAExp@tv-basicstudies", inputs: { length: 20 } });
        break;
      case "EM50":
        studies.push({ id: "MAExp@tv-basicstudies", inputs: { length: 50 } });
        break;
      case "EM200":
        studies.push({ id: "MAExp@tv-basicstudies", inputs: { length: 200 } });
        break;
      case "BB":
        studies.push({ id: "BB@tv-basicstudies", inputs: { length: 20, mult: 2 } });
        break;
      case "ATR":
        studies.push({ id: "ATR@tv-basicstudies", inputs: { length: 14 } });
        break;
      case "RSI14":
        studies.push({ id: "RSI@tv-basicstudies", inputs: { length: 14 } });
        break;
      case "MACD":
        studies.push({ id: "MACD@tv-basicstudies" });
        break;
      default:
        break;
    }
  }

  return { studies, hide_volume };
}
