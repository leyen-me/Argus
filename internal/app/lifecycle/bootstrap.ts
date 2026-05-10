import http from "node:http";
import { captureClientSnapshot } from "../../../src/node/chart-capture-browser-bridge.js";
import * as cryptoSched from "../../../src/node/crypto-scheduler.js";
import { loadAppConfig } from "../../../src/node/app-config.js";
import { closeHeadlessCaptureService, startHeadlessCaptureService } from "../../../src/node/headless-browser-service.js";
import { closeDatabase, initDatabase } from "../../../src/node/local-db/index.js";
import { wipeConversationStore } from "../../../src/node/llm-context.js";
import { routeMarket } from "../../application/services/market-routing-service.js";
import {
  startBackgroundEquitySampler,
  stopBackgroundEquitySampler,
} from "../../application/services/background-equity-sampler.js";
import { rootLogger, type Logger } from "../../infrastructure/logging/logger.js";
import { createArgusApp } from "../http/create-app.js";
import { createRpcHandlers } from "../http/rpc-handlers.js";
import { attachArgusWebSocketServer, type ArgusWebSocketServer } from "../websocket/ws-server.js";

export type BootstrapArgusServerOptions = {
  distDir?: string;
  host?: string;
  port?: number;
  logger?: Logger;
  exitProcess?: boolean;
};

let shutdownPromise: Promise<void> | null = null;

export async function bootstrapArgusServer(options: BootstrapArgusServerOptions = {}) {
  const logger = (options.logger ?? rootLogger).child({ module: "server.bootstrap" });
  try {
    await initDatabase();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("database initialization failed", { error: { message: msg } });
    if (options.exitProcess !== false) process.exit(1);
    throw error;
  }

  const port = options.port ?? Number(process.env.PORT || 8080);
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";
  const app = createArgusApp({
    distDir: options.distDir,
    rpcHandlers: createRpcHandlers(logger),
    logger,
  });
  const server = http.createServer(app);
  const wsServer = attachArgusWebSocketServer(server, logger);

  async function shutdown(reason = "shutdown") {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      logger.info("server shutdown requested", { reason });
      stopBackgroundEquitySampler();
      cryptoSched.stop();
      wipeConversationStore();
      try {
        await wsServer.close();
        await closeHeadlessCaptureService();
        await closeDatabase();
        logger.info("server shutdown complete", { reason });
        if (options.exitProcess !== false) process.exit(0);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("server shutdown failed", { reason, error: { message: msg } });
        if (options.exitProcess !== false) process.exit(1);
        throw error;
      }
    })();
    return shutdownPromise;
  }

  server.listen(port, host, async () => {
    logger.info("server listening", { host, port });
    const cfg = await loadAppConfig();
    await routeMarket(cfg, cfg.defaultSymbol);
    startBackgroundEquitySampler(logger.child({ module: "dashboard.sampler" }));
    void startHeadlessCaptureService({ port }).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      const snapshot = captureClientSnapshot();
      logger.error("headless capture startup failed", {
        error: { message: msg },
        headlessConnected: snapshot.headlessConnected,
        interactiveConnected: snapshot.interactiveConnected,
      });
    });
  });

  if (options.exitProcess !== false) {
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  }

  return { app, server, wsServer: wsServer as ArgusWebSocketServer, shutdown };
}
