/**
 * 加密（BINANCE:*）：Binance Spot WebSocket K 线流，k.x === true 时视为该根 K 线收盘，再组装 bar_close（含左侧截图）。
 * @see https://binance-docs.github.io/apidocs/spot/en/#kline-candlestick-streams
 */
const WebSocket = require("ws");
const { emitBarClose } = require("./bar-close");

const BINANCE_INTERVAL = {
  "1": "1m",
  "3": "3m",
  "5": "5m",
  "15": "15m",
  "30": "30m",
  "60": "1h",
  "120": "2h",
  "240": "4h",
  D: "1d",
  "1D": "1d",
};

const WS_BASE = "wss://stream.binance.com:9443/ws";

let ws = null;
let reconnectTimer = null;
let intentionalClose = false;
/** @type {{ winGetter: () => import("electron").BrowserWindow | null, tvSymbol: string, intervalTv: string } | null} */
let session = null;
let reconnectAttempt = 0;

const seenBarIds = new Set();
const SEEN_CAP = 2000;

function send(winGetter, channel, payload) {
  const w = typeof winGetter === "function" ? winGetter() : null;
  if (w && !w.isDestroyed()) {
    w.webContents.send(channel, payload);
  }
}

/** BINANCE:BTCUSDT → BTCUSDT */
function binancePairFromTv(tv) {
  const v = String(tv || "").trim();
  if (!v.startsWith("BINANCE:")) return null;
  return v.slice("BINANCE:".length).toUpperCase();
}

function streamName(pair, intervalTv) {
  const iv = String(intervalTv || "5").toUpperCase();
  const bi = BINANCE_INTERVAL[iv] || "5m";
  return `${pair.toLowerCase()}@kline_${bi}`;
}

function candleFromK(k, pair) {
  const openTime = k.t;
  return {
    open: String(k.o),
    high: String(k.h),
    low: String(k.l),
    close: String(k.c),
    volume: Number(k.v),
    turnover: k.q != null ? String(k.q) : null,
    timestamp: new Date(Number(openTime)).toISOString(),
    barKey: `${pair}:${openTime}`,
  };
}

function periodDisplayForTv(intervalTv) {
  const iv = String(intervalTv || "5").toUpperCase();
  if (iv === "D" || iv === "1D") return "日线";
  return `${iv}m`;
}

async function onConfirmedBar(winGetter, tvSymbol, intervalTv, candle) {
  if (seenBarIds.has(candle.barKey)) return;
  seenBarIds.add(candle.barKey);
  if (seenBarIds.size > SEEN_CAP) seenBarIds.clear();

  const periodLabel = `tv:${intervalTv}（${periodDisplayForTv(intervalTv)}）`;
  send(winGetter, "market-status", {
    text: `加密 WS · K 收盘 ${tvSymbol} · ${candle.timestamp}`,
  });

  try {
    await emitBarClose(winGetter, {
      source: "binance_ws",
      tvSymbol,
      interval: intervalTv,
      periodLabel,
      candle,
      longPortSymbol: null,
    });
  } catch (e) {
    send(winGetter, "market-status", { text: `收盘处理失败：${e.message || e}` });
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (intentionalClose || !session) return;
  clearReconnectTimer();
  const delay = Math.min(30_000, 1000 * 2 ** reconnectAttempt);
  const sec = Math.max(1, Math.round(delay / 1000));
  reconnectAttempt += 1;
  send(session.winGetter, "market-status", {
    text: `加密 WS 断开，${sec}s 后重连…`,
  });
  reconnectTimer = setTimeout(() => {
    connect();
  }, delay);
}

function connect() {
  if (!session) return;
  const { winGetter, tvSymbol, intervalTv } = session;
  const pair = binancePairFromTv(tvSymbol);
  if (!pair) {
    send(winGetter, "market-status", { text: "加密：无效 BINANCE 代码" });
    return;
  }

  const path = streamName(pair, intervalTv);
  const url = `${WS_BASE}/${path}`;
  clearReconnectTimer();

  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error("Binance WS create", e);
    scheduleReconnect();
    return;
  }

  ws.on("open", () => {
    reconnectAttempt = 0;
    const iv = String(intervalTv || "5").toUpperCase();
    const ivLabel = iv === "D" || iv === "1D" ? "日线" : `${iv}m`;
    send(winGetter, "market-status", {
      text: `加密 WS 已连接 · ${ivLabel} · ${tvSymbol}`,
    });
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.e !== "kline" || !msg.k) return;
    const k = msg.k;
    if (!k.x) return;

    const candle = candleFromK(k, pair);
    onConfirmedBar(winGetter, tvSymbol, intervalTv, candle).catch((e) => {
      console.error("onConfirmedBar", e);
    });
  });

  ws.on("error", (err) => {
    console.error("Binance WS error", err);
  });

  ws.on("close", () => {
    ws = null;
    if (intentionalClose || !session) return;
    scheduleReconnect();
  });
}

/**
 * @param {() => import("electron").BrowserWindow | null} winGetter
 */
function start(winGetter, tvSymbol, intervalTv) {
  stop();
  intentionalClose = false;
  session = { winGetter, tvSymbol, intervalTv };
  connect();
}

function stop() {
  intentionalClose = true;
  clearReconnectTimer();
  session = null;
  reconnectAttempt = 0;
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
}

module.exports = { start, stop, binancePairFromTv };
