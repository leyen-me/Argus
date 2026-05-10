type RpcMetricKey = `${string}|${string}|${string}`;

type RpcMetric = {
  method: string;
  status: "ok" | "error";
  code: string;
  count: number;
  durationSecondsTotal: number;
};

const startedAt = Date.now();
const rpcMetrics = new Map<RpcMetricKey, RpcMetric>();

function escapeLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labels(values: Record<string, string>) {
  return Object.entries(values)
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(",");
}

export function recordRpcRequest(input: {
  method: string;
  status: "ok" | "error";
  code?: string;
  durationMs: number;
}) {
  const method = input.method || "unknown";
  const code = input.code || "OK";
  const key: RpcMetricKey = `${method}|${input.status}|${code}`;
  const metric =
    rpcMetrics.get(key) ??
    ({
      method,
      status: input.status,
      code,
      count: 0,
      durationSecondsTotal: 0,
    } satisfies RpcMetric);
  metric.count += 1;
  metric.durationSecondsTotal += Math.max(input.durationMs, 0) / 1000;
  rpcMetrics.set(key, metric);
}

export function renderPrometheusMetrics() {
  const lines = [
    "# HELP argus_process_uptime_seconds Process uptime in seconds.",
    "# TYPE argus_process_uptime_seconds gauge",
    `argus_process_uptime_seconds ${((Date.now() - startedAt) / 1000).toFixed(3)}`,
    "# HELP argus_rpc_requests_total Total HTTP RPC requests.",
    "# TYPE argus_rpc_requests_total counter",
  ];

  for (const metric of rpcMetrics.values()) {
    lines.push(
      `argus_rpc_requests_total{${labels({
        method: metric.method,
        status: metric.status,
        code: metric.code,
      })}} ${metric.count}`,
    );
  }

  lines.push(
    "# HELP argus_rpc_duration_seconds_total Total HTTP RPC handler duration in seconds.",
    "# TYPE argus_rpc_duration_seconds_total counter",
  );

  for (const metric of rpcMetrics.values()) {
    lines.push(
      `argus_rpc_duration_seconds_total{${labels({
        method: metric.method,
        status: metric.status,
        code: metric.code,
      })}} ${metric.durationSecondsTotal.toFixed(6)}`,
    );
  }

  return `${lines.join("\n")}\n`;
}
