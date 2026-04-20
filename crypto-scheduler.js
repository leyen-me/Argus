/**
 * 加密（BINANCE:* / OKX:*）：现货 K 线 WebSocket，仅在「该根 K 已完结」时触发 bar_close（含左侧截图）。
 * Binance: k.x === true
 * OKX: data[][8] confirm === "1"
 * @see https://binance-docs.github.io/apidocs/spot/en/#kline-candlestick-streams
 * @see https://www.okx.com/docs-v5/en/#websocket-api-public-channel-candlesticks-channel
 */
const WebSocket = require("ws");
const { emitBarClose } = require("./bar-close");

const TV_TO_BINANCE_INTERVAL = {
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

const BINANCE_WS_BASE = "wss://stream.binance.com:9443/ws";
/** OKX K 线（candle*）须走 business，/public 不再提供该频道，否则会报 60018 */
const OKX_WS_BUSINESS = "wss://ws.okx.com:8443/ws/v5/business";

let ws = null;
let reconnectTimer = null;
let intentionalClose = false;
/** @type {{ winGetter: () => import("electron").BrowserWindow | null, tvSymbol: string, intervalTv: string } | null} */
let session = null;
let reconnectAttempt = 0;

const seenBarIds = new Set();
const SEEN_CAP = 2000;

/**
 * 串行化「收盘 → 截图 → LLM」：WS 可能连续投递多条已确认 K（OKX 同一包内多行、或上一条尚未跑完又推下一条），
 * 若并发 `emitBarClose`，渲染进程里 `latestBarCloseId` 会被覆盖，导致大量流式 delta/end 被丢弃（表现为「多半收不到输出」）。
 */
let barCloseChain = Promise.resolve();

function enqueueBarCloseTask(fn) {
  const next = barCloseChain.then(fn);
  barCloseChain = next.catch((err) => {
    console.error("[crypto-scheduler] bar-close task failed:", err);
  });
  return next;
}

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

/**
 * TradingView 写法为 OKX:BTCUSDT（无连字符）；订阅 OKX WS 时需 instId「BASE-QUOTE」，此处转为 BTC-USDT。
 * 仍接受 OKX:BTC-USDT，与官方 instId 一致时直接使用。
 * @param {string} tv
 * @returns {string | null}
 */
function okxInstIdFromTv(tv) {
  const v = String(tv || "").trim();
  if (!v.startsWith("OKX:")) return null;
  const rest = v.slice("OKX:".length).trim().toUpperCase();
  if (!rest) return null;
  if (rest.includes("-")) return rest;
  const m = /^(.+)(USDT|USDC|DAI|BUSD|EUR|USD|BTC|ETH)$/.exec(rest);
  if (m) return `${m[1]}-${m[2]}`;
  return null;
}

/**
 * @param {string} tvSymbol
 * @returns {{ kind: "binance", pair: string } | { kind: "okx", instId: string } | null}
 */
function parseCryptoRoute(tvSymbol) {
  const pair = binancePairFromTv(tvSymbol);
  if (pair) return { kind: "binance", pair };
  const instId = okxInstIdFromTv(tvSymbol);
  if (instId) return { kind: "okx", instId };
  return null;
}

function binanceStreamPath(pair, intervalTv) {
  const iv = String(intervalTv || "5").toUpperCase();
  const bi = TV_TO_BINANCE_INTERVAL[iv] || "5m";
  return `${pair.toLowerCase()}@kline_${bi}`;
}

function okxChannelFromInterval(intervalTv) {
  const iv = String(intervalTv || "5").toUpperCase();
  return TV_TO_OKX_CHANNEL[iv] || "candle5m";
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

function onConfirmedBar(winGetter, tvSymbol, intervalTv, candle, source) {
  return enqueueBarCloseTask(async () => {
    if (seenBarIds.has(candle.barKey)) return;
    seenBarIds.add(candle.barKey);
    if (seenBarIds.size > SEEN_CAP) seenBarIds.clear();

    const periodLabel = `tv:${intervalTv}（${periodDisplayForTv(intervalTv)}）`;
    const label = source === "okx_ws" ? "OKX" : "Binance";
    send(winGetter, "market-status", {
      text: `加密 WS（${label}）· K 收盘 ${tvSymbol} · ${candle.timestamp}`,
    });

    try {
      await emitBarClose(winGetter, {
        source,
        tvSymbol,
        interval: intervalTv,
        periodLabel,
        candle,
      });
    } catch (e) {
      send(winGetter, "market-status", { text: `收盘处理失败：${e.message || e}` });
    }
  });
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

function connectBinance() {
  if (!session) return;
  const { winGetter, tvSymbol, intervalTv } = session;
  const pair = binancePairFromTv(tvSymbol);
  if (!pair) {
    send(winGetter, "market-status", { text: "加密：无效 BINANCE 代码" });
    return;
  }

  const path = binanceStreamPath(pair, intervalTv);
  const url = `${BINANCE_WS_BASE}/${path}`;
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
      text: `加密 WS（Binance）已连接 · ${ivLabel} · ${tvSymbol}`,
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
    onConfirmedBar(winGetter, tvSymbol, intervalTv, candle, "binance_ws").catch((e) => {
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

function connectOkx() {
  if (!session) return;
  const { winGetter, tvSymbol, intervalTv } = session;
  const instId = okxInstIdFromTv(tvSymbol);
  if (!instId) {
    send(winGetter, "market-status", { text: "加密：无效 OKX 代码（示例 OKX:BTCUSDT）" });
    return;
  }

  const channel = okxChannelFromInterval(intervalTv);
  clearReconnectTimer();

  try {
    ws = new WebSocket(OKX_WS_BUSINESS);
  } catch (e) {
    console.error("OKX WS create", e);
    scheduleReconnect();
    return;
  }

  // 必须用创建时的实例判断：模块级 `ws` 可能被重连/stop 换掉，旧连接的 `open` 晚到时会误对 null 或新套接字 send
  const okxSocket = ws;
  ws.on("open", () => {
    if (ws !== okxSocket || okxSocket.readyState !== WebSocket.OPEN) return;
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
    send(winGetter, "market-status", {
      text: `加密 WS（OKX）已连接 · ${ivLabel} · ${tvSymbol}`,
    });
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.event === "error" && msg.msg) {
      console.error("OKX WS error event", msg);
      send(winGetter, "market-status", { text: `OKX：${msg.msg || msg.code || "error"}` });
      return;
    }
    if (!msg.arg || typeof msg.arg.channel !== "string" || !msg.arg.channel.startsWith("candle")) {
      return;
    }
    if (!Array.isArray(msg.data)) return;
    for (const row of msg.data) {
      const candle = candleFromOkxRow(row, instId);
      if (!candle) continue;
      onConfirmedBar(winGetter, tvSymbol, intervalTv, candle, "okx_ws").catch((e) => {
        console.error("onConfirmedBar okx", e);
      });
    }
  });

  ws.on("error", (err) => {
    console.error("OKX WS error", err);
  });

  ws.on("close", () => {
    ws = null;
    if (intentionalClose || !session) return;
    scheduleReconnect();
  });
}

function connect() {
  if (!session) return;
  const { tvSymbol } = session;
  const route = parseCryptoRoute(tvSymbol);
  if (!route) {
    send(session.winGetter, "market-status", {
      text: "加密：请使用 BINANCE: 或 OKX: 前缀（如 BINANCE:BTCUSDT、OKX:BTCUSDT）",
    });
    return;
  }
  if (route.kind === "binance") {
    connectBinance();
  } else {
    connectOkx();
  }
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

module.exports = { start, stop, binancePairFromTv, okxInstIdFromTv };
