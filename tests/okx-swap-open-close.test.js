/**
 * OKX USDT 永续：市价开多（最小张）→ 再市价全平。
 *
 * 前置（模拟盘请用模拟站申请的 Key，并保持 simulated）：
 *   export OKX_API_KEY="..."
 *   export OKX_SECRET_KEY="..."
 *   export OKX_PASSPHRASE="..."
 *
 * 可选：
 *   OKX_SIMULATED      默认 1；设为 0 则走实盘（极危险，仅当你清楚后果）
 *   OKX_INST_ID        默认 BTC-USDT-SWAP
 *   OKX_LEVER          默认 10
 *   OKX_TD_MODE        cross | isolated，默认 cross
 *
 * 若报错「All operations failed」：请看终端里展开后的 [sCode] sMsg。
 * 常见原因：模拟盘 Key 与实盘 Key 混用；API 未开「交易」权限；Key 绑定了 IP 白名单但本机 IP 未加入；
 * Passphrase 与创建 Key 时不一致；模拟盘请勿设 OKX_SIMULATED=0。
 *
 * [51010] You can't complete this request under your current account mode：
 * 表示当前 OKX「交易账户模式」不支持合约/设杠杆（常见于仅现货）。请到 OKX 网页/App 将账户切换为支持合约的模式；
 * 冒烟测试里若仅 set-leverage 报 51010 会自动跳过设杠杆再下单。若下单仍 51010，必须先改账户模式。
 * 也可尝试：OKX_TD_MODE=isolated pnpm run test:okx
 *
 * 运行：
 *   pnpm run test:okx
 *   或：node --test tests/okx-swap-open-close.test.js
 */

"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const { smokeSwapOpenLongThenClose } = require("../okx-perp");

const apiKey = process.env.OKX_API_KEY?.trim();
const secretKey = process.env.OKX_SECRET_KEY?.trim();
const passphrase = process.env.OKX_PASSPHRASE?.trim();
const hasKeys = Boolean(apiKey && secretKey && passphrase);

const runner = hasKeys ? test : test.skip;

runner("OKX 永续：开多（最小张）后平仓", async () => {
  const simulated = process.env.OKX_SIMULATED !== "0" && process.env.OKX_SIMULATED !== "false";
  const instId = process.env.OKX_INST_ID?.trim() || "BTC-USDT-SWAP";
  const lever = Number(process.env.OKX_LEVER);
  const tdMode = process.env.OKX_TD_MODE === "isolated" ? "isolated" : "cross";

  const r = await smokeSwapOpenLongThenClose({
    apiKey,
    secretKey,
    passphrase,
    simulated,
    instId,
    tdMode,
    lever: Number.isFinite(lever) && lever >= 1 ? lever : 10,
  });

  assert.match(r.instId, /-SWAP$/);
  assert.ok(r.openSz && String(r.openSz).length > 0, "应返回开仓张数字符串");
  assert.ok(r.openOrdId || r.openClOrdId, "开仓应有 ordId 或 clOrdId");
  assert.ok(r.closeOrdId || r.closeClOrdId, "平仓应有 ordId 或 clOrdId");

  console.log("[okx-swap-open-close]", JSON.stringify(r, null, 2));
});

if (!hasKeys) {
  console.log(
    "跳过 OKX 集成测试：请设置环境变量 OKX_API_KEY、OKX_SECRET_KEY、OKX_PASSPHRASE 后重试。\n",
  );
}
