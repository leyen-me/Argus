const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const cryptoSched = require("./crypto-scheduler");
const { inferFeed } = require("./market");
const {
  loadAppConfig,
  normalizeConfig,
  configPath,
  stripSystemPromptsForPersistence,
  resetAppConfig,
} = require("./app-config");
const { wipeConversationStore } = require("./llm-context");
const { wipeTradingStateStore } = require("./trading-state");
const { getOkxSwapPositionSnapshot } = require("./okx-perp");

/**
 * 左侧当前品种：仅加密（Binance / OKX WS K 线）。
 */
async function routeMarket(cfg, tvSymbol) {
  const interval = cfg.interval || "5";
  const sym = tvSymbol || cfg.defaultSymbol;
  const entry = cfg.symbols.find((s) => s.value === sym);
  const feed = inferFeed(sym, entry?.feed);

  if (feed === "crypto") {
    cryptoSched.start(() => mainWindow, sym, interval);
    return;
  }

  cryptoSched.stop();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("market-status", {
      text: `当前仅支持 BINANCE: / OKX: 前缀的加密品种，无法为 ${sym} 订阅行情。请在配置中改为加密代码或切换到加密品种。`,
    });
  }
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

ipcMain.handle("okx:swap-position", async (_event, tvSymbol) => {
  return getOkxSwapPositionSnapshot(loadAppConfig(), tvSymbol);
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
