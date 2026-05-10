# 可观测性

## 日志

服务端新代码通过 `internal/infrastructure/logging/logger.ts` 输出 JSON 结构化日志。

标准字段：

- `ts`
- `level`
- `module`
- `message`
- `requestId`
- `operation`
- `durationMs`
- `error`

敏感字段（如 password、token、api key、base64、dataUrl）会在 logger facade 中脱敏。

## Request ID

HTTP 请求会读取或生成 `X-Request-Id`：

- 响应 header：`X-Request-Id`
- RPC body：`requestId`
- 日志字段：`requestId`

## 指标与追踪

当前阶段已提供 `GET /metrics`，以 Prometheus text exposition 格式导出：

- `argus_process_uptime_seconds`
- `argus_rpc_requests_total`
- `argus_rpc_duration_seconds_total`

后续可按 `docs/refactor-plan/04-observability.md` 继续引入：

- OpenTelemetry trace/span
- OKX、LLM、Capture、DB 的耗时与错误指标
