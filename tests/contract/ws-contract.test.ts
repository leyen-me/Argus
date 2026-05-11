import type http from "node:http";
import { describe, expect, it } from "vitest";
import { ARGUS_WS_CHANNELS } from "../../pkg/public-api/ws-contract.js";
import { targetRoleForEnvelope } from "../../internal/app/websocket/ws-server.js";
import {
  isIncomingMessageAuthenticated,
  issuePublicAuthToken,
} from "../../internal/app/security/public-auth.js";

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

  it("requires a token for public WebSocket requests and keeps private requests open", () => {
    const previousPassword = process.env.ARGUS_PUBLIC_PASSWORD;
    const previousTrustProxy = process.env.ARGUS_TRUST_PROXY;
    process.env.ARGUS_PUBLIC_PASSWORD = "test-password";
    process.env.ARGUS_TRUST_PROXY = "true";
    try {
      const publicReq = {
        headers: { "x-forwarded-for": "203.0.113.10" },
        socket: { remoteAddress: "127.0.0.1" },
        url: "/ws",
      } as unknown as http.IncomingMessage;
      expect(isIncomingMessageAuthenticated(publicReq)).toBe(false);

      const token = issuePublicAuthToken();
      const authedReq = {
        headers: { "x-forwarded-for": "203.0.113.10" },
        socket: { remoteAddress: "127.0.0.1" },
        url: `/ws?argus_token=${encodeURIComponent(token)}`,
      } as unknown as http.IncomingMessage;
      expect(isIncomingMessageAuthenticated(authedReq)).toBe(true);

      const privateReq = {
        headers: { "x-forwarded-for": "192.168.1.10" },
        socket: { remoteAddress: "127.0.0.1" },
        url: "/ws",
      } as unknown as http.IncomingMessage;
      expect(isIncomingMessageAuthenticated(privateReq)).toBe(true);
    } finally {
      if (previousPassword == null) delete process.env.ARGUS_PUBLIC_PASSWORD;
      else process.env.ARGUS_PUBLIC_PASSWORD = previousPassword;
      if (previousTrustProxy == null) delete process.env.ARGUS_TRUST_PROXY;
      else process.env.ARGUS_TRUST_PROXY = previousTrustProxy;
    }
  });
});
