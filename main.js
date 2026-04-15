const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const longbridge = require("./longbridge-llm");
const cryptoSched = require("./crypto-scheduler");
const { inferFeed, resolveLongPortSymbol } = require("./market");

const BUNDLED_CONFIG = path.join(__dirname, "config.json");

const ALLOWED_INTERVAL = new Set(["1", "3", "5", "15", "30", "60", "120", "240", "D", "1D"]);

function defaultConfigFallback() {
  return {
    symbols: [
      { label: "BTC/USDT", value: "BINANCE:BTCUSDT" },
      { label: "ETH/USDT", value: "BINANCE:ETHUSDT" },
      { label: "SPY", value: "AMEX:SPY" },
      { label: "QQQ", value: "NASDAQ:QQQ" },
    ],
    defaultSymbol: "BINANCE:BTCUSDT",
    interval: "5",
  };
}

function userConfigPath() {
  return path.join(app.getPath("userData"), "argus-config.json");
}

function readBundledConfig() {
  try {
    const raw = fs.readFileSync(BUNDLED_CONFIG, "utf8");
    return JSON.parse(raw);
  } catch {
    return defaultConfigFallback();
  }
}

function normalizeConfig(raw) {
  const base = defaultConfigFallback();
  if (!raw || typeof raw !== "object") return base;
  let symbols = Array.isArray(raw.symbols) ? raw.symbols : base.symbols;
  symbols = symbols
    .filter((s) => s && typeof s.label === "string" && typeof s.value === "string")
    .map((s) => {
      const row = {
        label: s.label.trim(),
        value: s.value.trim(),
      };
      if (s.feed === "crypto" || s.feed === "longbridge") row.feed = s.feed;
      if (typeof s.longPortSymbol === "string" && s.longPortSymbol.trim()) {
        row.longPortSymbol = s.longPortSymbol.trim();
      }
      return row;
    })
    .filter((s) => s.label && s.value);
  const seen = new Set();
  symbols = symbols.filter((s) => {
    if (seen.has(s.value)) return false;
    seen.add(s.value);
    return true;
  });
  if (symbols.length === 0) symbols = base.symbols;

  let defaultSymbol =
    typeof raw.defaultSymbol === "string" ? raw.defaultSymbol.trim() : "";
  if (!symbols.some((s) => s.value === defaultSymbol)) {
    defaultSymbol = symbols[0].value;
  }

  let interval = typeof raw.interval === "string" ? raw.interval.trim() : base.interval;
  if (!ALLOWED_INTERVAL.has(interval)) interval = base.interval;

  return { symbols, defaultSymbol, interval };
}

function loadAppConfig() {
  const userPath = userConfigPath();
  if (fs.existsSync(userPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(userPath, "utf8"));
      return normalizeConfig(raw);
    } catch {
      /* fall through */
    }
  }
  return normalizeConfig(readBundledConfig());
}

/**
 * 左侧当前品种：加密走定时拉 Binance；美股/港股走长桥订阅（切换时先停另一侧）。
 */
async function routeMarket(cfg, tvSymbol) {
  const interval = cfg.interval || "5";
  const sym = tvSymbol || cfg.defaultSymbol;
  const entry = cfg.symbols.find((s) => s.value === sym);
  const feed = inferFeed(sym, entry?.feed);

  if (feed === "crypto") {
    await longbridge.teardownSubscriptions();
    cryptoSched.start(() => mainWindow, sym, interval);
    return;
  }

  cryptoSched.stop();
  const lp = resolveLongPortSymbol(entry, sym);
  if (!lp) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("market-status", {
        text: `长桥：无法映射 ${sym}，请在配置中为该品种填写 longPortSymbol`,
      });
    }
    await longbridge.teardownSubscriptions();
    return;
  }
  await longbridge.applyForSelectedSymbol(mainWindow, {
    symbol: lp,
    intervalTv: interval,
    tvSymbol: sym,
  });
}

ipcMain.handle("config:get", () => loadAppConfig());

ipcMain.handle("config:path", () => userConfigPath());

ipcMain.handle("config:save", async (_event, payload) => {
  const current = loadAppConfig();
  const merged = { ...current, ...payload };
  const next = normalizeConfig(merged);
  fs.mkdirSync(path.dirname(userConfigPath()), { recursive: true });
  fs.writeFileSync(userConfigPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await routeMarket(next, next.defaultSymbol);
  return next;
});

ipcMain.handle("market:set-context", async (_event, tvSymbol) => {
  await routeMarket(loadAppConfig(), tvSymbol);
});

ipcMain.handle("llm-request-analysis", async (_event, payload) => {
  return {
    ok: true,
    message: "分析由行情侧自动触发（长桥推送或加密定时）。",
    received: payload ?? null,
  };
});

/** @type {import("electron").BrowserWindow | null} */
let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#0d1117",
  });

  win.loadFile(path.join(__dirname, "index.html"));
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
}

app.whenReady().then(() => {
  longbridge.setMainWindowGetter(() => mainWindow);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
