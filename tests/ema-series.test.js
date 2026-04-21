/**
 * EMA 序列（与 prompt 内指标一致）
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { computeEmaSeries, EMA20_PERIOD } = require(path.join(__dirname, "../src/node/llm.js"));

test("computeEmaSeries：周期 3，SMA 种子 + 递推", () => {
  const s = computeEmaSeries([1, 2, 3, 4, 5], 3);
  assert.strictEqual(s[0], null);
  assert.strictEqual(s[1], null);
  assert.strictEqual(s[2], 2);
  assert.strictEqual(s[3], 3);
  assert.strictEqual(s[4], 4);
});

test("computeEmaSeries：不足 period 时全 null", () => {
  const s = computeEmaSeries([1, 2, 3], EMA20_PERIOD);
  assert.ok(s.every((v) => v === null));
});

test("computeEmaSeries：恰 20 根常数收盘，EMA20 最后等于该常数", () => {
  const closes = Array(20).fill(100);
  const s = computeEmaSeries(closes, EMA20_PERIOD);
  assert.strictEqual(s[19], 100);
});
