/**
 * Public WebSocket contract. Server pushes use `{ channel, payload }`, while
 * browser clients report role and chart capture results with `type` messages.
 */
export const ARGUS_WS_CHANNELS = [
  "market-bar-close",
  "market-status",
  "request-chart-capture",
  "llm-stream-delta",
  "llm-stream-end",
  "llm-stream-error",
  "okx-swap-status",
] as const;

export type ArgusWsChannel = (typeof ARGUS_WS_CHANNELS)[number];

export type CaptureClientRole = "interactive" | "headless_capture";

export type ArgusWsEnvelope<TPayload = unknown> = {
  channel: ArgusWsChannel | string;
  payload: TPayload;
  requestId?: string;
  emittedAt?: string;
};

export type RegisterClientMessage = {
  type: "register-client";
  role?: CaptureClientRole;
  requestId?: string;
};

export type ChartCaptureResultMessage = {
  type: "chart-capture-result";
  requestId?: string;
  ok?: boolean;
  error?: string;
  mimeType?: string;
  base64?: string;
  dataUrl?: string;
  charts?: unknown[];
};

export type ArgusWsClientMessage = RegisterClientMessage | ChartCaptureResultMessage;
