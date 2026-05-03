/**
 * OKX 现货 K 线 WebSocket：仅在「该根 K 已完结」时触发 bar_close（含左侧截图）。
 * OKX: data[][8] confirm === "1"
 * @see https://www.okx.com/docs-v5/en/#websocket-api-public-channel-candlesticks-channel
 */
const WebSocket = require("ws");
const { emitBarClose } = require("./bar-close");
const { publish } = require("./runtime-bus");

const DEFAULT_RUNTIME = Object.freeze({
  WebSocketImpl: WebSocket,
  emitBarCloseImpl: emitBarClose,
  now: () => Date.now(),
  setTimeoutFn: setTimeout,
  clearTimeoutFn: clearTimeout,
  setIntervalFn: setInterval,
  clearIntervalFn: clearInterval,
  reconnectBaseDelayMs: 1000,
  reconnectMaxDelayMs: 30_000,
  healthCheckMs: 20_000,
  stallMs: 90_000,
});

let runtime = { ...DEFAULT_RUNTIME };

/** OKX channel 名，如 candle5m、candle1H */
const TV_TO_OKX_CHANNEL = {
  "1": "candle1m",
  "3": "candle3m",
  "5": "candle5m",
  "15": "candle15m",
  "30": "candle30m",
  "60": "candle1H",
  "120": "candle2H",
  "240": "candle4H",
  D: "candle1D",
  "1D": "candle1D",
};

/** OKX K 线（candle*）须走 business，/public 不再提供该频道，否则会报 60018 */
const OKX_WS_BUSINESS = "wss://ws.okx.com:8443/ws/v5/business";

let ws: import("ws").WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let intentionalClose = false;
let session: { tvSymbol: string; intervalTv: string } | null = null;
let reconnectAttempt = 0;
let lastSocketActivityAt = 0;

const seenBarIds = new Set();
const SEEN_CAP = 2000;

/**
 * 串行化「收盘 → 截图 → LLM」：WS 可能连续投递多条已确认 K（OKX 同一包内多行、或上一条尚未跑完又推下一条），
 * 若并发 `emitBarClose`，前端侧 `latestBarCloseId` 会被覆盖，导致大量流式 delta/end 被丢弃（表现为「多半收不到输出」）。
 */
let barCloseChain = Promise.resolve();
let latestQueuedBarTs = 0;

function enqueueBarCloseTask(fn) {
  const next = barCloseChain.then(fn);
  barCloseChain = next.catch((err) => {
    console.error("[crypto-scheduler] bar-close task failed:", err);
  });
  return next;
}

function send(channel, payload) {
  publish(channel, payload);
}

function markSocketActivity() {
  lastSocketActivityAt = runtime.now();
}

/**
 * TradingView 写法为 OKX:BTCUSDT（无连字符）；订阅 OKX 永续 WS 时需 instId「BASE-QUOTE-SWAP」。
 * 仍接受 OKX:BTC-USDT，与官方 instId 一致时直接使用并补齐 `-SWAP`。
 * @param {string} tv
 * @returns {string | null}
 */
function okxSwapInstIdFromTv(tv) {
  const v = String(tv || "").trim();
  if (!v.startsWith("OKX:")) return null;
  let rest = v.slice("OKX:".length).trim().toUpperCase();
  if (rest.endsWith(".P")) rest = rest.slice(0, -2);
  if (!rest) return null;
  if (rest.endsWith("-SWAP")) return rest;
  if (rest.includes("-")) return `${rest}-SWAP`;
  const m = /^(.+)(USDT|USDC|DAI|BUSD|EUR|USD|BTC|ETH)$/.exec(rest);
  if (m) return `${m[1]}-${m[2]}-SWAP`;
  return null;
}

function okxChannelFromInterval(intervalTv) {
  const iv = String(intervalTv || "5").toUpperCase();
  return TV_TO_OKX_CHANNEL[iv as keyof typeof TV_TO_OKX_CHANNEL] || "candle5m";
}

/** OKX push: data 为 [ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm][] */
function candleFromOkxRow(row, instId) {
  if (!Array.isArray(row) || row.length < 9) return null;
  const ts = row[0];
  const confirm = row[8];
  if (confirm !== "1") return null;
  const openTime = Number(ts);
  return {
    open: String(row[1]),
    high: String(row[2]),
    low: String(row[3]),
    close: String(row[4]),
    volume: Number(row[5]),
    turnover: row[7] != null ? String(row[7]) : null,
    timestamp: new Date(openTime).toISOString(),
    barKey: `${instId}:${ts}`,
  };
}

function periodDisplayForTv(intervalTv) {
  const iv = String(intervalTv || "5").toUpperCase();
  if (iv === "D" || iv === "1D") return "日线";
  return `${iv}m`;
}

function onConfirmedBar(tvSymbol, intervalTv, candle) {
  const candleTs = Date.parse(candle.timestamp);
  if (Number.isFinite(candleTs) && candleTs > latestQueuedBarTs) {
    latestQueuedBarTs = candleTs;
  }
  return enqueueBarCloseTask(async () => {
    if (seenBarIds.has(candle.barKey)) return;
    if (Number.isFinite(candleTs) && candleTs < latestQueuedBarTs) {
      send("market-status", {
        text: `跳过过期 K 收盘：${tvSymbol} · ${candle.timestamp}（队列里已有更新收盘）`,
      });
      return;
    }
    seenBarIds.add(candle.barKey);
    if (seenBarIds.size > SEEN_CAP) seenBarIds.clear();

    const periodLabel = `tv:${intervalTv}（${periodDisplayForTv(intervalTv)}）`;
    send("market-status", {
      text: `OKX WS · K 收盘 ${tvSymbol} · ${candle.timestamp}`,
    });

    try {
      await runtime.emitBarCloseImpl({
        source: "okx_ws",
        tvSymbol,
        interval: intervalTv,
        periodLabel,
        candle,
      });
    } catch (e) {
      send("market-status", {
        text: `收盘处理失败：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    runtime.clearTimeoutFn(reconnectTimer);
    reconnectTimer = null;
  }
}

function clearHealthCheckTimer() {
  if (healthCheckTimer) {
    runtime.clearIntervalFn(healthCheckTimer);
    healthCheckTimer = null;
  }
}

function scheduleReconnect() {
  if (intentionalClose || !session) return;
  clearReconnectTimer();
  const delay = Math.min(runtime.reconnectMaxDelayMs, runtime.reconnectBaseDelayMs * 2 ** reconnectAttempt);
  const sec = Math.max(1, Math.round(delay / 1000));
  reconnectAttempt += 1;
  send("market-status", {
    text: `OKX WS 断开，${sec}s 后重连…`,
  });
  reconnectTimer = runtime.setTimeoutFn(() => {
    connect();
  }, delay);
}

function forceReconnect(okxSocket, reasonText) {
  if (intentionalClose || !session || ws !== okxSocket) return;
  clearHealthCheckTimer();
  ws = null;
  if (reasonText) {
    send("market-status", { text: reasonText });
  }
  try {
    if (typeof okxSocket.terminate === "function") okxSocket.terminate();
    else okxSocket.close();
  } catch {
    /* ignore */
  }
  scheduleReconnect();
}

function startHealthCheck(okxSocket, tvSymbol) {
  clearHealthCheckTimer();
  markSocketActivity();
  const openState = Number(runtime.WebSocketImpl?.OPEN ?? WebSocket.OPEN ?? 1);
  healthCheckTimer = runtime.setIntervalFn(() => {
    if (intentionalClose || !session || ws !== okxSocket) return;
    const idleMs = runtime.now() - lastSocketActivityAt;
    if (idleMs >= runtime.stallMs) {
      const idleSec = Math.max(1, Math.round(idleMs / 1000));
      forceReconnect(okxSocket, `OKX WS 超过 ${idleSec}s 未收到消息，正在重连…`);
      return;
    }
    if (okxSocket.readyState === openState && typeof okxSocket.ping === "function") {
      try {
        okxSocket.ping();
      } catch (e) {
        console.error("OKX WS ping", e);
        forceReconnect(okxSocket, `OKX WS 心跳失败：${tvSymbol}，正在重连…`);
      }
    }
  }, runtime.healthCheckMs);
}

function connectOkx() {
  if (!session) return;
  const { tvSymbol, intervalTv } = session;
  const instId = okxSwapInstIdFromTv(tvSymbol);
  if (!instId) {
    send("market-status", { text: "无效 OKX 代码（示例 OKX:BTCUSDT）" });
    return;
  }

  const channel = okxChannelFromInterval(intervalTv);
  clearReconnectTimer();
  clearHealthCheckTimer();

  try {
    ws = new runtime.WebSocketImpl(OKX_WS_BUSINESS);
  } catch (e) {
    console.error("OKX WS create", e);
    scheduleReconnect();
    return;
  }

  if (!ws) return;
  const okxSocket = ws;
  startHealthCheck(okxSocket, tvSymbol);
  ws.on("open", () => {
    const openState = Number(runtime.WebSocketImpl?.OPEN ?? WebSocket.OPEN ?? 1);
    if (ws !== okxSocket || okxSocket.readyState !== openState) return;
    markSocketActivity();
    reconnectAttempt = 0;
    const sub = {
      op: "subscribe",
      args: [{ channel, instId }],
    };
    try {
      okxSocket.send(JSON.stringify(sub));
    } catch (e) {
      console.error("OKX subscribe send", e);
    }
    const iv = String(intervalTv || "5").toUpperCase();
    const ivLabel = iv === "D" || iv === "1D" ? "日线" : `${iv}m`;
    send("market-status", {
      text: `OKX WS 已连接 · ${ivLabel} · ${tvSymbol}`,
    });
  });

  ws.on("pong", () => {
    if (ws !== okxSocket) return;
    markSocketActivity();
  });

  ws.on("message", (raw) => {
    if (ws !== okxSocket) return;
    markSocketActivity();
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.event === "error" && msg.msg) {
      console.error("OKX WS error event", msg);
      send("market-status", { text: `OKX：${msg.msg || msg.code || "error"}` });
      return;
    }
    if (!msg.arg || typeof msg.arg.channel !== "string" || !msg.arg.channel.startsWith("candle")) {
      return;
    }
    if (!Array.isArray(msg.data)) return;
    for (const row of msg.data) {
      const candle = candleFromOkxRow(row, instId);
      if (!candle) continue;
      onConfirmedBar(tvSymbol, intervalTv, candle).catch((e) => {
        console.error("onConfirmedBar okx", e);
      });
    }
  });

  ws.on("error", (err) => {
    if (ws !== okxSocket) return;
    console.error("OKX WS error", err);
  });

  ws.on("close", () => {
    const isCurrent = ws === okxSocket;
    if (isCurrent) {
      ws = null;
      clearHealthCheckTimer();
    }
    if (intentionalClose || !session) return;
    if (!isCurrent) return;
    scheduleReconnect();
  });
}

function connect() {
  if (!session) return;
  const { tvSymbol } = session;
  if (!okxSwapInstIdFromTv(tvSymbol)) {
    send("market-status", {
      text: "请使用 OKX: 前缀（如 OKX:BTCUSDT）",
    });
    return;
  }
  connectOkx();
}

/**
 * @param {string} tvSymbol
 * @param {string} intervalTv TradingView 周期写法（如 5、60、1D）
 */
function start(tvSymbol, intervalTv) {
  stop();
  intentionalClose = false;
  latestQueuedBarTs = 0;
  session = { tvSymbol, intervalTv };
  connect();
}

function stop() {
  intentionalClose = true;
  clearReconnectTimer();
  clearHealthCheckTimer();
  session = null;
  reconnectAttempt = 0;
  lastSocketActivityAt = 0;
  latestQueuedBarTs = 0;
  if (ws) {
    try {
      if (typeof ws.terminate === "function") ws.terminate();
      else ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
}

function __setRuntimeForTests(overrides = {}) {
  stop();
  runtime = { ...DEFAULT_RUNTIME, ...overrides };
  seenBarIds.clear();
  barCloseChain = Promise.resolve();
  latestQueuedBarTs = 0;
  intentionalClose = false;
}

function __resetRuntimeForTests() {
  stop();
  runtime = { ...DEFAULT_RUNTIME };
  seenBarIds.clear();
  barCloseChain = Promise.resolve();
  latestQueuedBarTs = 0;
  intentionalClose = false;
}

module.exports = {
  start,
  stop,
  okxInstIdFromTv: okxSwapInstIdFromTv,
  __setRuntimeForTests,
  __resetRuntimeForTests,
};
