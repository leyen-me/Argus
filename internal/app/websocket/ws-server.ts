import { randomUUID } from "node:crypto";
import type http from "node:http";
import type { WebSocket as ClientWebSocket } from "ws";
import { WebSocketServer } from "ws";
import type { ArgusWsEnvelope, CaptureClientRole } from "../../../pkg/public-api/ws-contract.js";
import {
  ingestChartCaptureResult,
  registerCaptureClient,
  unregisterCaptureClient,
} from "../../../src/node/chart-capture-browser-bridge.js";
import { subscribe } from "../../../src/node/runtime-bus.js";
import type { Logger } from "../../infrastructure/logging/logger.js";
import { isIncomingMessageAuthenticated } from "../security/public-auth.js";

type ArgusWsClient = ClientWebSocket & {
  argusClientId?: string;
  argusClientRole?: CaptureClientRole;
};

export type ArgusWebSocketServer = {
  wss: WebSocketServer;
  close(): Promise<void>;
};

function targetRoleForEnvelope(envelope: unknown): CaptureClientRole | undefined {
  if (!envelope || typeof envelope !== "object") return undefined;
  const env = envelope as ArgusWsEnvelope;
  if (env.channel !== "request-chart-capture" || !env.payload || typeof env.payload !== "object") {
    return undefined;
  }
  const payload = env.payload as { targetRole?: unknown };
  if (payload.targetRole === "headless_capture") return "headless_capture";
  if (payload.targetRole === "interactive") return "interactive";
  return undefined;
}

export function attachArgusWebSocketServer(server: http.Server, logger: Logger): ArgusWebSocketServer {
  const wsClients: ArgusWsClient[] = [];
  const wsLogger = logger.child({ module: "websocket" });
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: (info, done) => {
      if (isIncomingMessageAuthenticated(info.req)) {
        done(true);
        return;
      }
      done(false, 401, "Unauthorized");
    },
  });

  function broadcastWs(envelope: unknown) {
    const raw = JSON.stringify(envelope);
    const targetRole = targetRoleForEnvelope(envelope);
    for (const ws of wsClients) {
      if (ws.readyState === 1) {
        if (targetRole && ws.argusClientRole !== targetRole) continue;
        try {
          ws.send(raw);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          wsLogger.warn("websocket send failed", {
            clientId: ws.argusClientId,
            role: ws.argusClientRole,
            error: { message: msg },
          });
        }
      }
    }
  }

  function removeWsClient(ws: ArgusWsClient) {
    const i = wsClients.indexOf(ws);
    if (i >= 0) wsClients.splice(i, 1);
    if (ws.argusClientId) {
      unregisterCaptureClient(ws.argusClientId);
    }
    wsLogger.info("websocket client disconnected", {
      clientId: ws.argusClientId,
      role: ws.argusClientRole,
      clients: wsClients.length,
    });
  }

  const unsubscribeBus = subscribe((env: unknown) => broadcastWs(env));

  wss.on("connection", (rawWs: ClientWebSocket) => {
    const ws = rawWs as ArgusWsClient;
    ws.argusClientId = randomUUID();
    ws.argusClientRole = registerCaptureClient(ws.argusClientId, "interactive");
    wsClients.push(ws);
    wsLogger.info("websocket client connected", {
      clientId: ws.argusClientId,
      role: ws.argusClientRole,
      clients: wsClients.length,
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: unknown; role?: unknown };
        if (msg && msg.type === "register-client") {
          ws.argusClientRole = registerCaptureClient(ws.argusClientId || randomUUID(), msg.role);
          wsLogger.info("websocket client role registered", {
            clientId: ws.argusClientId,
            role: ws.argusClientRole,
          });
          return;
        }
        if (msg && msg.type === "chart-capture-result") {
          ingestChartCaptureResult(msg);
        }
      } catch {
        wsLogger.warn("ignored malformed websocket frame", {
          clientId: ws.argusClientId,
          role: ws.argusClientRole,
        });
      }
    });
    ws.on("close", () => {
      removeWsClient(ws);
    });
    ws.on("error", () => {
      removeWsClient(ws);
    });
  });

  return {
    wss,
    close: () =>
      new Promise<void>((resolve, reject) => {
        unsubscribeBus();
        wss.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

export { targetRoleForEnvelope };
