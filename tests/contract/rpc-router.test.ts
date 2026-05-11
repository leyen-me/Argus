import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { ARGUS_RPC_METHODS, type ArgusRpcHandlerMap } from "../../pkg/public-api/rpc-contract.js";
import { createArgusApp } from "../../internal/app/http/create-app.js";
import { assertCompleteRpcHandlers } from "../../internal/app/http/rpc-router.js";
import { rootLogger } from "../../internal/infrastructure/logging/logger.js";

function createTestHandlers(overrides: Partial<ArgusRpcHandlerMap> = {}): ArgusRpcHandlerMap {
  const handlers = Object.fromEntries(ARGUS_RPC_METHODS.map((method) => [method, vi.fn()]));
  return {
    ...(handlers as unknown as ArgusRpcHandlerMap),
    ...overrides,
  };
}

describe("HTTP RPC contract", () => {
  it("registers every public RPC method", () => {
    expect(() => assertCompleteRpcHandlers(createTestHandlers())).not.toThrow();
  });

  it("keeps the compatible success envelope", async () => {
    const app = createArgusApp({
      rpcHandlers: createTestHandlers({
        "config:get": vi.fn().mockResolvedValue({ defaultSymbol: "OKX:BTCUSDT" }),
      }),
      logger: rootLogger,
    });

    const res = await request(app)
      .post("/api/rpc")
      .set("X-Request-Id", "test-request")
      .send({ method: "config:get", args: [] })
      .expect(200);

    expect(res.headers["x-request-id"]).toBe("test-request");
    expect(res.body).toMatchObject({
      ok: true,
      result: { defaultSymbol: "OKX:BTCUSDT" },
      requestId: "test-request",
    });
  });

  it("keeps the compatible error envelope for unknown methods", async () => {
    const app = createArgusApp({
      rpcHandlers: createTestHandlers(),
      logger: rootLogger,
    });

    const res = await request(app)
      .post("/api/rpc")
      .set("X-Request-Id", "bad-request")
      .send({ method: "missing:method", args: [] })
      .expect(400);

    expect(res.body).toMatchObject({
      ok: false,
      error: "unknown method: missing:method",
      code: "BAD_REQUEST",
      requestId: "bad-request",
    });
  });

  it("exposes health and Prometheus-compatible metrics endpoints", async () => {
    const app = createArgusApp({
      rpcHandlers: createTestHandlers(),
      logger: rootLogger,
    });

    await request(app).get("/healthz").expect(200, { ok: true });
    const res = await request(app).get("/metrics").expect(200);

    expect(res.text).toContain("# HELP argus_process_uptime_seconds");
    expect(res.text).toContain("# TYPE argus_rpc_requests_total counter");
  });

  it("keeps private network RPC open while password-protecting public RPC", async () => {
    const previousPassword = process.env.ARGUS_PUBLIC_PASSWORD;
    const previousTrustProxy = process.env.ARGUS_TRUST_PROXY;
    process.env.ARGUS_PUBLIC_PASSWORD = "test-password";
    process.env.ARGUS_TRUST_PROXY = "true";
    try {
      const app = createArgusApp({
        rpcHandlers: createTestHandlers({
          "config:get": vi.fn().mockResolvedValue({ defaultSymbol: "OKX:BTCUSDT" }),
        }),
        logger: rootLogger,
      });

      await request(app)
        .post("/api/rpc")
        .set("X-Forwarded-For", "203.0.113.10")
        .send({ method: "config:get", args: [] })
        .expect(401);

      await request(app)
        .post("/api/rpc")
        .set("X-Forwarded-For", "192.168.1.10")
        .send({ method: "config:get", args: [] })
        .expect(200);

      const login = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "203.0.113.10")
        .send({ password: "test-password" })
        .expect(200);

      const token = login.body.result.token;
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(20);

      await request(app)
        .post("/api/rpc")
        .set("X-Forwarded-For", "203.0.113.10")
        .set("Authorization", `Bearer ${token}`)
        .send({ method: "config:get", args: [] })
        .expect(200);
    } finally {
      if (previousPassword == null) delete process.env.ARGUS_PUBLIC_PASSWORD;
      else process.env.ARGUS_PUBLIC_PASSWORD = previousPassword;
      if (previousTrustProxy == null) delete process.env.ARGUS_TRUST_PROXY;
      else process.env.ARGUS_TRUST_PROXY = previousTrustProxy;
    }
  });
});
