/**
 * 加密（如 BINANCE:*）：按全局 interval 定时拉取 Binance 公共 K 线，取最近一根已收盘 K 线后调用 LLM。
 */
const { callOpenAIChat, buildUserPrompt } = require("./llm");

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

let timerId = null;
let timeoutId = null;

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

function intervalMs(intervalTv) {
  const k = String(intervalTv || "5").toUpperCase();
  const table = {
    "1": 60e3,
    "3": 180e3,
    "5": 300e3,
    "15": 900e3,
    "30": 1800e3,
    "60": 3600e3,
    "120": 7200e3,
    "240": 14400e3,
    D: 86400e3,
    "1D": 86400e3,
  };
  return table[k] ?? 300e3;
}

/** 对齐到 UTC 周期边界，略延后避免交易所尚未收盘 */
function msUntilNextBoundary(intervalTv) {
  const ms = intervalMs(intervalTv);
  const now = Date.now();
  const next = Math.ceil(now / ms) * ms;
  return Math.max(2000, next - now + 2000);
}

async function fetchLastClosedKline(tvSymbol, intervalTv) {
  const pair = binancePairFromTv(tvSymbol);
  const bi = BINANCE_INTERVAL[String(intervalTv).toUpperCase()] || "5m";
  if (!pair) {
    throw new Error("非 BINANCE: 代码，无法使用 Binance 公共行情");
  }
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(pair)}&interval=${bi}&limit=3`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Binance HTTP ${res.status}`);
  }
  /** @type {any[][]} */
  const klines = await res.json();
  if (!Array.isArray(klines) || klines.length < 2) {
    throw new Error("K 线数据不足");
  }
  const closed = klines[klines.length - 2];
  const open = closed[1];
  const high = closed[2];
  const low = closed[3];
  const close = closed[4];
  const volume = closed[5];
  const openTime = closed[0];
  const ts = new Date(Number(openTime)).toISOString();
  return {
    open,
    high,
    low,
    close,
    volume: Number(volume),
    turnover: null,
    timestamp: ts,
    barKey: `${pair}:${openTime}`,
  };
}

async function runAnalysis(winGetter, tvSymbol, intervalTv) {
  let candle;
  try {
    candle = await fetchLastClosedKline(tvSymbol, intervalTv);
  } catch (e) {
    send(winGetter, "llm-analysis-update", {
      kind: "error",
      symbol: tvSymbol,
      message: e.message || String(e),
    });
    return;
  }

  if (seenBarIds.has(candle.barKey)) return;
  seenBarIds.add(candle.barKey);
  if (seenBarIds.size > SEEN_CAP) seenBarIds.clear();

  const periodLabel = `tv:${intervalTv}`;
  send(winGetter, "market-status", {
    text: `加密定时 · ${tvSymbol} · ${candle.timestamp}`,
  });

  const prompt = buildUserPrompt(tvSymbol, periodLabel, candle);
  try {
    const r = await callOpenAIChat(prompt);
    if (!r.ok) {
      send(winGetter, "llm-analysis-update", {
        kind: "error",
        symbol: tvSymbol,
        candle,
        message: r.text,
      });
      return;
    }
    send(winGetter, "llm-analysis-update", {
      kind: "analysis",
      symbol: tvSymbol,
      period: periodLabel,
      candle,
      text: r.text,
      at: new Date().toISOString(),
    });
  } catch (e) {
    send(winGetter, "llm-analysis-update", {
      kind: "error",
      symbol: tvSymbol,
      message: e.message || String(e),
    });
  }
}

function scheduleLoop(winGetter, tvSymbol, intervalTv) {
  clearTimers();
  const tick = async () => {
    await runAnalysis(winGetter, tvSymbol, intervalTv);
    timeoutId = setTimeout(tick, msUntilNextBoundary(intervalTv));
  };
  timeoutId = setTimeout(tick, msUntilNextBoundary(intervalTv));
}

function clearTimers() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}

/**
 * @param {() => import("electron").BrowserWindow | null} winGetter
 */
function start(winGetter, tvSymbol, intervalTv) {
  stop();
  const iv = String(intervalTv || "5").toUpperCase();
  const ivLabel = iv === "D" || iv === "1D" ? "日线" : `${iv}m`;
  send(winGetter, "market-status", {
    text: `加密：定时 ${ivLabel} · ${tvSymbol}`,
  });
  scheduleLoop(winGetter, tvSymbol, intervalTv);
}

function stop() {
  clearTimers();
}

module.exports = { start, stop, binancePairFromTv };
