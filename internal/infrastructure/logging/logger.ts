export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = {
  requestId?: string;
  correlationId?: string;
  module: string;
  operation?: string;
  barCloseId?: string;
  tvSymbol?: string;
};

export type Logger = {
  child(context: Partial<LogContext>): Logger;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

const SENSITIVE_KEY_PATTERN = /(api[_-]?key|password|secret|token|authorization|base64|dataUrl)/i;

function sanitize(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : sanitize(raw);
  }
  return out;
}

class JsonConsoleLogger implements Logger {
  constructor(private readonly context: LogContext) {}

  child(context: Partial<LogContext>): Logger {
    return new JsonConsoleLogger({ ...this.context, ...context });
  }

  debug(message: string, fields: Record<string, unknown> = {}) {
    this.write("debug", message, fields);
  }

  info(message: string, fields: Record<string, unknown> = {}) {
    this.write("info", message, fields);
  }

  warn(message: string, fields: Record<string, unknown> = {}) {
    this.write("warn", message, fields);
  }

  error(message: string, fields: Record<string, unknown> = {}) {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields: Record<string, unknown>) {
    const record = {
      ts: new Date().toISOString(),
      level,
      message,
      ...this.context,
      ...(sanitize(fields) as Record<string, unknown>),
    };
    const line = JSON.stringify(record);
    if (level === "error") {
      console.error(line);
      return;
    }
    if (level === "warn") {
      console.warn(line);
      return;
    }
    console.info(line);
  }
}

export const rootLogger: Logger = new JsonConsoleLogger({ module: "argus" });
