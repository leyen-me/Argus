/**
 * okx-perp：attachAlgoOrds 构造（无网络）。
 * 运行：pnpm run test:agent-tools
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { buildAttachAlgoOrdsForAgentOpen } = require(path.join(__dirname, "../src/node/okx-perp.js"));

const inst = { tickSz: 0.1 };

test("多头：有效 TP+SL，市价委托价为 -1", () => {
  const r = buildAttachAlgoOrdsForAgentOpen({
    isLong: true,
    entryRef: 100,
    inst,
    tpTriggerPx: 110,
    slTriggerPx: 90,
  });
  assert.equal(r.ok, true);
  assert.ok(r.attachAlgoOrds);
  assert.equal(r.attachAlgoOrds.length, 1);
  assert.equal(r.attachAlgoOrds[0].tpOrdPx, "-1");
  assert.equal(r.attachAlgoOrds[0].slOrdPx, "-1");
  assert.equal(r.attachAlgoOrds[0].tpTriggerPxType, "last");
});

test("多头：止盈低于参考价则拒绝", () => {
  const r = buildAttachAlgoOrdsForAgentOpen({
    isLong: true,
    entryRef: 100,
    inst,
    tpTriggerPx: 99,
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /多头止盈/);
});

test("空头：止损低于参考价则拒绝", () => {
  const r = buildAttachAlgoOrdsForAgentOpen({
    isLong: false,
    entryRef: 100,
    inst,
    slTriggerPx: 99,
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /空头止损/);
});

test("未传 TP/SL：attach 为 null", () => {
  const r = buildAttachAlgoOrdsForAgentOpen({
    isLong: true,
    entryRef: 100,
    inst,
  });
  assert.equal(r.ok, true);
  assert.equal(r.attachAlgoOrds, null);
});

test("仅止盈：单条 algo 只有 tp 字段", () => {
  const r = buildAttachAlgoOrdsForAgentOpen({
    isLong: false,
    entryRef: 100,
    inst,
    tpTriggerPx: 80,
  });
  assert.equal(r.ok, true);
  assert.ok(r.attachAlgoOrds[0].tpTriggerPx);
  assert.equal(r.attachAlgoOrds[0].slTriggerPx, undefined);
});

test("triggerPxType 为 mark", () => {
  const r = buildAttachAlgoOrdsForAgentOpen({
    isLong: true,
    entryRef: 100,
    inst,
    tpTriggerPx: 101,
    slTriggerPx: 99,
    triggerPxType: "mark",
  });
  assert.equal(r.ok, true);
  assert.equal(r.attachAlgoOrds[0].tpTriggerPxType, "mark");
  assert.equal(r.attachAlgoOrds[0].slTriggerPxType, "mark");
});
