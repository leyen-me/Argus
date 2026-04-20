/**
 * 交易状态机：持仓 HOLD 时更新 stopLoss / takeProfit。
 * 运行：node --test tests/trading-state-hold-risk.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const {
  wipeTradingStateStore,
  applyTradingDecision,
  getTradingState,
  MIN_HOLD_RISK_ADJUST_CONFIDENCE,
} = require(path.join(__dirname, "../src/node/trading-state.js"));

const KEY = "TEST:BTC|5";
const now = () => 1_700_000_000_000;

test("HOLD updates SL/TP when confidence >= MIN_HOLD_RISK_ADJUST_CONFIDENCE", () => {
  wipeTradingStateStore();
  const t = now();
  const candleBase = { high: 102, low: 99, close: 101 };

  assert.equal(applyTradingDecision(KEY, candleBase, { intent: "LOOK_LONG", confidence: 85, keyLevel: 100 }, t).applied, true);
  assert.equal(
    applyTradingDecision(KEY, candleBase, { intent: "ENTER_LONG", confidence: 85, keyLevel: 100 }, t).applied,
    true,
  );

  let ts = getTradingState(KEY);
  assert.equal(ts.state, "HOLDING_LONG");
  const prevSl = ts.stopLoss;
  const prevTp = ts.takeProfit;
  assert.ok(prevSl != null && prevTp != null);

  const r = applyTradingDecision(
    KEY,
    candleBase,
    {
      intent: "HOLD",
      confidence: MIN_HOLD_RISK_ADJUST_CONFIDENCE,
      stopLoss: 98.5,
      takeProfit: 103,
    },
    t + 1,
  );
  assert.equal(r.applied, true);
  assert.match(r.transition, /HOLDING_LONG->HOLDING_LONG \[risk\]/);
  ts = getTradingState(KEY);
  assert.notEqual(ts.stopLoss, prevSl);
  assert.notEqual(ts.takeProfit, prevTp);
  assert.equal(ts.stopLoss, 98.5);
  assert.equal(ts.takeProfit, 103);
});

test("HOLD does not update SL when confidence below threshold", () => {
  wipeTradingStateStore();
  const t = now();
  const candleBase = { high: 102, low: 99, close: 101 };

  applyTradingDecision(KEY, candleBase, { intent: "LOOK_LONG", confidence: 85, keyLevel: 100 }, t);
  applyTradingDecision(KEY, candleBase, { intent: "ENTER_LONG", confidence: 85, keyLevel: 100 }, t);
  const ts0 = getTradingState(KEY);
  const sl0 = ts0.stopLoss;

  const r = applyTradingDecision(
    KEY,
    candleBase,
    { intent: "HOLD", confidence: MIN_HOLD_RISK_ADJUST_CONFIDENCE - 1, stopLoss: 50 },
    t + 1,
  );
  assert.equal(r.applied, true);
  assert.equal(r.transition, "HOLDING_LONG->HOLDING_LONG");
  assert.equal(getTradingState(KEY).stopLoss, sl0);
});

test("HOLD with no SL/TP leaves prices unchanged", () => {
  wipeTradingStateStore();
  const t = now();
  const candleBase = { high: 102, low: 99, close: 101 };

  applyTradingDecision(KEY, candleBase, { intent: "LOOK_LONG", confidence: 85, keyLevel: 100 }, t);
  applyTradingDecision(KEY, candleBase, { intent: "ENTER_LONG", confidence: 85, keyLevel: 100 }, t);
  const ts0 = getTradingState(KEY);

  const r = applyTradingDecision(
    KEY,
    candleBase,
    { intent: "HOLD", confidence: 90, stopLoss: null, takeProfit: null },
    t + 1,
  );
  assert.equal(r.transition, "HOLDING_LONG->HOLDING_LONG");
  assert.deepEqual(getTradingState(KEY).stopLoss, ts0.stopLoss);
  assert.deepEqual(getTradingState(KEY).takeProfit, ts0.takeProfit);
});
