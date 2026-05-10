import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { ARGUS_RPC_METHODS, type ArgusRpcHandlerMap } from "../../pkg/public-api/rpc-contract.js";
import { createArgusApp } from "../../internal/app/http/create-app.js";
import { assertCompleteRpcHandlers } from "../../internal/app/http/rpc-router.js";
import { rootLogger } from "../../internal/infrastructure/logging/logger.js";

function createTestHandlers(overrides: Partial<ArgusRpcHandlerMap> = {}): ArgusRpcHandlerMap {
  const handlers = Object.fromEntries(ARGUS_RPC_METHODS.map((method) => [method, vi.fn()]));
  return {
    ...(handlers as ArgusRpcHandlerMap),
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
});
