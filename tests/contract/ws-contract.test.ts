import { describe, expect, it } from "vitest";
import { ARGUS_WS_CHANNELS } from "../../pkg/public-api/ws-contract.js";
import { targetRoleForEnvelope } from "../../internal/app/websocket/ws-server.js";

describe("WebSocket contract", () => {
  it("documents the currently shipped server channels", () => {
    expect(ARGUS_WS_CHANNELS).toEqual([
      "market-bar-close",
      "market-status",
      "request-chart-capture",
      "llm-stream-delta",
      "llm-stream-end",
      "llm-stream-error",
      "okx-swap-status",
    ]);
  });

  it("preserves request-chart-capture role targeting", () => {
    expect(
      targetRoleForEnvelope({
        channel: "request-chart-capture",
        payload: { targetRole: "headless_capture" },
      }),
    ).toBe("headless_capture");
    expect(
      targetRoleForEnvelope({
        channel: "request-chart-capture",
        payload: { targetRole: "interactive" },
      }),
    ).toBe("interactive");
    expect(targetRoleForEnvelope({ channel: "market-status", payload: {} })).toBeUndefined();
  });
});
