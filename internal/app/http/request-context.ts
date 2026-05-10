import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "../../infrastructure/logging/logger.js";

export type HttpRequestContext = {
  requestId: string;
  startedAt: number;
  logger: Logger;
};

const REQUEST_CONTEXT_KEY = "argusRequestContext";

export function requestContextMiddleware(rootLogger: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header("x-request-id");
    const requestId =
      typeof incoming === "string" && incoming.trim() ? incoming.trim() : randomUUID();
    const context: HttpRequestContext = {
      requestId,
      startedAt: Date.now(),
      logger: rootLogger.child({ module: "http", requestId }),
    };
    res.setHeader("X-Request-Id", requestId);
    res.locals[REQUEST_CONTEXT_KEY] = context;
    next();
  };
}

export function getRequestContext(res: Response): HttpRequestContext {
  return res.locals[REQUEST_CONTEXT_KEY] as HttpRequestContext;
}
