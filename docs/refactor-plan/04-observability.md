# 04. 可观测性方案

## 现状

当前项目主要依赖 `console.info`、`console.warn`、`console.error` 输出运行信息。日志分散在服务端入口、OKX 调度、无头浏览器、bridge、交易执行和邮件通知等模块中，缺少统一字段、请求 ID、指标和链路追踪。

关键链路包括：

- HTTP RPC：前端 `fetch("/api/rpc")` 到服务端 `rpcHandlers`。
- WebSocket：服务端 `publish(channel, payload)` 广播到浏览器。
- 行情订阅：OKX WS -> K 线确认 -> 收盘任务队列。
- 收盘 Agent：行情上下文 -> 浏览器截图 -> LLM 流式输出 -> 交易工具 -> 记录落库。
- Dashboard：仓位/权益采样 -> 数据持久化 -> 前端展示。
- Headless capture：Playwright 页面启动、注册、截图请求、超时/回退。

可观测性建设需要先统一日志与 requestId，再补指标，最后引入跨异步链路追踪。

## 目标

1. 每个 HTTP RPC 请求、WS 入站消息、后台任务都有可关联的 `requestId` 或 `correlationId`。
2. 关键业务链路具备结构化日志，可定位失败模块、错误码、耗时和重试情况。
3. 指标覆盖请求量、错误率、耗时、连接数、任务状态、第三方依赖健康度。
4. 为 OpenTelemetry 预留 trace/span 语义，后续可接入 OTLP、Jaeger、Tempo 或云服务。
5. 日志、指标和 trace 均不泄漏密钥、prompt 全文、交易敏感数据或用户输入原文。

## 结构化日志规范

### Logger 接口

执行阶段新增 `internal/infrastructure/logging/logger.ts`：

```ts
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
```

初始实现可用 JSON console，后续可替换为 `pino`。

### 标准字段

| 字段 | 示例 | 说明 |
|------|------|------|
| `ts` | `2026-05-10T15:58:00.000Z` | 时间 |
| `level` | `info` | 日志级别 |
| `module` | `agent.bar-close` | 模块 |
| `operation` | `runAgentTurn` | 操作 |
| `requestId` | `req_...` | HTTP/WS 请求 |
| `correlationId` | `bar_...` | 跨异步链路关联 |
| `barCloseId` | `...` | 收盘 Agent 链路 |
| `tvSymbol` | `OKX:BTCUSDT` | 允许记录归一化交易对 |
| `durationMs` | `1234` | 耗时 |
| `error.code` | `UPSTREAM_UNAVAILABLE` | 统一错误码 |
| `error.retryable` | `true` | 是否可重试 |

### 日志埋点位置

| 模块 | 事件 | 级别 | 关键字段 |
|------|------|------|----------|
| HTTP RPC middleware | request start/end | `info`/`debug` | `method`、`status`、`durationMs` |
| RPC handler | validation failed | `warn` | `method`、`code`、`details` 摘要 |
| WS server | connect/disconnect | `info` | `clientId`、`role`、`clients` |
| WS server | malformed message | `warn` | `clientId`、`messageType` |
| Market scheduler | subscribe/unsubscribe/reconnect | `info`/`warn` | `tvSymbol`、`interval`、`retryCount` |
| Bar close queue | task queued/start/end | `info` | `barCloseId`、`queueDepth`、`durationMs` |
| Capture service | request/start/success/timeout/fallback | `info`/`warn` | `requestId`、`role`、`timeoutMs` |
| LLM service | request start/stream/end/retry/error | `info`/`warn`/`error` | `model`、`durationMs`、`retryCount` |
| OKX adapter | request/retry/error | `debug`/`warn`/`error` | `endpoint`、`statusCode`、`retryable` |
| DB repository | slow query/error | `warn`/`error` | `repository`、`operation`、`durationMs` |
| Shutdown | signal/start/complete/error | `info`/`error` | `reason` |

## Request ID 与上下文传播

### HTTP

- 入口读取 `X-Request-Id`，不存在则生成。
- 响应头返回同一个 `X-Request-Id`。
- RPC response envelope 新增 `requestId`。
- handler 调用 application service 时传入 `RequestContext`。

```ts
type RequestContext = {
  requestId: string;
  correlationId?: string;
  logger: Logger;
  startedAt: number;
};
```

### WebSocket

- 每个连接分配 `clientId`。
- 入站消息可携带 `requestId`；没有则服务端生成。
- 服务端推送 envelope 可新增 `requestId`、`emittedAt`。
- `request-chart-capture` 与 `chart-capture-result` 必须使用同一截图 `requestId`。

### 后台任务

- K 线收盘生成 `barCloseId` 后作为 `correlationId`。
- 收盘链路所有日志、事件、DB 写入、LLM 调用都携带 `barCloseId`。
- Dashboard 定时采样使用 `correlationId = equity-sample:<timestamp>`。

## 指标方案

建议提供 `/metrics` 端点，初始采用 Prometheus exposition format。执行阶段可引入 `prom-client`；如果暂不引依赖，可先封装 metrics 接口并以 no-op 实现落地调用点。

### 系统指标

| 指标 | 类型 | 标签 | 说明 |
|------|------|------|------|
| `argus_process_uptime_seconds` | Gauge | - | 进程运行时长 |
| `argus_db_migration_runs_total` | Counter | `status` | 启动迁移结果 |
| `argus_db_query_duration_seconds` | Histogram | `repository`、`operation`、`status` | 数据库操作耗时 |
| `argus_ws_clients` | Gauge | `role` | 当前 WS 客户端数量 |
| `argus_ws_messages_total` | Counter | `direction`、`type`、`status` | WS 消息量 |

### API 指标

| 指标 | 类型 | 标签 |
|------|------|------|
| `argus_rpc_requests_total` | Counter | `method`、`status`、`code` |
| `argus_rpc_duration_seconds` | Histogram | `method`、`status` |
| `argus_rpc_unknown_method_total` | Counter | `method` |
| `argus_http_requests_total` | Counter | `route`、`method`、`status` |
| `argus_http_duration_seconds` | Histogram | `route`、`method`、`status` |

### 业务指标

| 指标 | 类型 | 标签 | 说明 |
|------|------|------|------|
| `argus_market_subscriptions` | Gauge | `feed`、`interval` | 行情订阅状态 |
| `argus_market_bar_closes_total` | Counter | `feed`、`interval`、`status` | K 线收盘处理量 |
| `argus_bar_close_queue_depth` | Gauge | - | 收盘任务队列深度 |
| `argus_chart_capture_requests_total` | Counter | `role`、`status` | 截图请求量 |
| `argus_chart_capture_duration_seconds` | Histogram | `role`、`status` | 截图耗时 |
| `argus_llm_turns_total` | Counter | `status`、`retryable` | LLM Agent 回合 |
| `argus_llm_stream_chunks_total` | Counter | `status` | 流式 chunk 数 |
| `argus_okx_requests_total` | Counter | `endpoint`、`status` | OKX 请求量 |
| `argus_okx_ws_reconnects_total` | Counter | `reason` | OKX WS 重连 |
| `argus_trading_tool_calls_total` | Counter | `tool`、`status`、`simulated` | 交易工具调用 |
| `argus_dashboard_equity_samples_total` | Counter | `status` | 权益采样 |

标签注意：

- `tvSymbol` 可能造成高基数，默认不作为指标标签；如必须使用，先归一化并限制白名单。
- 错误消息不能作为标签。

## 链路追踪规划

建议采用 OpenTelemetry 语义，但分阶段落地：

1. 先定义 span 名称和上下文，不强制接入 exporter。
2. 在 HTTP/WS/后台任务入口创建 root span。
3. 在 OKX、LLM、DB、Capture 等 IO 处创建 child span。
4. 后续配置 OTLP exporter，将 trace 发送到 Jaeger/Tempo/云 APM。

### 核心 Trace

#### RPC Trace

```text
HTTP POST /api/rpc
└── rpc.<method>
    ├── validation
    ├── application.<command/query>
    ├── db.<repository.operation>
    └── ws.publish (optional)
```

#### Bar Close Agent Trace

```text
market.bar_close
├── capture.ensure_headless_ready
├── capture.request_chart
│   └── ws.request_chart_capture
├── okx.fetch_exchange_context
├── llm.run_agent_turn
│   ├── llm.stream
│   └── trading_tool.<tool_name>
├── db.persist_agent_turn
└── ws.publish_stream_end
```

#### Dashboard Trace

```text
dashboard.get_snapshot
├── okx.fetch_positions
├── db.list_equity_samples
└── domain.compute_dashboard
```

## 告警建议

执行阶段可先文档化阈值，接入 Prometheus 后启用：

- RPC 5xx 比例持续升高。
- `chart-capture` timeout 数量持续增加。
- LLM 上游失败或 rate limit 持续出现。
- OKX WS 重连频繁。
- DB query p95 耗时异常。
- 无 `interactive` 且无 `headless_capture` 客户端在线。
- Bar close queue depth 长时间大于 0。

## 隐私与安全

禁止记录：

- OpenAI/OKX/SMTP 密钥。
- 完整 LLM prompt、reasoning 或工具参数全文。
- 数据库密码。
- 浏览器截图 base64。
- 完整邮件内容。

允许记录摘要：

- prompt token 估算、模型名、耗时。
- 上游 HTTP 状态码和错误码。
- 截图大小、mime、超时信息。
- 策略 ID、barCloseId、归一化 symbol。

## 落地顺序

1. 新增 logger facade 与 request context。
2. HTTP RPC 增加 requestId middleware 和结构化请求日志。
3. WS server 增加 clientId、role、连接数日志。
4. 统一 `AppError` 与错误日志。
5. 在 capture、LLM、OKX、DB、scheduler 加入关键埋点。
6. 新增 metrics facade 和 no-op 实现，先插入调用点。
7. 引入 Prometheus `/metrics` 端点。
8. 引入 OpenTelemetry trace provider 与可选 exporter。
