const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

const BUNDLED_CONFIG = path.join(__dirname, "config.json");

function defaultConfigFallback() {
  return {
    symbols: [
      { label: "BTC/USDT", value: "BINANCE:BTCUSDT" },
      { label: "ETH/USDT", value: "BINANCE:ETHUSDT" },
      { label: "SPY", value: "AMEX:SPY" },
      { label: "QQQ", value: "NASDAQ:QQQ" },
    ],
    defaultSymbol: "BINANCE:BTCUSDT",
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
    .map((s) => ({ label: s.label.trim(), value: s.value.trim() }))
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

  return { symbols, defaultSymbol };
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

ipcMain.handle("config:get", () => loadAppConfig());

ipcMain.handle("config:path", () => userConfigPath());

ipcMain.handle("config:save", (_event, payload) => {
  const next = normalizeConfig(payload);
  fs.mkdirSync(path.dirname(userConfigPath()), { recursive: true });
  fs.writeFileSync(userConfigPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
});

ipcMain.handle("llm-request-analysis", async (_event, payload) => {
  return {
    ok: true,
    message: "LLM 尚未接入，此为占位响应。",
    received: payload ?? null,
  };
});

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
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
