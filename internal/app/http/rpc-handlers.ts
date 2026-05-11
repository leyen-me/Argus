import type { ArgusRpcHandlerMap } from "../../../pkg/public-api/rpc-contract.js";
import {
  databasePath,
  loadAppConfig,
  resetAppConfig,
  saveMergedConfigPayload,
} from "../../../src/node/app-config.js";
import {
  getAgentBarTurnChart,
  getAgentSessionMessages,
  listAgentBarTurnsPage,
} from "../../../src/node/agent-bar-turns-store.js";
import { getDashboardSnapshot } from "../../../src/node/dashboard-service.js";
import { getOkxSwapPositionSnapshot } from "../../../src/node/okx-perp.js";
import * as promptStrategiesStore from "../../../src/node/prompt-strategies-store.js";
import {
  requestChartCaptureFromBrowser,
} from "../../../src/node/chart-capture-browser-bridge.js";
import {
  getTradeReview,
  listTradeReviewsPage,
} from "../../../src/node/trade-reviews-store.js";
import { ensureHeadlessCaptureReady } from "../../../src/node/headless-browser-service.js";
import { runBackgroundEquitySample } from "../../application/services/background-equity-sampler.js";
import { routeMarket } from "../../application/services/market-routing-service.js";
import type { Logger } from "../../infrastructure/logging/logger.js";

async function rpcChartCaptureTest(tvSymbol: unknown) {
  const cfg = await loadAppConfig();
  const sym =
    typeof tvSymbol === "string" && tvSymbol.trim()
      ? tvSymbol.trim()
      : String(cfg.defaultSymbol || "").trim() || "OKX:BTCUSDT";
  try {
    await ensureHeadlessCaptureReady();
  } catch {
    /* fallback to any connected interactive page */
  }
  return requestChartCaptureFromBrowser(sym, 45000, cfg.promptStrategyMarketTimeframes, {
    preferredRole: "headless_capture",
    allowRoleFallback: true,
  });
}

/** Build the backward-compatible RPC handler table. */
export function createRpcHandlers(logger?: Logger): ArgusRpcHandlerMap {
  return {
    "config:get": () => loadAppConfig(),
    "config:path": () => databasePath(),
    "devtools:open": () => {
      /* Web 模式下无 Electron DevTools */
      return undefined;
    },
    "config:save": async (_payload) => {
      const payload =
        _payload && typeof _payload === "object" && !Array.isArray(_payload)
          ? (_payload as Record<string, unknown>)
          : {};
      const next = await saveMergedConfigPayload(payload);
      await routeMarket(next, next.defaultSymbol);
      void runBackgroundEquitySample(logger?.child({ module: "dashboard.sampler" }));
      return next;
    },
    "config:reset": async () => {
      const next = await resetAppConfig();
      await routeMarket(next, next.defaultSymbol);
      void runBackgroundEquitySample(logger?.child({ module: "dashboard.sampler" }));
      return next;
    },
    "market:set-context": async (tvSymbol) => {
      await routeMarket(await loadAppConfig(), tvSymbol);
      return undefined;
    },
    "okx:swap-position": async (tvSymbol) =>
      getOkxSwapPositionSnapshot(await loadAppConfig(), tvSymbol),
    "dashboard:get": async () => getDashboardSnapshot(await loadAppConfig()),
    "agent-bar-turns:list-page": async (args) =>
      listAgentBarTurnsPage(
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {},
      ),
    "agent-bar-turns:get-chart": async (barCloseId) => getAgentBarTurnChart(barCloseId),
    "agent-bar-turns:get-session-messages": async (barCloseId) =>
      getAgentSessionMessages(barCloseId),
    "trade-reviews:list-page": async (args) =>
      listTradeReviewsPage(
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {},
      ),
    "trade-reviews:get": async (id) => getTradeReview(String(id || "")),
    "prompt-strategies:list": async () => promptStrategiesStore.listStrategiesMeta(),
    "prompt-strategies:get": async (id) => promptStrategiesStore.getStrategy(id),
    "prompt-strategies:save": async (payload) => {
      await promptStrategiesStore.saveStrategy(
        (payload ?? {}) as Parameters<typeof promptStrategiesStore.saveStrategy>[0],
      );
      const next = await loadAppConfig();
      await routeMarket(next, next.defaultSymbol);
      return next;
    },
    "prompt-strategies:delete": async (id) => {
      await promptStrategiesStore.deleteStrategy(id);
      await saveMergedConfigPayload({});
      const next = await loadAppConfig();
      await routeMarket(next, next.defaultSymbol);
      return next;
    },
    "llm-request-analysis": async (payload) => ({
      ok: true,
      message:
        "K 线收盘后会推送 market-bar-close（含 textForLlm 与截图）；填写 API Key 后即可调用 LLM。",
      received: payload ?? null,
    }),
    // 调试截图（与收盘同源链路）；不含冒号的别名避免个别代理/缓存怪异行为。
    chartCaptureTest: rpcChartCaptureTest,
    "chart-capture:test": rpcChartCaptureTest,
  };
}
