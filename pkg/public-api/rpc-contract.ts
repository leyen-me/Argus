/**
 * Public HTTP RPC contract shared by the server, renderer bridge and tests.
 * Keep these strings backward compatible; they are part of the shipped API.
 */
export const ARGUS_RPC_METHODS = [
  "config:get",
  "config:path",
  "devtools:open",
  "config:save",
  "config:reset",
  "market:set-context",
  "okx:swap-position",
  "dashboard:get",
  "agent-bar-turns:list-page",
  "agent-bar-turns:get-chart",
  "agent-bar-turns:get-session-messages",
  "prompt-strategies:list",
  "prompt-strategies:get",
  "prompt-strategies:save",
  "prompt-strategies:delete",
  "llm-request-analysis",
  "chartCaptureTest",
  "chart-capture:test",
] as const;

export type ArgusRpcMethod = (typeof ARGUS_RPC_METHODS)[number];

export type ArgusRpcRequest<TArgs extends unknown[] = unknown[]> = {
  method?: string;
  args?: TArgs;
  requestId?: string;
};

export type ArgusRpcSuccessResponse<TResult = unknown> = {
  ok: true;
  result: TResult;
  requestId?: string;
};

export type ArgusRpcErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_FAILED"
  | "UPSTREAM_UNAVAILABLE"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "DATABASE_ERROR"
  | "INTERNAL";

export type ArgusRpcErrorResponse = {
  ok: false;
  error: string;
  code?: ArgusRpcErrorCode;
  details?: unknown;
  requestId?: string;
};

export type ArgusRpcResponse<TResult = unknown> =
  | ArgusRpcSuccessResponse<TResult>
  | ArgusRpcErrorResponse;

export type ArgusRpcHandler = (...args: unknown[]) => unknown | Promise<unknown>;

export type ArgusRpcHandlerMap = Record<ArgusRpcMethod, ArgusRpcHandler>;
