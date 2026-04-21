/**
 * OKX 最近 K 线：周期映射 + 非 OKX 品种行为（不依赖连网）。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { tvIntervalToOkxCandleBar, fetchRecentCandlesForTv } = require(path.join(
  __dirname,
  "../src/node/okx-perp.js",
));

test("tvIntervalToOkxCandleBar 与 crypto-scheduler 周期一致", () => {
  assert.strictEqual(tvIntervalToOkxCandleBar("5"), "5m");
  assert.strictEqual(tvIntervalToOkxCandleBar("60"), "1H");
  assert.strictEqual(tvIntervalToOkxCandleBar("240"), "4H");
  assert.strictEqual(tvIntervalToOkxCandleBar("D"), "1D");
  assert.strictEqual(tvIntervalToOkxCandleBar("1D"), "1D");
});

test("fetchRecentCandlesForTv：非 OKX: 前缀不请求", async () => {
  const r = await fetchRecentCandlesForTv("BINANCE:BTCUSDT", "5", 30);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.rows.length, 0);
  assert.match(r.error || "", /非 OKX/);
});
