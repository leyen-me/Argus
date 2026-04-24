const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const dashboardService = require(path.join(__dirname, "../src/node/dashboard-service.js"));
const dashboardStore = require(path.join(__dirname, "../src/node/dashboard-store.js"));

test("buildEquitySeriesForDashboard：未提供策略起点时不返回总账户曲线", () => {
  const original = dashboardStore.listRecentEquitySamples;
  let called = false;
  dashboardStore.listRecentEquitySamples = () => {
    called = true;
    return [{ t: "2026-01-01T00:00:00.000Z", equity: 100 }];
  };

  try {
    const series = dashboardService.buildEquitySeriesForDashboard(null);
    assert.deepEqual(series, []);
    assert.equal(called, false);
  } finally {
    dashboardStore.listRecentEquitySamples = original;
  }
});

test("buildEquitySeriesForDashboard：按策略起点截取并保留时间顺序", () => {
  const original = dashboardStore.listRecentEquitySamples;
  dashboardStore.listRecentEquitySamples = () => [
    { t: "2026-01-01T00:00:00.000Z", equity: 100 },
    { t: "2026-01-01T00:01:00.000Z", equity: 101 },
    { t: "2026-01-01T00:02:00.000Z", equity: 103 },
  ];

  try {
    const series = dashboardService.buildEquitySeriesForDashboard("2026-01-01T00:01:00.000Z");
    assert.deepEqual(series, [
      { t: "2026-01-01T00:01:00.000Z", equity: 101 },
      { t: "2026-01-01T00:02:00.000Z", equity: 103 },
    ]);
  } finally {
    dashboardStore.listRecentEquitySamples = original;
  }
});
