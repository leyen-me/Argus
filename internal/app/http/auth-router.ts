import express from "express";
import type { Request, Response } from "express";
import {
  issuePublicAuthToken,
  publicAuthSession,
  verifyPublicPassword,
} from "../security/public-auth.js";

export function createAuthRouter() {
  const router = express.Router();

  router.get("/session", (req: Request, res: Response) => {
    res.json({ ok: true, result: publicAuthSession(req) });
  });

  router.post("/login", (req: Request, res: Response) => {
    const session = publicAuthSession(req);
    if (!session.authRequired) {
      res.json({ ok: true, result: { token: "", session } });
      return;
    }

    if (!verifyPublicPassword(req.body?.password)) {
      res.status(401).json({
        ok: false,
        error: "访问密码不正确",
        code: "UNAUTHORIZED",
      });
      return;
    }

    const token = issuePublicAuthToken();
    res.json({
      ok: true,
      result: {
        token,
        session: { authRequired: true, authenticated: true },
      },
    });
  });

  return router;
}
