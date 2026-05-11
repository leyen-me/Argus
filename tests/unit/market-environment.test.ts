import { describe, expect, it } from "vitest";

import {
  calculateChange,
  formatMarketEnvironmentForPrompt,
  okxInstIdsForPrompt,
  type MarketEnvironmentSnapshot,
} from "../../src/node/market-environment.js";

describe("market environment prompt", () => {
  it("formats only the crypto grouped table", () => {
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
      ],
    };

    const text = formatMarketEnvironmentForPrompt(snapshot);

    expect(text).toContain("## 市场环境");
    expect(text).toContain("### 加密货币（OKX SWAP）");
    expect(text).not.toContain("### 美股 ETF");
    expect(text).not.toContain("### 恐慌指数");
    expect(text).not.toContain("### 黄金");
    expect(text).toContain("| 标的 | 最新价 | 今日涨跌 | 数据源 | 更新时间 |");
    expect(text).toContain("| BTC/USDT | 102,000 | +2.00%（+2,000） | OKX SWAP | 05-11 04:47 |");
  });

  it("deduplicates default crypto symbols with the current trading symbol", () => {
    expect(okxInstIdsForPrompt("OKX:BTCUSDT")).toEqual([
      "BTC-USDT-SWAP",
      "ETH-USDT-SWAP",
      "SOL-USDT-SWAP",
      "DOGE-USDT-SWAP",
      "OKB-USDT-SWAP",
      "BNB-USDT-SWAP",
      "ZEC-USDT-SWAP",
      "XRP-USDT-SWAP",
      "TRUMP-USDT-SWAP",
    ]);

    expect(okxInstIdsForPrompt("OKX:ADAUSDT")).toEqual([
      "BTC-USDT-SWAP",
      "ETH-USDT-SWAP",
      "SOL-USDT-SWAP",
      "DOGE-USDT-SWAP",
      "OKB-USDT-SWAP",
      "BNB-USDT-SWAP",
      "ZEC-USDT-SWAP",
      "XRP-USDT-SWAP",
      "TRUMP-USDT-SWAP",
      "ADA-USDT-SWAP",
    ]);
  });

  it("calculates signed absolute and percentage change from the session base", () => {
    expect(calculateChange(105, 100)).toEqual({ changeAbs: 5, changePct: 5 });
    expect(calculateChange(95, 100)).toEqual({ changeAbs: -5, changePct: -5 });
    expect(calculateChange(95, 0)).toEqual({ changeAbs: null, changePct: null });
  });
});
