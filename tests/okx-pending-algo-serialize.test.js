/**
 * okx-perp：算法挂单序列化、挂单摘要拉取（mock client）。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  serializePendingSwapAlgoOrder,
  fetchSwapPendingOrderSummaries,
} = require("../src/node/okx-perp.js");

test("serializePendingSwapAlgoOrder：止盈止损字段", () => {
  const row = {
    algoId: "1753184812254216192",
    ordType: "conditional",
    side: "sell",
    posSide: "long",
    state: "live",
    sz: "1",
    tpTriggerPx: "100000",
    slTriggerPx: "90000",
    tpTriggerPxType: "last",
    slTriggerPxType: "last",
    tpOrdPx: "-1",
    slOrdPx: "-1",
  };
  const s = serializePendingSwapAlgoOrder(row);
  assert.ok(s);
  assert.equal(s.algoId, "1753184812254216192");
  assert.equal(s.tpTriggerPx, "100000");
  assert.equal(s.slTriggerPx, "90000");
});

test("fetchSwapPendingOrderSummaries：算法单失败时不抛错", async () => {
  const client = {
    request(method, path) {
      if (path.includes("orders-pending?")) {
        return Promise.resolve({
          data: [{ ordId: "1", side: "buy", ordType: "limit", px: "1", sz: "1" }],
        });
      }
      if (path.includes("orders-algo-pending?")) {
        return Promise.reject(new Error("network"));
      }
      return Promise.resolve({ data: [] });
    },
  };
  const { pending_orders, pending_algo_orders } = await fetchSwapPendingOrderSummaries(
    client,
    "BTC-USDT-SWAP",
  );
  assert.equal(pending_orders.length, 1);
  assert.equal(pending_algo_orders.length, 0);
});
