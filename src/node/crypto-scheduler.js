/**
 * OKX 现货 K 线 WebSocket：仅在「该根 K 已完结」时触发 bar_close（含左侧截图）。
 * OKX: data[][8] confirm === "1"
 * @see https://www.okx.com/docs-v5/en/#websocket-api-public-channel-candlesticks-channel
 */
const WebSocket = require("ws");
const { emitBarClose } = require("./bar-close");

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

function okxChannelFromInterval(intervalTv) {
  const iv = String(intervalTv || "5").toUpperCase();
  return TV_TO_OKX_CHANNEL[iv] || "candle5m";
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

function onConfirmedBar(winGetter, tvSymbol, intervalTv, candle) {
  return enqueueBarCloseTask(async () => {
    if (seenBarIds.has(candle.barKey)) return;
    seenBarIds.add(candle.barKey);
    if (seenBarIds.size > SEEN_CAP) seenBarIds.clear();

    const periodLabel = `tv:${intervalTv}（${periodDisplayForTv(intervalTv)}）`;
    send(winGetter, "market-status", {
      text: `OKX WS · K 收盘 ${tvSymbol} · ${candle.timestamp}`,
    });

    try {
      await emitBarClose(winGetter, {
        source: "okx_ws",
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
    text: `OKX WS 断开，${sec}s 后重连…`,
  });
  reconnectTimer = setTimeout(() => {
    connect();
  }, delay);
}

function connectOkx() {
  if (!session) return;
  const { winGetter, tvSymbol, intervalTv } = session;
  const instId = okxInstIdFromTv(tvSymbol);
  if (!instId) {
    send(winGetter, "market-status", { text: "无效 OKX 代码（示例 OKX:BTCUSDT）" });
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
      text: `OKX WS 已连接 · ${ivLabel} · ${tvSymbol}`,
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
      onConfirmedBar(winGetter, tvSymbol, intervalTv, candle).catch((e) => {
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
  if (!okxInstIdFromTv(tvSymbol)) {
    send(session.winGetter, "market-status", {
      text: "请使用 OKX: 前缀（如 OKX:BTCUSDT）",
    });
    return;
  }
  connectOkx();
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

module.exports = { start, stop, okxInstIdFromTv };
