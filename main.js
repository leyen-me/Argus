const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const longbridge = require("./longbridge-llm");
const cryptoSched = require("./crypto-scheduler");
const { inferFeed, resolveLongPortSymbol } = require("./market");
const {
  loadAppConfig,
  normalizeConfig,
  configPath,
  stripSystemPromptsForPersistence,
  resetAppConfig,
} = require("./app-config");
const { wipeConversationStore } = require("./llm-context");
const { wipeTradingStateStore } = require("./trading-state");

/**
 * 左侧当前品种：加密走 Binance / OKX WS K 线；美股/港股走长桥订阅（切换时先停另一侧）。
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

ipcMain.handle("config:path", () => configPath());

ipcMain.handle("devtools:open", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.openDevTools();
  }
});

ipcMain.handle("config:save", async (_event, payload) => {
  const current = loadAppConfig();
  const merged = { ...current, ...payload };
  const next = normalizeConfig(merged);
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(
    configPath(),
    `${JSON.stringify(stripSystemPromptsForPersistence(next), null, 2)}\n`,
    "utf8",
  );
  await routeMarket(next, next.defaultSymbol);
  return next;
});

ipcMain.handle("config:reset", async () => {
  const next = resetAppConfig();
  await routeMarket(next, next.defaultSymbol);
  return next;
});

ipcMain.handle("market:set-context", async (_event, tvSymbol) => {
  await routeMarket(loadAppConfig(), tvSymbol);
});

ipcMain.handle("llm-request-analysis", async (_event, payload) => {
  return {
    ok: true,
    message: "K 线收盘后会推送 market-bar-close（含 textForLlm 与截图）；填写 API Key 后即可调用 LLM。",
    received: payload ?? null,
  };
});

/** @type {import("electron").BrowserWindow | null} */
let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
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

  win.once("ready-to-show", () => {
    win.center();
    win.show();
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
  app.quit();
});

app.on("before-quit", () => {
  wipeConversationStore();
  wipeTradingStateStore();
});
