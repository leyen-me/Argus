/**
 * Argus HTTP API + WebSocket 推送（替代 Electron IPC）。
 */

import type { WebSocket as ClientWebSocket } from "ws";
import type { Request, Response, NextFunction } from "express";
import express from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import * as cryptoSched from "../node/crypto-scheduler.js";
import { inferFeed } from "../node/market.js";
import {
  loadAppConfig,
  databasePath,
  resetAppConfig,
  saveMergedConfigPayload,
} from "../node/app-config.js";
import * as promptStrategiesStore from "../node/prompt-strategies-store.js";
import { closeDatabase } from "../node/local-db/index.js";
import { wipeConversationStore } from "../node/llm-context.js";
import { getOkxSwapPositionSnapshot } from "../node/okx-perp.js";
import {
  BACKGROUND_EQUITY_SAMPLE_INTERVAL_MS,
  getDashboardSnapshot,
  sampleDashboardEquityOnce,
} from "../node/dashboard-service.js";
import {
  listAgentBarTurnsPage,
  getAgentBarTurnChart,
  getAgentSessionMessages,
} from "../node/agent-bar-turns-store.js";
import { publish, subscribe } from "../node/runtime-bus.js";
import {
  ingestChartCaptureResult,
  requestChartCaptureFromBrowser,
} from "../node/chart-capture-browser-bridge.js";
import { normalizeStrategyDecisionIntervalTv } from "../shared/strategy-fields.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const wsClients: ClientWebSocket[] = [];

let dashboardEquitySamplerTimer: ReturnType<typeof setInterval> | null = null;
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
  const interval =
    typeof cfg.promptStrategyDecisionIntervalTv === "string"
      ? normalizeStrategyDecisionIntervalTv(cfg.promptStrategyDecisionIntervalTv)
      : promptStrategiesStore.getDecisionIntervalTvForStrategyId(cfg.promptStrategy);
  const sym = tvSymbol || cfg.defaultSymbol;
  const feed = inferFeed(sym);

  if (feed === "crypto") {
    cryptoSched.start(sym, interval);
    return;
  }

  cryptoSched.stop();
  publish("market-status", {
    text: `当前品种需为 OKX: 前缀（如 OKX:BTCUSDT），无法为 ${sym} 订阅行情。请在策略中心为该策略绑定支持的代币（BTC / ETH / SOL / DOGE）。`,
  });
}

async function rpcChartCaptureTest(tvSymbol) {
  const cfg = loadAppConfig();
  const sym =
    typeof tvSymbol === "string" && tvSymbol.trim()
      ? tvSymbol.trim()
      : String(cfg.defaultSymbol || "").trim() || "OKX:BTCUSDT";
  return requestChartCaptureFromBrowser(sym, 45000);
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
    const next = loadAppConfig();
    await routeMarket(next, next.defaultSymbol);
    return next;
  },
  "prompt-strategies:delete": async (id) => {
    promptStrategiesStore.deleteStrategy(id);
    saveMergedConfigPayload({});
    const next = loadAppConfig();
    await routeMarket(next, next.defaultSymbol);
    return next;
  },
  "llm-request-analysis": async (payload) => ({
    ok: true,
    message:
      "K 线收盘后会推送 market-bar-close（含 textForLlm 与截图）；填写 API Key 后即可调用 LLM。",
    received: payload ?? null,
  }),
  // 调试截图（与收盘同源链路）；不含冒号的别名避免个别代理/缓存怪异行为
  chartCaptureTest: rpcChartCaptureTest,
  "chart-capture:test": rpcChartCaptureTest,
};

function broadcastWs(envelope: unknown) {
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

subscribe((env: unknown) => broadcastWs(env));

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

function createApp(distDir: string | undefined) {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.post("/api/rpc", async (req: Request, res: Response) => {
    try {
      const rawMethod = req.body?.method;
      const method = typeof rawMethod === "string" ? rawMethod.trim() : "";
      const args = safeRpcArgs(req.body?.args);
      const handler = rpcHandlers[method as keyof typeof rpcHandlers];
      if (!method || !handler) {
        res.status(400).json({ ok: false, error: `unknown method: ${rawMethod ?? ""}` });
        return;
      }
      const result = await (handler as (...args: unknown[]) => unknown | Promise<unknown>)(...args);
      res.json({ ok: true, result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  if (distDir && fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get("*", (req: Request, res: Response, next: NextFunction) => {
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
  wss.on("connection", (ws: ClientWebSocket) => {
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
