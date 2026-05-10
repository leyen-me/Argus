import type { ArgusRpcErrorCode } from "../../../pkg/public-api/rpc-contract.js";

export type AppErrorOptions = {
  code?: ArgusRpcErrorCode;
  details?: unknown;
  cause?: unknown;
  retryable?: boolean;
  statusCode?: number;
};

/** Application error that can be safely mapped to public API responses. */
export class AppError extends Error {
  readonly code: ArgusRpcErrorCode;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = options.code ?? "INTERNAL";
    this.details = options.details;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function statusCodeForAppError(error: AppError): number {
  if (error.statusCode) return error.statusCode;
  switch (error.code) {
    case "BAD_REQUEST":
      return 400;
    case "VALIDATION_FAILED":
      return 422;
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "RATE_LIMITED":
      return 429;
    case "UPSTREAM_UNAVAILABLE":
      return 502;
    case "TIMEOUT":
      return 504;
    case "DATABASE_ERROR":
    case "INTERNAL":
    default:
      return 500;
  }
}

export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AppError(message || "Internal server error", {
    code: "INTERNAL",
    cause: error,
  });
}
