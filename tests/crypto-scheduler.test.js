/**
 * OKX WS 调度器：静默断流自愈。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  start,
  stop,
  okxInstIdFromTv,
  __setRuntimeForTests,
  __resetRuntimeForTests,
} = require(path.join(__dirname, "../src/node/crypto-scheduler.js"));

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.handlers = new Map();
    this.sent = [];
    this.pingCount = 0;
    this.terminated = false;
    FakeWebSocket.instances.push(this);
  }

  on(event, handler) {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event, payload) {
    const list = this.handlers.get(event) || [];
    for (const handler of list) handler(payload);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  send(payload) {
    this.sent.push(payload);
  }

  ping() {
    this.pingCount += 1;
  }

  terminate() {
    this.terminated = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

test.afterEach(() => {
  stop();
  __resetRuntimeForTests();
  FakeWebSocket.instances = [];
});

test("okxInstIdFromTv：支持 OKX:BTCUSDT 与 OKX:BTC-USDT", () => {
  assert.equal(okxInstIdFromTv("OKX:BTCUSDT"), "BTC-USDT");
  assert.equal(okxInstIdFromTv("OKX:BTC-USDT"), "BTC-USDT");
  assert.equal(okxInstIdFromTv("BINANCE:BTCUSDT"), null);
});

test("start：连接静默超时后主动终止并重连", async () => {
  const win = mockWin();
  __setRuntimeForTests({
    WebSocketImpl: FakeWebSocket,
    emitBarCloseImpl: async () => {},
    healthCheckMs: 5,
    stallMs: 15,
    reconnectBaseDelayMs: 10,
    reconnectMaxDelayMs: 10,
  });

  start(() => win, "OKX:ETHUSDT", "5");
  assert.equal(FakeWebSocket.instances.length, 1);
  const first = FakeWebSocket.instances[0];
  first.open();

  await wait(40);

  assert.equal(first.terminated, true);
  assert.equal(FakeWebSocket.instances.length, 2);
  const statusLines = win
    .getSent()
    .filter((x) => x.channel === "market-status")
    .map((x) => String(x.payload?.text || ""));
  assert.ok(statusLines.some((line) => line.includes("未收到消息")));
  assert.ok(statusLines.some((line) => line.includes("后重连")));
});

test("message：收到任意消息会刷新活跃时间，避免误判断流", async () => {
  const win = mockWin();
  __setRuntimeForTests({
    WebSocketImpl: FakeWebSocket,
    emitBarCloseImpl: async () => {},
    healthCheckMs: 5,
    stallMs: 30,
    reconnectBaseDelayMs: 10,
    reconnectMaxDelayMs: 10,
  });

  start(() => win, "OKX:ETHUSDT", "5");
  const first = FakeWebSocket.instances[0];
  first.open();

  await wait(15);
  first.emit("message", Buffer.from('{"event":"subscribe","arg":{"channel":"candle5m"}}'));
  await wait(15);
  assert.equal(FakeWebSocket.instances.length, 1);

  await wait(30);
  assert.equal(FakeWebSocket.instances.length, 2);
});
