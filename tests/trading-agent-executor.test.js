/**
 * 交易 Agent 工具执行器单元测试（mock OKX，不连网）。
 * 运行：pnpm run test:agent-tools
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  createTradingToolExecutor,
  TRADING_EXECUTOR_DEFAULT_DEPS,
  requireOkx,
} = require(path.join(__dirname, "../src/node/trading-agent-executor.js"));

const TV_OKX = "OKX:BTCUSDT";
const BAR_ID = "test-bar-close-id";

/** 与 baseCfg 默认一致；open_position 工具应显式传入，缺省时执行层回退到 cfg */
const OPEN_RISK = Object.freeze({
  leverage: 10,
  margin_fraction: 0.25,
  margin_mode: "isolated",
});

function baseCfg(over = {}) {
  return {
    okxSwapTradingEnabled: true,
    okxApiKey: "test-key",
    okxSecretKey: "test-secret",
    okxPassphrase: "test-pass",
    okxSimulated: true,
    okxTdMode: "isolated",
    okxSwapLeverage: 10,
    okxSwapMarginFraction: 0.25,
    ...over,
  };
}

function mockWin() {
  const sent = [];
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => {
        sent.push({ channel, payload });
      },
    },
    getSent: () => sent,
  };
}

function depsWith(overrides) {
  return { ...TRADING_EXECUTOR_DEFAULT_DEPS, ...overrides };
}

test("requireOkx：未启用永续", () => {
  const r = requireOkx(baseCfg({ okxSwapTradingEnabled: false }));
  assert.equal(r.ok, false);
  assert.match(r.message, /启用/);
});

test("requireOkx：缺 API Key", () => {
  const r = requireOkx(baseCfg({ okxApiKey: "   " }));
  assert.equal(r.ok, false);
  assert.match(r.message, /未配置完整/);
});

test("requireOkx：cfg 为 null", () => {
  const r = requireOkx(null);
  assert.equal(r.ok, false);
});

test("requireOkx：通过", () => {
  const r = requireOkx(baseCfg());
  assert.equal(r.ok, true);
});

test("preview_open_size：未启用 OKX 直接拒绝", async () => {
  const exec = createTradingToolExecutor(
    {
      cfg: baseCfg({ okxSwapTradingEnabled: false }),
      tvSymbol: TV_OKX,
      barCloseId: BAR_ID,
      win: null,
    },
    depsWith({
      executeAgentPerpPreviewOpen: async () => {
        throw new Error("不应调用交易所");
      },
    }),
  );
  const out = await exec("preview_open_size", { leverage: 10 });
  assert.equal(out.ok, false);
  assert.match(out.message, /启用/);
});

test("preview_open_size：参数传入 executeAgentPerpPreviewOpen", async () => {
  let seen = null;
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      executeAgentPerpPreviewOpen: async (c, a) => {
        seen = a;
        return { ok: true, estimated_contracts: 0.01, meets_min_sz: true, usdt_avail_eq: 500 };
      },
    }),
  );
  const out = await exec("preview_open_size", {
    leverage: 7,
    margin_fraction: 0.15,
    margin_mode: "cross",
  });
  assert.equal(out.ok, true);
  assert.equal(out.estimated_contracts, 0.01);
  assert.ok(seen);
  assert.equal(seen.tvSymbol, TV_OKX);
  assert.equal(seen.leverage, 7);
  assert.equal(seen.margin_fraction, 0.15);
  assert.equal(seen.margin_mode, "cross");
});

test("open_position：未启用 OKX 直接拒绝", async () => {
  const exec = createTradingToolExecutor(
    {
      cfg: baseCfg({ okxSwapTradingEnabled: false }),
      tvSymbol: TV_OKX,
      barCloseId: BAR_ID,
      win: null,
    },
    depsWith({
      executeAgentPerpOpen: async () => {
        throw new Error("不应调用交易所");
      },
    }),
  );
  const out = await exec("open_position", { ...OPEN_RISK, side: "long", order_type: "market" });
  assert.equal(out.ok, false);
  assert.match(out.message, /启用/);
});

test("open_position：交易所返回失败", async () => {
  let called = null;
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      executeAgentPerpOpen: async (cfg, args) => {
        called = { cfg, args };
        return { ok: false, message: "已有持仓" };
      },
    }),
  );
  const out = await exec("open_position", { ...OPEN_RISK, side: "long", order_type: "market" });
  assert.equal(out.ok, false);
  assert.equal(out.message, "已有持仓");
  assert.ok(called);
  assert.equal(called.args.side, "long");
  assert.equal(called.args.orderType, "market");
  assert.equal(called.args.tvSymbol, TV_OKX);
  assert.equal(called.args.barCloseId, BAR_ID);
});

test("open_position：市价成功", async () => {
  const win = mockWin();
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win },
    depsWith({
      executeAgentPerpOpen: async () => ({
        ok: true,
        ordId: "ord-m-1",
        sz: "0.01",
        avgPx: 99_000,
      }),
    }),
  );
  const out = await exec("open_position", { ...OPEN_RISK, side: "long", order_type: "market" });
  assert.equal(out.ok, true);
  assert.match(out.message, /ord-m-1/);
  assert.equal(out.exchange.ordId, "ord-m-1");
  assert.equal(out.exchange.avgPx, 99_000);
  const st = win.getSent().filter((x) => x.channel === "okx-swap-status");
  assert.equal(st.length >= 1, true);
  assert.equal(st[0].payload.ok, true);
  assert.equal(st[0].payload.tvSymbol, TV_OKX);
});

test("open_position：限价成功文案", async () => {
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      executeAgentPerpOpen: async () => ({
        ok: true,
        ordId: "ord-l-1",
        sz: "0.02",
        avgPx: null,
      }),
    }),
  );
  const out = await exec("open_position", {
    ...OPEN_RISK,
    side: "short",
    order_type: "limit",
    limit_price: 98_000,
  });
  assert.equal(out.ok, true);
  assert.match(out.message, /限价/);
});

test("open_position：止盈止损与触发类型传入 executeAgentPerpOpen", async () => {
  let argsSeen = null;
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      executeAgentPerpOpen: async (_c, a) => {
        argsSeen = a;
        return { ok: true, ordId: "ord-tp" };
      },
    }),
  );
  const out = await exec("open_position", {
    ...OPEN_RISK,
    side: "long",
    order_type: "market",
    take_profit_trigger_price: 100_000,
    stop_loss_trigger_price: 90_000,
    tp_sl_trigger_price_type: "mark",
  });
  assert.equal(out.ok, true);
  assert.ok(argsSeen);
  assert.equal(argsSeen.tpTriggerPx, 100_000);
  assert.equal(argsSeen.slTriggerPx, 90_000);
  assert.equal(argsSeen.tpSlTriggerPxType, "mark");
});

test("open_position：tp_sl_trigger_price_type 非法时回退 last", async () => {
  let argsSeen = null;
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      executeAgentPerpOpen: async (_c, a) => {
        argsSeen = a;
        return { ok: true, ordId: "x" };
      },
    }),
  );
  await exec("open_position", {
    ...OPEN_RISK,
    side: "long",
    order_type: "market",
    take_profit_trigger_price: 99_000,
    tp_sl_trigger_price_type: "bogus",
  });
  assert.equal(argsSeen.tpSlTriggerPxType, "last");
});

test("open_position：side 默认 long；非法字符串视为 long", async () => {
  let sideSeen = null;
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      executeAgentPerpOpen: async (_c, a) => {
        sideSeen = a.side;
        return { ok: true, ordId: "x" };
      },
    }),
  );
  await exec("open_position", { ...OPEN_RISK, order_type: "market" });
  assert.equal(sideSeen, "long");
  await exec("open_position", { ...OPEN_RISK, side: "bogus", order_type: "market" });
  assert.equal(sideSeen, "long");
});

test("open_position：SHORT 传入", async () => {
  let sideSeen = null;
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      executeAgentPerpOpen: async (_c, a) => {
        sideSeen = a.side;
        return { ok: true, ordId: "x" };
      },
    }),
  );
  await exec("open_position", { ...OPEN_RISK, side: "short", order_type: "market" });
  assert.equal(sideSeen, "short");
});

test("open_position：order_type 默认 market", async () => {
  let ot = null;
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      executeAgentPerpOpen: async (_c, a) => {
        ot = a.orderType;
        return { ok: true, ordId: "x" };
      },
    }),
  );
  await exec("open_position", { ...OPEN_RISK, side: "long" });
  assert.equal(ot, "market");
});

test("open_position：args 为 null 不抛错", async () => {
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      executeAgentPerpOpen: async () => ({ ok: true, ordId: "z" }),
    }),
  );
  const out = await exec("open_position", null);
  assert.equal(out.ok, true);
});

test("open_position：杠杆/保证金参数传入 executeAgentPerpOpen", async () => {
  let argsSeen = null;
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      executeAgentPerpOpen: async (_c, a) => {
        argsSeen = a;
        return { ok: true, ordId: "r" };
      },
    }),
  );
  await exec("open_position", {
    side: "long",
    order_type: "market",
    leverage: 5,
    margin_fraction: 0.1,
    margin_mode: "cross",
  });
  assert.ok(argsSeen);
  assert.equal(argsSeen.leverage, 5);
  assert.equal(argsSeen.margin_fraction, 0.1);
  assert.equal(argsSeen.margin_mode, "cross");
});

test("close_position：未启用", async () => {
  const exec = createTradingToolExecutor(
    {
      cfg: baseCfg({ okxSwapTradingEnabled: false }),
      tvSymbol: TV_OKX,
      barCloseId: BAR_ID,
      win: null,
    },
    depsWith({ executeAgentPerpClose: async () => ({ ok: true }) }),
  );
  const out = await exec("close_position", { order_type: "market" });
  assert.equal(out.ok, false);
});

test("close_position：失败", async () => {
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      executeAgentPerpClose: async () => ({ ok: false, message: "无持仓可平" }),
    }),
  );
  const out = await exec("close_position", { order_type: "market" });
  assert.equal(out.ok, false);
  assert.equal(out.message, "无持仓可平");
});

test("close_position：成功", async () => {
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      executeAgentPerpClose: async (_c, a) => {
        assert.equal(a.orderType, "limit");
        assert.equal(a.limitPrice, 97_000);
        return { ok: true, ordId: "c-1", closeSz: "0.01" };
      },
    }),
  );
  const out = await exec("close_position", { order_type: "limit", limit_price: 97_000 });
  assert.equal(out.ok, true);
  assert.equal(out.exchange.ordId, "c-1");
});

test("close_position：order_type 默认 market", async () => {
  let ot = null;
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      executeAgentPerpClose: async (_c, a) => {
        ot = a.orderType;
        return { ok: true, ordId: "x" };
      },
    }),
  );
  await exec("close_position", {});
  assert.equal(ot, "market");
});

test("cancel_order：无效品种（非 OKX 代码）", async () => {
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: "BINANCE:BTCUSDT", barCloseId: BAR_ID, win: null },
    depsWith({
      tvSymbolToSwapInstId: () => null,
      cancelSwapOrder: async () => {
        throw new Error("不应撤单");
      },
    }),
  );
  const out = await exec("cancel_order", { order_id: "123" });
  assert.equal(out.ok, false);
  assert.equal(out.message, "无效品种");
});

test("cancel_order：未启用 OKX（makeClient 失败）", async () => {
  const exec = createTradingToolExecutor(
    {
      cfg: baseCfg({ okxSwapTradingEnabled: false }),
      tvSymbol: TV_OKX,
      barCloseId: BAR_ID,
      win: null,
    },
    depsWith({ cancelSwapOrder: async () => {} }),
  );
  const out = await exec("cancel_order", { order_id: "1" });
  assert.equal(out.ok, false);
});

test("cancel_order：成功", async () => {
  let cancelArgs = null;
  const fakeClient = {};
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      createOkxClient: () => fakeClient,
      tvSymbolToSwapInstId: () => "BTC-USDT-SWAP",
      cancelSwapOrder: async (client, instId, ordId) => {
        cancelArgs = { client, instId, ordId };
      },
    }),
  );
  const out = await exec("cancel_order", { order_id: "998877" });
  assert.equal(out.ok, true);
  assert.equal(cancelArgs.client, fakeClient);
  assert.equal(cancelArgs.instId, "BTC-USDT-SWAP");
  assert.equal(cancelArgs.ordId, "998877");
});

test("cancel_order：order_id 为数字时转为字符串", async () => {
  let ordId = null;
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      createOkxClient: () => ({}),
      tvSymbolToSwapInstId: () => "BTC-USDT-SWAP",
      cancelSwapOrder: async (_c, _i, id) => {
        ordId = id;
      },
    }),
  );
  await exec("cancel_order", { order_id: 12_345 });
  assert.equal(ordId, "12345");
  assert.equal(typeof ordId, "string");
});

test("cancel_order：交易所抛错", async () => {
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      createOkxClient: () => ({}),
      tvSymbolToSwapInstId: () => "BTC-USDT-SWAP",
      cancelSwapOrder: async () => {
        throw new Error("OKX 51004");
      },
    }),
  );
  const out = await exec("cancel_order", { order_id: "1" });
  assert.equal(out.ok, false);
  assert.match(out.message, /51004/);
});

test("amend_order：缺少 new_price 与 new_size", async () => {
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      createOkxClient: () => ({}),
      tvSymbolToSwapInstId: () => "BTC-USDT-SWAP",
      amendSwapOrder: async () => {
        throw new Error("不应调用");
      },
    }),
  );
  const out = await exec("amend_order", { order_id: "1" });
  assert.equal(out.ok, false);
  assert.match(out.message, /new_price|new_size/);
});

test("amend_order：无效品种", async () => {
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: "FOO", barCloseId: BAR_ID, win: null },
    depsWith({
      tvSymbolToSwapInstId: () => null,
      amendSwapOrder: async () => {},
    }),
  );
  const out = await exec("amend_order", { order_id: "1", new_price: 1 });
  assert.equal(out.message, "无效品种");
});

test("amend_order：仅 new_price", async () => {
  let patch = null;
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      createOkxClient: () => ({}),
      tvSymbolToSwapInstId: () => "BTC-USDT-SWAP",
      amendSwapOrder: async (_client, p) => {
        patch = p;
      },
    }),
  );
  const out = await exec("amend_order", { order_id: "55", new_price: 100.5 });
  assert.equal(out.ok, true);
  assert.equal(patch.instId, "BTC-USDT-SWAP");
  assert.equal(patch.ordId, "55");
  assert.equal(patch.newPx, 100.5);
  assert.equal(patch.newSz, undefined);
});

test("amend_order：仅 new_size", async () => {
  let patch = null;
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      createOkxClient: () => ({}),
      tvSymbolToSwapInstId: () => "ETH-USDT-SWAP",
      amendSwapOrder: async (_c, p) => {
        patch = p;
      },
    }),
  );
  const out = await exec("amend_order", { order_id: "66", new_size: 0.1 });
  assert.equal(out.ok, true);
  assert.equal(patch.newSz, 0.1);
  assert.equal(patch.newPx, undefined);
});

test("amend_order：new_price 为 0 视为有效（交给 OKX）", async () => {
  let patch = null;
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win: null },
    depsWith({
      createOkxClient: () => ({}),
      tvSymbolToSwapInstId: () => "BTC-USDT-SWAP",
      amendSwapOrder: async (_c, p) => {
        patch = p;
      },
    }),
  );
  const out = await exec("amend_order", { order_id: "7", new_price: 0 });
  assert.equal(out.ok, true);
  assert.equal(patch.newPx, 0);
});

test("未知工具名", async () => {
  const exec = createTradingToolExecutor({
    cfg: baseCfg(),
    tvSymbol: TV_OKX,
    barCloseId: BAR_ID,
    win: null,
  });
  const out = await exec("not_a_real_tool", {});
  assert.equal(out.ok, false);
  assert.match(out.message, /未知工具/);
});

test("destroyed 的 win 不发送 IPC", async () => {
  const win = {
    isDestroyed: () => true,
    webContents: {
      send: () => {
        throw new Error("不应 send");
      },
    },
  };
  const exec = createTradingToolExecutor(
    { cfg: baseCfg(), tvSymbol: TV_OKX, barCloseId: BAR_ID, win },
    depsWith({
      executeAgentPerpOpen: async () => ({ ok: true, ordId: "a" }),
    }),
  );
  const out = await exec("open_position", { ...OPEN_RISK, side: "long", order_type: "market" });
  assert.equal(out.ok, true);
});
