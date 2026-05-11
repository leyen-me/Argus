import { describe, expect, it } from "vitest";

import {
  calculateChange,
  formatMarketEnvironmentForPrompt,
  okxInstIdsForPrompt,
  type MarketEnvironmentSnapshot,
} from "../../src/node/market-environment.js";

describe("market environment prompt", () => {
  it("formats grouped tables in the expected prompt order", () => {
    const snapshot: MarketEnvironmentSnapshot = {
      groups: [
        {
          key: "crypto",
          title: "### 加密货币（OKX SWAP）",
          rows: [
            {
              label: "BTC/USDT",
              price: 102000,
              changePct: 2,
              changeAbs: 2000,
              source: "OKX SWAP",
              updatedAt: "2026-05-11T04:47:12.000Z",
            },
          ],
        },
        {
          key: "usEquity",
          title: "### 美股 ETF",
          rows: [
            {
              label: "SPY",
              price: 500.12,
              changePct: -0.5,
              changeAbs: -2.51,
              source: "Yahoo Finance",
              updatedAt: "2026-05-10T20:00:00.000Z",
            },
          ],
        },
        {
          key: "fearIndex",
          title: "### 恐慌指数",
          rows: [],
          error: "HTTP 429",
        },
        {
          key: "gold",
          title: "### 黄金",
          rows: [
            {
              label: "黄金期货 GC=F",
              price: null,
              changePct: null,
              changeAbs: null,
              source: "Yahoo Finance",
              updatedAt: null,
              error: "无数据",
            },
          ],
        },
      ],
    };

    const text = formatMarketEnvironmentForPrompt(snapshot);

    expect(text.indexOf("### 加密货币（OKX SWAP）")).toBeLessThan(text.indexOf("### 美股 ETF"));
    expect(text.indexOf("### 美股 ETF")).toBeLessThan(text.indexOf("### 恐慌指数"));
    expect(text.indexOf("### 恐慌指数")).toBeLessThan(text.indexOf("### 黄金"));
    expect(text).toContain("| 标的 | 最新价 | 今日涨跌 | 数据源 | 更新时间 |");
    expect(text).toContain("| BTC/USDT | 102,000 | +2.00%（+2,000） | OKX SWAP | 05-11 04:47 |");
    expect(text).toContain("| SPY | 500.12 | -0.50%（-2.51） | Yahoo Finance | 05-10 20:00 |");
    expect(text).toContain("（拉取失败：HTTP 429）");
    expect(text).toContain("| 黄金期货 GC=F（无数据） | — | — | Yahoo Finance | — |");
  });

  it("deduplicates default crypto symbols with the current trading symbol", () => {
    expect(okxInstIdsForPrompt("OKX:BTCUSDT")).toEqual([
      "BTC-USDT-SWAP",
      "ETH-USDT-SWAP",
      "SOL-USDT-SWAP",
      "DOGE-USDT-SWAP",
    ]);

    expect(okxInstIdsForPrompt("OKX:XRPUSDT")).toEqual([
      "BTC-USDT-SWAP",
      "ETH-USDT-SWAP",
      "SOL-USDT-SWAP",
      "DOGE-USDT-SWAP",
      "XRP-USDT-SWAP",
    ]);
  });

  it("calculates signed absolute and percentage change from the session base", () => {
    expect(calculateChange(105, 100)).toEqual({ changeAbs: 5, changePct: 5 });
    expect(calculateChange(95, 100)).toEqual({ changeAbs: -5, changePct: -5 });
    expect(calculateChange(95, 0)).toEqual({ changeAbs: null, changePct: null });
  });
});
