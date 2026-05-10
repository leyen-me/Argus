import * as cryptoSched from "../../../src/node/crypto-scheduler.js";
import { inferFeed } from "../../../src/node/market.js";
import * as promptStrategiesStore from "../../../src/node/prompt-strategies-store.js";
import { publish } from "../../../src/node/runtime-bus.js";
import { normalizeStrategyDecisionIntervalTv } from "../../../src/shared/strategy-fields.js";

type MarketRouteConfig = {
  promptStrategyDecisionIntervalTv?: unknown;
  promptStrategy?: unknown;
  defaultSymbol?: unknown;
};

/**
 * Route the active market subscription while preserving the current public
 * behavior for unsupported symbols.
 */
export async function routeMarket(cfg: MarketRouteConfig, tvSymbol?: unknown) {
  const interval =
    typeof cfg.promptStrategyDecisionIntervalTv === "string"
      ? normalizeStrategyDecisionIntervalTv(cfg.promptStrategyDecisionIntervalTv)
      : await promptStrategiesStore.getDecisionIntervalTvForStrategyId(cfg.promptStrategy);
  const sym = tvSymbol || cfg.defaultSymbol;
  const feed = inferFeed(sym);

  if (feed === "crypto") {
    cryptoSched.start(sym, interval);
    return;
  }

  cryptoSched.stop();
  publish("market-status", {
    text: `当前品种需为 OKX: 前缀（如 OKX:BTCUSDT），无法为 ${sym} 订阅行情。请在策略中心为该策略绑定支持的代币（BTC / ETH / SOL / DOGE）。`,
  });
}
