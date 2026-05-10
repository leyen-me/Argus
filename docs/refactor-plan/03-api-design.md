# 03. API 设计详规

## 当前 API 盘点

Argus 当前公开交互面主要有三类：

1. HTTP RPC：`POST /api/rpc`
2. WebSocket：`/ws`
3. 浏览器全局 bridge：`window.argus`

本次重构必须保持以上公开契约兼容。内部可以重构为 typed router、command/query 和领域服务，但外部入口不能破坏已有客户端。

## 兼容性原则

### 必须保持

- HTTP 路径：`POST /api/rpc`
- RPC 请求体：`{ "method": string, "args": unknown[] }`
- RPC 成功响应：`{ "ok": true, "result": unknown }`
- RPC 失败响应：`{ "ok": false, "error": string }`
- WebSocket 路径：`/ws`
- WS 服务端推送 envelope：`{ "channel": string, "payload": unknown }`
- WS 客户端入站消息：
  - `{ "type": "register-client", "role": "interactive" | "headless_capture" }`
  - `{ "type": "chart-capture-result", ... }`
- `window.argus` 方法名、参数顺序、Promise 语义。

### 允许新增

- RPC 响应可新增 `requestId`、`code`、`details`。
- HTTP response header 可新增 `X-Request-Id`。
- WS envelope 可在 `payload` 内新增可选字段。
- 新增 RESTful 资源端点时，旧 RPC 继续保留为兼容适配层。

## RPC 方法目录

| 方法 | 当前用途 | 建议归属模块 | 兼容策略 |
|------|----------|--------------|----------|
| `config:get` | 读取应用配置 | `config.query.getConfig` | 原样保留 |
| `config:path` | 返回数据库连接标签/配置路径兼容值 | `config.query.getConfigPathLabel` | 原样保留，文档注明 deprecated 语义 |
| `devtools:open` | Web 模式空操作 | `system.command.openDevtools` | 原样保留，返回 `undefined` |
| `config:save` | 保存配置并重置行情路由/采样 | `config.command.saveConfig` | 原样保留 |
| `config:reset` | 重置配置并重置行情路由/采样 | `config.command.resetConfig` | 原样保留 |
| `market:set-context` | 切换市场上下文 | `market.command.setContext` | 原样保留 |
| `okx:swap-position` | 获取 OKX 合约仓位快照 | `okx.query.getSwapPosition` | 原样保留 |
| `dashboard:get` | 获取 Dashboard 快照 | `dashboard.query.getSnapshot` | 原样保留 |
| `agent-bar-turns:list-page` | Agent 历史分页 | `agent.query.listBarTurns` | 原样保留，逐步标准化分页 |
| `agent-bar-turns:get-chart` | 获取某次 Agent 图表 | `agent.query.getBarTurnChart` | 原样保留 |
| `agent-bar-turns:get-session-messages` | 获取某次 Agent 消息 | `agent.query.getSessionMessages` | 原样保留 |
| `prompt-strategies:list` | 策略元信息列表 | `strategy.query.listMeta` | 原样保留 |
| `prompt-strategies:get` | 策略详情 | `strategy.query.get` | 原样保留 |
| `prompt-strategies:save` | 保存策略 | `strategy.command.save` | 原样保留 |
| `prompt-strategies:delete` | 删除策略 | `strategy.command.delete` | 原样保留 |
| `llm-request-analysis` | 当前为说明性占位响应 | `agent.command.requestAnalysis` | 原样保留；后续明确真实语义 |
| `chartCaptureTest` | 调试截图别名 | `capture.command.testCapture` | 保留 deprecated 别名 |
| `chart-capture:test` | 调试截图 | `capture.command.testCapture` | 原样保留 |

## RPC 设计规范

### 请求

短期继续接受当前数组参数：

```json
{
  "method": "prompt-strategies:get",
  "args": ["strategy-id"]
}
```

中期在内部转换为对象 command/query：

```ts
type RpcRequest<TArgs extends unknown[] = unknown[]> = {
  method: RpcMethod;
  args: TArgs;
  requestId?: string;
};

type CommandEnvelope<T> = {
  requestId: string;
  payload: T;
};
```

新增方法优先使用单对象参数，避免位置参数继续扩散：

```json
{
  "method": "agent-bar-turns:list-page",
  "args": [
    {
      "cursor": "opaque-cursor",
      "limit": 20,
      "filters": {
        "tvSymbol": "OKX:BTCUSDT"
      },
      "sort": [
        {
          "field": "capturedAt",
          "direction": "desc"
        }
      ]
    }
  ]
}
```

### 响应

兼容响应：

```json
{
  "ok": true,
  "result": {},
  "requestId": "req_01HX..."
}
```

```json
{
  "ok": false,
  "error": "unknown method: xxx",
  "code": "BAD_REQUEST",
  "details": {
    "method": "xxx"
  },
  "requestId": "req_01HX..."
}
```

HTTP 状态码映射：

| 错误码 | HTTP 状态码 |
|--------|-------------|
| `BAD_REQUEST` | 400 |
| `VALIDATION_FAILED` | 422 |
| `UNAUTHORIZED` | 401 |
| `FORBIDDEN` | 403 |
| `NOT_FOUND` | 404 |
| `CONFLICT` | 409 |
| `RATE_LIMITED` | 429 |
| `UPSTREAM_UNAVAILABLE` | 502 |
| `TIMEOUT` | 504 |
| `DATABASE_ERROR` | 500 |
| `INTERNAL` | 500 |

## RESTful 演进方案

当前单端点 RPC 对前端迭代很快，但随着团队扩大，文档、权限、缓存、监控和契约测试都会变难。建议引入 RESTful 资源端点作为新 API 表达，旧 RPC 作为兼容 facade。

### 建议资源

| 资源 | 方法 | 路径 | RPC 兼容映射 |
|------|------|------|--------------|
| Config | GET | `/api/config` | `config:get` |
| Config | PUT | `/api/config` | `config:save` |
| Config | POST | `/api/config/reset` | `config:reset` |
| Market Context | PUT | `/api/market/context` | `market:set-context` |
| Dashboard | GET | `/api/dashboard` | `dashboard:get` |
| OKX Position | GET | `/api/okx/swap-position?tvSymbol=` | `okx:swap-position` |
| Prompt Strategies | GET | `/api/prompt-strategies` | `prompt-strategies:list` |
| Prompt Strategy | GET | `/api/prompt-strategies/{id}` | `prompt-strategies:get` |
| Prompt Strategy | PUT | `/api/prompt-strategies/{id}` | `prompt-strategies:save` |
| Prompt Strategy | DELETE | `/api/prompt-strategies/{id}` | `prompt-strategies:delete` |
| Agent Bar Turns | GET | `/api/agent/bar-turns` | `agent-bar-turns:list-page` |
| Agent Chart | GET | `/api/agent/bar-turns/{barCloseId}/chart` | `agent-bar-turns:get-chart` |
| Agent Messages | GET | `/api/agent/bar-turns/{barCloseId}/messages` | `agent-bar-turns:get-session-messages` |
| Capture Test | POST | `/api/capture/test` | `chart-capture:test` |

### 分页、过滤、排序

查询参数规范：

```text
GET /api/agent/bar-turns?limit=20&cursor=...&filter.tvSymbol=OKX%3ABTCUSDT&sort=-capturedAt
```

- `limit` 默认 20，最大 100。
- `cursor` 为不透明字符串，由服务端生成。
- `filter.<field>` 表达过滤条件。
- `sort` 使用逗号分隔字段，`-` 前缀表示倒序。
- 服务端需白名单允许过滤和排序字段。

响应：

```json
{
  "ok": true,
  "result": {
    "items": [],
    "nextCursor": null,
    "hasMore": false
  },
  "requestId": "req_..."
}
```

## WebSocket / AsyncAPI 设计

### 服务端推送频道

| Channel | 方向 | 用途 | 建议归属 |
|---------|------|------|----------|
| `market-bar-close` | server -> client | K 线收盘 payload 与 LLM 状态 | `market` / `agent` |
| `market-status` | server -> client | 市场订阅、LLM 重试、错误提示 | `market` |
| `request-chart-capture` | server -> client | 请求浏览器截图 | `capture` |
| `llm-stream-delta` | server -> client | LLM 流式增量 | `agent` |
| `llm-stream-end` | server -> client | LLM 流式结束 | `agent` |
| `llm-stream-error` | server -> client | LLM 流式错误 | `agent` |
| `okx-swap-status` | server -> client | OKX 交易工具执行状态 | `okx` |

### 客户端上报消息

| Type | 方向 | 用途 |
|------|------|------|
| `register-client` | client -> server | 声明 `interactive` 或 `headless_capture` 角色 |
| `chart-capture-result` | client -> server | 回传截图结果 |

### Envelope

服务端推送保持兼容：

```json
{
  "channel": "llm-stream-delta",
  "payload": {
    "barCloseId": "..."
  }
}
```

建议新增可选 metadata：

```json
{
  "channel": "llm-stream-delta",
  "payload": {},
  "requestId": "req_...",
  "emittedAt": "2026-05-10T15:58:00.000Z"
}
```

旧客户端忽略未知字段。

## `window.argus` bridge 设计

`window.argus` 是前端稳定 API，后续应由 `pkg/public-api/argus-bridge-contract.ts` 统一声明：

```ts
export type ArgusBridge = {
  onMarketBarClose(callback: (payload: MarketBarClosePayload) => void): void;
  onChartCaptureRequest(callback: (payload: ChartCaptureRequestPayload) => void): void;
  submitChartCaptureResult(result: ChartCaptureResultPayload): void;
  setMarketContext(tvSymbol: string): Promise<unknown>;
  requestAnalysis(payload: unknown): Promise<unknown>;
  getConfig(): Promise<AppConfigDto>;
  saveConfig(config: Partial<AppConfigDto>): Promise<AppConfigDto>;
  resetConfig(): Promise<AppConfigDto>;
  getConfigPath(): Promise<string>;
  openDevTools(): Promise<unknown>;
  getOkxSwapPosition(tvSymbol: string): Promise<unknown>;
  getDashboard(): Promise<DashboardDto>;
  listAgentBarTurnsPage(args: PageRequest): Promise<PageResult<AgentBarTurnDto>>;
  getAgentBarTurnChart(barCloseId: string): Promise<unknown>;
  getAgentSessionMessages(barCloseId: string): Promise<unknown>;
  listPromptStrategiesMeta(): Promise<PromptStrategyMetaDto[]>;
  getPromptStrategy(id: string): Promise<PromptStrategyDto>;
  savePromptStrategy(payload: SavePromptStrategyRequest): Promise<AppConfigDto>;
  deletePromptStrategy(id: string): Promise<AppConfigDto>;
};
```

短期可保留若干 `unknown`，但每个迁移后的领域应补齐 DTO。

## OpenAPI / AsyncAPI 文档计划

执行阶段新增：

- `api/openapi.yaml`：记录 `/api/rpc` 与新增 RESTful 资源端点。
- `api/asyncapi.yaml`：记录 `/ws` 频道、payload、客户端消息。

OpenAPI 初始必须包含：

1. `/api/rpc`
2. `RpcRequest`
3. `RpcSuccessResponse`
4. `RpcErrorResponse`
5. `PageRequest`
6. `PageResult`
7. 当前全部 RPC method 枚举

在 REST 端点真正落地前，OpenAPI 可以先将 REST 端点标记为 `x-argus-status: proposed`，避免误导调用方。

## 版本策略

- 现有 RPC/WS 为 `v1` 隐式契约。
- 新增响应字段必须向后兼容。
- 若未来需要破坏性 API，新增 `/api/v2/*` 或 `method` 命名空间，不修改 v1 语义。
- deprecated 方法保留至少一个稳定发布周期；当前 `chartCaptureTest` 和 `config:path` 需要文档标注但不能立即删除。

## 安全与限流

当前本地应用场景未看到鉴权层，但重构时应预留：

- requestId 中间件。
- 请求体大小限制按 endpoint 配置；当前 `/api/rpc` 为 4MB。
- 对截图、LLM、OKX 交易相关接口设置并发与速率限制。
- 未来如开放远程访问，增加鉴权、CSRF/CORS 策略和审计日志。

## API 迁移顺序

1. 提取 `pkg/public-api` 类型，保持运行时代码不变。
2. 为 `/api/rpc` 建立契约测试，锁定 method、envelope 和错误行为。
3. 将 `rpcHandlers` 拆为按领域注册的 typed handlers。
4. 为 WS channel 建立 typed event bus 和 AsyncAPI 草稿。
5. 在不影响旧 RPC 的前提下引入 RESTful resource router。
6. 前端 bridge 内部可逐步改为 REST，但 `window.argus` 对外方法保持不变。
