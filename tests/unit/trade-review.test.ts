import { describe, expect, it } from "vitest";

import { extractAttribution, extractLessons } from "../../src/node/trade-review-agent.js";
import { hasSuccessfulMarketClose } from "../../src/node/trade-review-service.js";

describe("trade review helpers", () => {
  it("detects only successful market close as immediate review trigger", () => {
    expect(
      hasSuccessfulMarketClose([
        {
          name: "close_position",
          args: { order_type: "market" },
          result: { ok: true },
        },
      ]),
    ).toBe(true);

    expect(
      hasSuccessfulMarketClose([
        {
          name: "close_position",
          args: { order_type: "limit" },
          result: { ok: true },
        },
      ]),
    ).toBe(false);

    expect(
      hasSuccessfulMarketClose([
        {
          name: "close_position",
          args: { order_type: "market" },
          result: { ok: false },
        },
      ]),
    ).toBe(false);
  });

  it("extracts attribution and lessons from review markdown", () => {
    const text = [
      "## 结论归因",
      "主要是执行问题：没有遵守入场时的止损计划。",
      "",
      "## 下次改进清单",
      "- 入场前写清楚失效点。",
      "- 到达失效点必须执行，不再等待下一根 K 线。",
    ].join("\n");

    expect(extractAttribution(text)).toBe("execution_issue");
    expect(extractLessons(text)).toEqual([
      "入场前写清楚失效点。",
      "到达失效点必须执行，不再等待下一根 K 线。",
    ]);
  });
});
