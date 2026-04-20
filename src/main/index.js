import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** 构建后位于 out/main，需经 ../../src/node 指向源码目录中的模块 */
const nodeRoot = path.join(__dirname, "..", "..", "src", "node");
const cryptoSched = require(path.join(nodeRoot, "crypto-scheduler.js"));
const { inferFeed } = require(path.join(nodeRoot, "market.js"));
const { loadAppConfig, databasePath, resetAppConfig, saveMergedConfigPayload } = require(
  path.join(nodeRoot, "app-config.js"),
);
const { closeDatabase } = require(path.join(nodeRoot, "local-db", "index.js"));
const { wipeConversationStore } = require(path.join(nodeRoot, "llm-context.js"));
const { wipeTradingStateStore } = require(path.join(nodeRoot, "trading-state.js"));
const { getOkxSwapPositionSnapshot } = require(path.join(nodeRoot, "okx-perp.js"));

/**
 * 左侧当前品种：OKX WS K 线（OKX: 前缀）。
 */
async function routeMarket(cfg, tvSymbol) {
  const interval = cfg.interval || "5";
  const sym = tvSymbol || cfg.defaultSymbol;
  const feed = inferFeed(sym);

  if (feed === "crypto") {
    cryptoSched.start(() => mainWindow, sym, interval);
    return;
  }

  cryptoSched.stop();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("market-status", {
      text: `当前品种需为 OKX: 前缀（如 OKX:BTCUSDT），无法为 ${sym} 订阅行情。请在配置中修改代码或切换到 OKX 品种。`,
    });
  }
}

ipcMain.handle("config:get", () => loadAppConfig());

ipcMain.handle("config:path", () => databasePath());

ipcMain.handle("devtools:open", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.openDevTools();
  }
});

ipcMain.handle("config:save", async (_event, payload) => {
  const next = saveMergedConfigPayload(payload ?? {});
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
      preload: path.join(__dirname, "../preload/index.js"),
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

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

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
  closeDatabase();
});
