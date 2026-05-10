import fs from "node:fs";
import path from "node:path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { ArgusRpcHandlerMap } from "../../../pkg/public-api/rpc-contract.js";
import type { Logger } from "../../infrastructure/logging/logger.js";
import { requestContextMiddleware } from "./request-context.js";
import { createRpcRouter } from "./rpc-router.js";

export type CreateArgusAppOptions = {
  distDir?: string;
  rpcHandlers: ArgusRpcHandlerMap;
  logger: Logger;
};

/** Create the Express app without starting network listeners. */
export function createArgusApp(options: CreateArgusAppOptions) {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use(requestContextMiddleware(options.logger));
  app.use("/api", createRpcRouter(options.rpcHandlers, options.logger));

  if (options.distDir && fs.existsSync(options.distDir)) {
    app.use(express.static(options.distDir));
    app.get("*", (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith("/api")) return next();
      const htmlPath = path.join(options.distDir!, "index.html");
      if (!fs.existsSync(htmlPath)) return next();
      res.sendFile(htmlPath);
    });
  }

  return app;
}
