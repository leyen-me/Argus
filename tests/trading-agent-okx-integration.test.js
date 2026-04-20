/**
 * Agent 工具 → 真实 OKX 永续 API（与 smoke 测试共用环境变量）。
 *
 * 顺序：先尝试平仓清持仓 → 市价开多（附带 attachAlgo 止盈止损）→ 市价平 → 挂远价限价多单（不成交）→ 改价 → 撤单。
 *
 * 前置（与 tests/okx-swap-open-close.test.js 一致）：
 *   export OKX_API_KEY="..."
 *   export OKX_SECRET_KEY="..."
 *   export OKX_PASSPHRASE="..."
 *
 * 可选：
 *   OKX_SIMULATED      默认模拟盘
 *   OKX_INST_ID        默认 BTC-USDT-SWAP
 *   OKX_LEVER / OKX_TD_MODE  同 okx-swap-open-close
 *   OKX_LIMIT_FRAC     限价开仓价 = last * 该系数，默认 0.5（远低于市价，买单不成交）
 *
 * 运行：
 *   pnpm run test:okx:agent
 *   或并入：pnpm run test:okx
 */

"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const path = require("path");

const { createTradingToolExecutor } = require(path.join(__dirname, "../src/node/trading-agent-executor.js"));
const {
  tvSymbolToSwapInstId,
  fetchTickerLast,
  fetchSwapInstrument,
  formatOkxPx,
} = require(path.join(__dirname, "../src/node/okx-perp.js"));

const apiKey = process.env.OKX_API_KEY?.trim();
const secretKey = process.env.OKX_SECRET_KEY?.trim();
const passphrase = process.env.OKX_PASSPHRASE?.trim();
const hasKeys = Boolean(apiKey && secretKey && passphrase);

/** @param {string} instId 如 BTC-USDT-SWAP */
function instIdToTvSymbol(instId) {
  const id = String(instId || "").trim().toUpperCase();
  const m = /^([A-Z0-9]+)-USDT-SWAP$/.exec(id);
  if (!m) {
    throw new Error(`OKX_INST_ID 须为 *-USDT-SWAP，当前：${instId}`);
  }
  return `OKX:${m[1]}USDT`;
}

function testCfg() {
  const lever = Number(process.env.OKX_LEVER);
  return {
    okxSwapTradingEnabled: true,
    okxApiKey: apiKey,
    okxSecretKey: secretKey,
    okxPassphrase: passphrase,
    okxSimulated: process.env.OKX_SIMULATED !== "0" && process.env.OKX_SIMULATED !== "false",
    okxTdMode: process.env.OKX_TD_MODE === "cross" ? "cross" : "isolated",
    okxSwapLeverage: Number.isFinite(lever) && lever >= 1 ? Math.floor(lever) : 10,
    okxSwapMarginFraction: 0.25,
  };
}

if (!hasKeys) {
  console.log(
    "跳过 trading-agent-okx-integration：请设置 OKX_API_KEY、OKX_SECRET_KEY、OKX_PASSPHRASE 后执行 pnpm run test:okx:agent\n",
  );
}

test(
  "OKX：Agent 工具链（真实 API，顺序执行）",
  { skip: !hasKeys },
  async (t) => {
    const instId = process.env.OKX_INST_ID?.trim() || "BTC-USDT-SWAP";
    const tvSymbol = instIdToTvSymbol(instId);
    assert.strictEqual(tvSymbolToSwapInstId(tvSymbol), instId);

    const cfg = testCfg();
    const barCloseId = `agent-int-${Date.now()}`;
    const exec = createTradingToolExecutor({
      cfg,
      tvSymbol,
      barCloseId,
      win: null,
    });

    await t.test("close_position 市价：清理已有持仓（无仓则失败可接受）", async () => {
      const r = await exec("close_position", { order_type: "market" });
      if (!r.ok) {
        assert.match(String(r.message), /无持仓/);
      } else {
        assert.ok(r.exchange?.ordId || r.message);
      }
    });

    await t.test("open_position 市价：开多（附带止盈止损 attachAlgoOrds）", async () => {
      const last = await fetchTickerLast(instId);
      const inst = await fetchSwapInstrument(instId);
      const tp = parseFloat(formatOkxPx(last * 1.06, inst.tickSz));
      const sl = parseFloat(formatOkxPx(last * 0.94, inst.tickSz));
      const r = await exec("open_position", {
        side: "long",
        order_type: "market",
        take_profit_trigger_price: tp,
        stop_loss_trigger_price: sl,
      });
      assert.strictEqual(r.ok, true, r.message || JSON.stringify(r));
      assert.ok(r.exchange?.ordId, "应有 ordId");
      console.log("[agent-int] open market + tp/sl", { tp, sl, r });
    });

    await t.test("close_position 市价：全平", async () => {
      const r = await exec("close_position", { order_type: "market" });
      assert.strictEqual(r.ok, true, r.message || JSON.stringify(r));
      assert.ok(r.exchange?.ordId, "应有 ordId");
      console.log("[agent-int] close market", r);
    });

    let pendingOrdId = "";

    await t.test("open_position 限价：远价买单挂单不成交", async () => {
      const last = await fetchTickerLast(instId);
      const inst = await fetchSwapInstrument(instId);
      const frac = Number(process.env.OKX_LIMIT_FRAC);
      const f = Number.isFinite(frac) && frac > 0 && frac < 1 ? frac : 0.5;
      const limitPrice = parseFloat(formatOkxPx(last * f, inst.tickSz));
      const r = await exec("open_position", {
        side: "long",
        order_type: "limit",
        limit_price: limitPrice,
      });
      assert.strictEqual(r.ok, true, r.message || JSON.stringify(r));
      assert.ok(r.exchange?.ordId, "限价应返回 ordId");
      pendingOrdId = String(r.exchange.ordId);
      console.log("[agent-int] open limit", { last, limitPrice, pendingOrdId, r });
    });

    await t.test("amend_order：修改挂单价格", async () => {
      assert.ok(pendingOrdId, "上一测应写入 pendingOrdId");
      const last = await fetchTickerLast(instId);
      const inst = await fetchSwapInstrument(instId);
      const frac = Number(process.env.OKX_LIMIT_FRAC);
      const f = Number.isFinite(frac) && frac > 0 && frac < 1 ? frac : 0.5;
      const basePx = parseFloat(formatOkxPx(last * f, inst.tickSz));
      const bumped = parseFloat(formatOkxPx(basePx * 1.002, inst.tickSz));
      const r = await exec("amend_order", {
        order_id: pendingOrdId,
        new_price: bumped,
      });
      assert.strictEqual(r.ok, true, r.message || JSON.stringify(r));
      console.log("[agent-int] amend", { bumped, r });
    });

    await t.test("cancel_order：撤销挂单", async () => {
      assert.ok(pendingOrdId);
      const r = await exec("cancel_order", { order_id: pendingOrdId });
      assert.strictEqual(r.ok, true, r.message || JSON.stringify(r));
      console.log("[agent-int] cancel", r);
    });
  },
);
