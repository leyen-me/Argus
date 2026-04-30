/**
 * Argus HTTP API + WebSocket 推送（替代 Electron IPC）。
 */

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { WebSocketServer } = require("ws");

const nodeRoot = path.join(__dirname, "..", "node");
const cryptoSched = require(path.join(nodeRoot, "crypto-scheduler.js"));
const { inferFeed } = require(path.join(nodeRoot, "market.js"));
const {
  loadAppConfig,
  databasePath,
  resetAppConfig,
  saveMergedConfigPayload,
} = require(path.join(nodeRoot, "app-config.js"));
const promptStrategiesStore = require(path.join(nodeRoot, "prompt-strategies-store.js"));
const { closeDatabase } = require(path.join(nodeRoot, "local-db", "index.js"));
const { wipeConversationStore } = require(path.join(nodeRoot, "llm-context.js"));
const { getOkxSwapPositionSnapshot } = require(path.join(nodeRoot, "okx-perp.js"));
const {
  BACKGROUND_EQUITY_SAMPLE_INTERVAL_MS,
  getDashboardSnapshot,
  sampleDashboardEquityOnce,
} = require(path.join(nodeRoot, "dashboard-service.js"));
const {
  listAgentBarTurnsPage,
  getAgentBarTurnChart,
  getAgentSessionMessages,
} = require(path.join(nodeRoot, "agent-bar-turns-store.js"));
const { publish, subscribe } = require(path.join(nodeRoot, "runtime-bus.js"));
const { ingestChartCaptureResult } = require(path.join(nodeRoot, "chart-capture-browser-bridge.js"));

const AGENT_DECISION_INTERVAL = "5";

/** @type {import("ws").WebSocket[]} */
const wsClients = [];

/** @type {NodeJS.Timeout | null} */
let dashboardEquitySamplerTimer = null;
let dashboardEquitySamplerInFlight = false;

async function runBackgroundEquitySample() {
  if (dashboardEquitySamplerInFlight) return;
  dashboardEquitySamplerInFlight = true;
  try {
    await sampleDashboardEquityOnce(loadAppConfig());
  } catch {
    /* ignore */
  } finally {
    dashboardEquitySamplerInFlight = false;
  }
}

function startBackgroundEquitySampler() {
  stopBackgroundEquitySampler();
  void runBackgroundEquitySample();
  dashboardEquitySamplerTimer = setInterval(() => {
    void runBackgroundEquitySample();
  }, BACKGROUND_EQUITY_SAMPLE_INTERVAL_MS);
}

function stopBackgroundEquitySampler() {
  if (!dashboardEquitySamplerTimer) return;
  clearInterval(dashboardEquitySamplerTimer);
  dashboardEquitySamplerTimer = null;
}

async function routeMarket(cfg, tvSymbol) {
  const interval = AGENT_DECISION_INTERVAL;
  const sym = tvSymbol || cfg.defaultSymbol;
  const feed = inferFeed(sym);

  if (feed === "crypto") {
    cryptoSched.start(sym, interval);
    return;
  }

  cryptoSched.stop();
  publish("market-status", {
    text: `当前品种需为 OKX: 前缀（如 OKX:BTCUSDT），无法为 ${sym} 订阅行情。请在配置中修改代码或切换到 OKX 品种。`,
  });
}

/** @type {Record<string, (...args: unknown[]) => unknown | Promise<unknown>>} */
const rpcHandlers = {
  "config:get": () => loadAppConfig(),
  "config:path": () => databasePath(),
  "devtools:open": () => {
    /* Web 模式下无 Electron DevTools */
    return undefined;
  },
  "config:save": async (_payload) => {
    const payload = _payload ?? {};
    const next = saveMergedConfigPayload(payload);
    await routeMarket(next, next.defaultSymbol);
    void runBackgroundEquitySample();
    return next;
  },
  "config:reset": async () => {
    const next = resetAppConfig();
    await routeMarket(next, next.defaultSymbol);
    void runBackgroundEquitySample();
    return next;
  },
  "market:set-context": async (tvSymbol) => {
    await routeMarket(loadAppConfig(), tvSymbol);
    return undefined;
  },
  "okx:swap-position": async (tvSymbol) => getOkxSwapPositionSnapshot(loadAppConfig(), tvSymbol),
  "dashboard:get": async () => getDashboardSnapshot(loadAppConfig()),
  "agent-bar-turns:list-page": async (args) => listAgentBarTurnsPage(args ?? {}),
  "agent-bar-turns:get-chart": async (barCloseId) => getAgentBarTurnChart(barCloseId),
  "agent-bar-turns:get-session-messages": async (barCloseId) => getAgentSessionMessages(barCloseId),
  "prompt-strategies:list": async () => promptStrategiesStore.listStrategiesMeta(),
  "prompt-strategies:get": async (id) => promptStrategiesStore.getStrategy(id),
  "prompt-strategies:save": async (payload) => {
    promptStrategiesStore.saveStrategy(payload ?? {});
    return loadAppConfig();
  },
  "prompt-strategies:delete": async (id) => {
    promptStrategiesStore.deleteStrategy(id);
    saveMergedConfigPayload({});
    return loadAppConfig();
  },
  "llm-request-analysis": async (payload) => ({
    ok: true,
    message:
      "K 线收盘后会推送 market-bar-close（含 textForLlm 与截图）；填写 API Key 后即可调用 LLM。",
    received: payload ?? null,
  }),
};

function broadcastWs(envelope) {
  const raw = JSON.stringify(envelope);
  for (const ws of wsClients) {
    if (ws.readyState === 1) {
      try {
        ws.send(raw);
      } catch {
        /* ignore */
      }
    }
  }
}

subscribe((env) => broadcastWs(env));

function safeRpcArgs(args) {
  if (args == null) return [];
  return Array.isArray(args) ? args : [];
}

async function shutdown(reason = "shutdown") {
  console.info(`[Argus server] ${reason}`);
  stopBackgroundEquitySampler();
  cryptoSched.stop();
  wipeConversationStore();
  closeDatabase();
  process.exit(0);
}

function createApp(distDir) {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.post("/api/rpc", async (req, res) => {
    try {
      const method = req.body?.method;
      const args = safeRpcArgs(req.body?.args);
      if (typeof method !== "string" || !rpcHandlers[method]) {
        res.status(400).json({ ok: false, error: `unknown method: ${method}` });
        return;
      }
      const result = await rpcHandlers[method](...args);
      res.json({ ok: true, result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  if (distDir && fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api")) return next();
      const htmlPath = path.join(distDir, "index.html");
      if (!fs.existsSync(htmlPath)) return next();
      res.sendFile(htmlPath);
    });
  }

  return app;
}

function main() {
  const PORT = Number(process.env.PORT || 8787);
  const distDir = path.join(__dirname, "..", "..", "dist", "renderer");

  const app = createApp(distDir);
  const server = http.createServer(app);

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    wsClients.push(ws);
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg && msg.type === "chart-capture-result") {
          ingestChartCaptureResult(msg);
        }
      } catch {
        /* ignore malformed client frames */
      }
    });
    ws.on("close", () => {
      const i = wsClients.indexOf(ws);
      if (i >= 0) wsClients.splice(i, 1);
    });
    ws.on("error", () => {
      const i = wsClients.indexOf(ws);
      if (i >= 0) wsClients.splice(i, 1);
    });
  });

  server.listen(PORT, async () => {
    console.info(`[Argus server] listening http://127.0.0.1:${PORT}`);
    const cfg = loadAppConfig();
    await routeMarket(cfg, cfg.defaultSymbol);
    startBackgroundEquitySampler();
  });

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main();
