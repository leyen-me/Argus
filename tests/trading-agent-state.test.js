/**
 * Agent 辅助状态转移。
 * 运行：node --test tests/trading-agent-state.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const {
  wipeTradingStateStore,
  agentPrepareWatch,
  agentCanOpen,
  applyAgentOpenFilled,
  applyAgentClose,
  getTradingState,
  MIN_ENTER_CONFIDENCE,
} = require(path.join(__dirname, "../src/node/trading-state.js"));

const KEY = "TEST:AGENT|1";
const t0 = () => 1_700_000_000_000;

test("agent open from IDLE respects MIN_ENTER_CONFIDENCE", () => {
  wipeTradingStateStore();
  const candle = { high: 101, low: 99, close: 100 };
  const low = agentCanOpen(KEY, candle, { side: "LONG", confidence: MIN_ENTER_CONFIDENCE - 1 }, t0());
  assert.equal(low.ok, false);
  const ok = agentCanOpen(KEY, candle, { side: "LONG", confidence: MIN_ENTER_CONFIDENCE }, t0());
  assert.equal(ok.ok, true);
});

test("prepare_watch then open long uses confirmEntry", () => {
  wipeTradingStateStore();
  const now = t0();
  const r0 = agentPrepareWatch(
    KEY,
    { direction: "long", keyLevel: 100, confidence: 85 },
    now,
  );
  assert.equal(r0.ok, true);
  const bad = agentCanOpen(KEY, { high: 99, low: 98, close: 98.5 }, { side: "LONG", confidence: 85 }, now + 1);
  assert.equal(bad.ok, false);
  const good = agentCanOpen(KEY, { high: 102, low: 99, close: 101 }, { side: "LONG", confidence: 85 }, now + 2);
  assert.equal(good.ok, true);
  const fill = applyAgentOpenFilled(
    KEY,
    { close: 101 },
    { side: "LONG", entryPrice: 101, stopLoss: 99, takeProfit: 103 },
    now + 3,
  );
  assert.equal(fill.ok, true);
  assert.equal(getTradingState(KEY).state, "HOLDING_LONG");
});

test("applyAgentClose enters cooldown from holding", () => {
  wipeTradingStateStore();
  const now = t0();
  applyAgentOpenFilled(KEY, { close: 100 }, { side: "SHORT", entryPrice: 100 }, now);
  const c = applyAgentClose(KEY, { confidence: 95 }, now + 1);
  assert.equal(c.ok, true);
  assert.equal(getTradingState(KEY).state, "COOLDOWN");
});
