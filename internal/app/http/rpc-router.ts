import express from "express";
import type { Request, Response } from "express";
import {
  ARGUS_RPC_METHODS,
  type ArgusRpcHandler,
  type ArgusRpcHandlerMap,
} from "../../../pkg/public-api/rpc-contract.js";
import { AppError, statusCodeForAppError, toAppError } from "../../pkg/errors/app-error.js";
import type { Logger } from "../../infrastructure/logging/logger.js";
import { recordRpcRequest } from "../../infrastructure/metrics/metrics.js";
import { getRequestContext } from "./request-context.js";

function safeRpcArgs(args: unknown): unknown[] {
  if (args == null) return [];
  return Array.isArray(args) ? args : [];
}

export function assertCompleteRpcHandlers(
  handlers: Partial<Record<string, ArgusRpcHandler>>,
): asserts handlers is ArgusRpcHandlerMap {
  const missing = ARGUS_RPC_METHODS.filter((method) => typeof handlers[method] !== "function");
  if (missing.length > 0) {
    throw new AppError(`RPC handler registration incomplete: ${missing.join(", ")}`, {
      code: "INTERNAL",
    });
  }
}

export function createRpcRouter(handlers: ArgusRpcHandlerMap, rootLogger: Logger) {
  assertCompleteRpcHandlers(handlers);
  const router = express.Router();
  const logger = rootLogger.child({ module: "http.rpc" });

  router.post("/rpc", async (req: Request, res: Response) => {
    const context = getRequestContext(res);
    const startedAt = Date.now();
    const rawMethod = req.body?.method;
    const method = typeof rawMethod === "string" ? rawMethod.trim() : "";
    const args = safeRpcArgs(req.body?.args);
    const handler = handlers[method as keyof ArgusRpcHandlerMap];

    try {
      if (!method || !handler) {
        throw new AppError(`unknown method: ${rawMethod ?? ""}`, {
          code: "BAD_REQUEST",
          details: { method: rawMethod ?? "" },
          statusCode: 400,
        });
      }

      const result = await handler(...args);
      const durationMs = Date.now() - startedAt;
      recordRpcRequest({ method, status: "ok", durationMs });
      res.json({ ok: true, result, requestId: context.requestId });
      logger.info("rpc request completed", {
        requestId: context.requestId,
        method,
        status: "ok",
        durationMs,
      });
    } catch (error) {
      const appError = toAppError(error);
      const statusCode = statusCodeForAppError(appError);
      const durationMs = Date.now() - startedAt;
      recordRpcRequest({
        method: method || String(rawMethod ?? ""),
        status: "error",
        code: appError.code,
        durationMs,
      });
      res.status(statusCode).json({
        ok: false,
        error: appError.message,
        code: appError.code,
        details: appError.details,
        requestId: context.requestId,
      });
      logger.warn("rpc request failed", {
        requestId: context.requestId,
        method: method || String(rawMethod ?? ""),
        status: "error",
        statusCode,
        durationMs,
        error: {
          code: appError.code,
          message: appError.message,
          retryable: appError.retryable,
        },
      });
    }
  });

  return router;
}
