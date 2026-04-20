/**
 * 校验 trading-agent-tools 定义完整（名称唯一、参数结构合理）。
 * 运行：pnpm run test:agent-tools（与 executor 测试同脚本）或单独 node --test tests/trading-agent-tools-schema.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { TRADING_AGENT_TOOLS } = require(path.join(__dirname, "../src/node/trading-agent-tools.js"));

test("工具数量与名称唯一", () => {
  assert.equal(TRADING_AGENT_TOOLS.length, 4);
  const names = TRADING_AGENT_TOOLS.map((t) => t.function.name);
  assert.deepEqual(new Set(names).size, names.length);
  assert.ok(names.includes("open_position"));
  assert.ok(names.includes("close_position"));
  assert.ok(names.includes("cancel_order"));
  assert.ok(names.includes("amend_order"));
});

test("每项为 function 类型且含 parameters", () => {
  for (const t of TRADING_AGENT_TOOLS) {
    assert.equal(t.type, "function");
    assert.ok(t.function?.name);
    assert.ok(t.function?.description);
    const params = t.function.parameters;
    assert.equal(params?.type, "object");
    assert.ok(Array.isArray(params.required) || params.required === undefined);
  }
});

test("open_position：required 字段", () => {
  const t = TRADING_AGENT_TOOLS.find((x) => x.function.name === "open_position");
  assert.deepEqual(
    t.function.parameters.required.sort(),
    ["leverage", "margin_fraction", "margin_mode", "order_type", "side"].sort(),
  );
});

test("cancel_order：order_id 必填", () => {
  const t = TRADING_AGENT_TOOLS.find((x) => x.function.name === "cancel_order");
  assert.ok(t.function.parameters.required.includes("order_id"));
});
