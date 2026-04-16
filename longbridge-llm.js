/**
 * 长桥：仅用于美股/港股等 —— 订阅当前选中单一标的 K 线推送，isConfirmed 后组装 bar_close（含左侧截图）。
 * 开盘前/订阅后推送的「陈旧已确认 K」会跳过，不进入分析。
 * 凭证：LONGPORT_APP_KEY / LONGPORT_APP_SECRET / LONGPORT_ACCESS_TOKEN
 */
const { Config, QuoteContext, Period, TradeSessions } = require("longport");
const { emitBarClose } = require("./bar-close");

function tvIntervalToPeriod(iv) {
  const k = String(iv || "5").toUpperCase();
  const map = {
    "1": Period.Min_1,
    "3": Period.Min_3,
    "5": Period.Min_5,
    "15": Period.Min_15,
    "30": Period.Min_30,
    "60": Period.Min_60,
    "120": Period.Min_120,
    "240": Period.Min_240,
    D: Period.Day,
    "1D": Period.Day,
  };
  return map[k] ?? Period.Min_5;
}

function periodDisplayName(iv) {
  const k = String(iv || "5").toUpperCase();
  if (k === "D" || k === "1D") return "日线";
  return `${k}m`;
}

/** 分钟周期 → 毫秒（与 tvIntervalToPeriod 一致） */
function tvIntervalToMs(iv) {
  const k = String(iv || "5").toUpperCase();
  if (k === "D" || k === "1D") return 24 * 60 * 60 * 1000;
  const n = parseInt(k, 10);
  return (Number.isFinite(n) ? n : 5) * 60 * 1000;
}

/**
 * 长桥每日开盘前/订阅后常会先推一条「已确认」的历史 K（上一根或上一交易日），不应进入分析。
 * 刚收盘的 K：timestamp 距现在约为一个周期（起点）或极短（终点）；陈旧快照则远超该范围。
 */
function isStaleConfirmedSnapshot(intervalTv, tsMs, nowMs = Date.now()) {
  const iv = String(intervalTv || "5").toUpperCase();
  const age = nowMs - tsMs;
  if (!Number.isFinite(age) || age < 0) return false;
  if (iv === "D" || iv === "1D") {
    return age > 36 * 60 * 60 * 1000;
  }
  const intervalMs = tvIntervalToMs(iv);
  const slackMs = 5 * 60 * 1000;
  return age > intervalMs + slackMs;
}

function dec(x) {
  if (x == null) return null;
  return typeof x.toString === "function" ? x.toString() : String(x);
}

function serializeCandlestick(c) {
  return {
    open: dec(c.open),
    high: dec(c.high),
    low: dec(c.low),
    close: dec(c.close),
    volume: c.volume,
    turnover: dec(c.turnover),
    timestamp: c.timestamp instanceof Date ? c.timestamp.toISOString() : String(c.timestamp),
  };
}

let quoteCtx = null;
/** @type {{ symbol: string, period: number } | null} */
let activeSub = null;
/** 与当前订阅一致，供推送回调使用（避免闭包陈旧） */
let currentIntervalTv = "5";
let currentTvLabel = "";

const seenConfirmedBars = new Set();
const SEEN_CAP = 2000;

/** 与 crypto-scheduler 相同：避免连续确认 K 并发 `emitBarClose` 导致前端流式事件错乱。 */
let barCloseChain = Promise.resolve();

function enqueueBarCloseTask(fn) {
  const next = barCloseChain.then(fn);
  barCloseChain = next.catch((err) => {
    console.error("[longbridge-llm] bar-close task failed:", err);
  });
  return next;
}

/** @type {() => import("electron").BrowserWindow | null} */
let winGetter = () => null;

function send(win, channel, payload) {
  const w =
    win && !win.isDestroyed() ? win : typeof winGetter === "function" ? winGetter() : null;
  if (w && !w.isDestroyed()) {
    w.webContents.send(channel, payload);
  }
}

function setMainWindowGetter(fn) {
  winGetter = fn;
}

async function unsubscribeCurrent() {
  if (!quoteCtx || !activeSub) return;
  try {
    await quoteCtx.unsubscribeCandlesticks(activeSub.symbol, activeSub.period);
  } catch (e) {
    console.error("unsubscribeCandlesticks", e);
  }
  activeSub = null;
}

async function teardownSubscriptions() {
  await unsubscribeCurrent();
}

/**
 * @param {import("electron").BrowserWindow | null} win
 * @param {{ symbol: string, intervalTv: string, tvSymbol?: string }} opts  symbol=长桥代码
 */
async function applyForSelectedSymbol(win, opts) {
  const { symbol, intervalTv, tvSymbol } = opts;
  const periodEnum = tvIntervalToPeriod(intervalTv);

  await unsubscribeCurrent();

  if (!symbol) {
    send(win, "market-status", { text: "长桥：未选择可订阅标的" });
    return;
  }

  let envConfig;
  try {
    envConfig = Config.fromEnv();
  } catch (e) {
    send(win, "market-status", {
      text: `长桥凭证无效：${e.message || e}`,
    });
    return;
  }

  currentIntervalTv = intervalTv;
  currentTvLabel = tvSymbol || symbol;

  if (!quoteCtx) {
    quoteCtx = await QuoteContext.new(envConfig);
    quoteCtx.setOnCandlestick(async (err, event) => {
      const w = winGetter && winGetter();
      if (err) {
        send(w, "market-status", { text: `长桥推送错误：${err.message || err}` });
        return;
      }
      const data = event.data;
      if (!data || !data.isConfirmed) return;

      const sym = event.symbol;
      const candle = serializeCandlestick(data.candlestick);
      const ts = data.candlestick.timestamp;
      const tsMs = ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
      const barId = `${sym}:${tsMs}`;
      if (seenConfirmedBars.has(barId)) return;

      if (isStaleConfirmedSnapshot(currentIntervalTv, tsMs)) {
        seenConfirmedBars.add(barId);
        if (seenConfirmedBars.size > SEEN_CAP) {
          seenConfirmedBars.clear();
        }
        send(w, "market-status", {
          text: `长桥：跳过开盘前/订阅同步 K（不进入分析）${sym} · ${candle.timestamp}`,
        });
        return;
      }

      seenConfirmedBars.add(barId);
      if (seenConfirmedBars.size > SEEN_CAP) {
        seenConfirmedBars.clear();
      }

      const label = periodDisplayName(currentIntervalTv);
      send(w, "market-status", { text: `长桥 K 确认 ${sym} · ${candle.timestamp}` });

      const displaySym = currentTvLabel || sym;
      await enqueueBarCloseTask(async () => {
        try {
          await emitBarClose(winGetter, {
            source: "longbridge",
            tvSymbol: displaySym,
            interval: currentIntervalTv,
            periodLabel: label,
            candle,
            longPortSymbol: sym,
          });
        } catch (e) {
          send(w, "market-status", { text: `收盘处理失败：${e.message || e}` });
        }
      });
    });
  }

  try {
    await quoteCtx.subscribeCandlesticks(symbol, periodEnum, TradeSessions.Intraday);
    activeSub = { symbol, period: periodEnum };
    send(win, "market-status", {
      text: `长桥：已订阅 ${symbol} · ${periodDisplayName(intervalTv)}`,
    });
  } catch (e) {
    send(win, "market-status", { text: `长桥订阅失败 ${symbol}：${e.message || e}` });
  }
}

module.exports = {
  applyForSelectedSymbol,
  teardownSubscriptions,
  setMainWindowGetter,
  tvIntervalToPeriod,
};
