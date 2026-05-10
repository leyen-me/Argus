# 05. 重构实施路线图

## 总体原则

本路线图以“先安全网、再外壳、后核心”的顺序推进。每个阶段都应保持可构建、可回滚、对外 API 兼容，并以小提交完成明确边界的变更。

约束：

- 所有实现变更必须在新分支上进行。
- 对外公开 API 保持兼容：`/api/rpc`、`/ws`、`window.argus` 不破坏。
- 数据库表结构变更必须通过 Drizzle 迁移提交，并提供回滚/兼容说明。
- 重构前必须先补契约和关键路径测试。
- 内部不兼容改造允许直接替换，不为未发布的中间状态保留多层兼容 shim。

## 阶段 0：规划确认

产出：

- `docs/refactor-plan/01-module-structure.md`
- `docs/refactor-plan/02-standards-spec.md`
- `docs/refactor-plan/03-api-design.md`
- `docs/refactor-plan/04-observability.md`
- `docs/refactor-plan/05-implementation-roadmap.md`

完成标准：

- 团队确认目标目录结构、API 兼容边界和分阶段策略。
- 明确哪些变更属于第一轮执行范围，哪些作为后续演进。

## 阶段 1：建立安全网

目标：在移动代码前锁定外部行为。

建议变更：

1. 引入测试框架与脚本：
   - `vitest`
   - `supertest`
   - React 测试按需引入 `@testing-library/react`
2. 增加 `pnpm test` 与 `pnpm check`。
3. 为 `src/server/index.ts` 提取可测试 app factory，或先通过最小 adapter 测试 `/api/rpc`。
4. 新增契约测试：
   - unknown method 返回 `ok: false`。
   - 每个现有 RPC method 名称可被注册。
   - 响应 envelope 保持 `{ ok, result/error }`。
   - WS envelope 保持 `{ channel, payload }`。
5. 新增关键纯函数测试：
   - 分页参数解析。
   - 策略执行态 skip reason。
   - TradingView interval 归一化。
   - 关键 prompt/Markdown 格式化函数。
6. 在 CI 或本地 `pnpm check` 中串联 `typecheck`、`lint`、`test`。

风险与注意：

- 当前没有测试脚本，第一步会引入测试依赖和测试组织方式。
- 部分模块使用全局单例和启动副作用，测试前需要先拆少量 factory，但不得改变外部行为。

## 阶段 2：沉淀公开契约

目标：让 API/WS/bridge 的公开类型有单一来源。

建议变更：

1. 新增 `pkg/public-api`：
   - `rpc-contract.ts`
   - `ws-contract.ts`
   - `argus-bridge-contract.ts`
   - `pagination.ts`
   - `errors.ts`
2. 将 `argus-bridge.ts` 中的 payload 类型迁移或 re-export 到 `pkg/public-api`。
3. 将 RPC method、WS channel、client message type 定义为常量或 string union。
4. 服务端 `rpcHandlers` 和前端 bridge 同时引用同一契约。
5. 新增 `api/openapi.yaml`，至少记录 `/api/rpc`、envelope、method enum。
6. 新增 `api/asyncapi.yaml`，记录 `/ws` channel 和客户端消息。

完成标准：

- 契约类型不依赖 `internal`。
- 前后端 method/channel 字符串不再各自手写。
- 文档能覆盖当前已上线接口，而不是只描述未来状态。

## 阶段 3：拆分服务端入口与协议层

目标：降低 `src/server/index.ts` 的职责密度。

建议目标结构：

```text
cmd/argus-server/main.ts
internal/app/lifecycle/bootstrap.ts
internal/app/lifecycle/shutdown.ts
internal/app/http/create-app.ts
internal/app/http/rpc-router.ts
internal/app/websocket/ws-server.ts
internal/app/websocket/client-registry.ts
```

步骤：

1. 将 `createApp(distDir)` 移动到 `internal/app/http/create-app.ts`。
2. 将 `/api/rpc` handler 移动到 `internal/app/http/rpc-router.ts`。
3. 将 `rpcHandlers` 按领域拆成 handler registry，但 method 名保持不变。
4. 将 WebSocket 连接、广播、角色注册移动到 `internal/app/websocket`。
5. 将启动初始化、后台采样、关停流程移动到 lifecycle。
6. 保持 `src/server/index.ts` 或新 `cmd` 入口仅做 bootstrap 调用；迁移完成后更新 `package.json` main/build root。

完成标准：

- `cmd` 或 server 入口不包含业务 handler 实现。
- HTTP 与 WS 可以在测试中独立创建。
- 旧入口路径在过渡期间仍可运行，直到构建配置同步切换。

## 阶段 4：统一错误、日志与请求上下文

目标：为后续领域拆分提供横切能力。

建议变更：

1. 新增 `internal/pkg/errors`，定义 `AppError`、错误码和 HTTP 映射。
2. 新增 requestId middleware：
   - 读取/生成 `X-Request-Id`
   - 写响应头
   - 注入 request context
3. 新增 `internal/infrastructure/logging` logger facade。
4. HTTP RPC handler 使用统一错误转换。
5. WS 入站消息解析失败改为结构化 warn 日志。
6. 将服务端入口、scheduler、headless、OKX、LLM 的关键 `console.*` 逐步替换为 logger。

完成标准：

- RPC 错误响应兼容旧字段，并新增 `code`、`requestId`。
- 关键路径日志包含 `module`、`operation`、`requestId/correlationId`。
- 不再在新代码中直接使用 `console.*`，logger 实现内部除外。

## 阶段 5：拆分数据层与 repository

目标：让业务用例不直接依赖 Drizzle 实现细节。

建议结构：

```text
internal/infrastructure/db/
├── client.ts
├── schema.ts
├── migrations.ts
└── repositories/
    ├── config-repository.ts
    ├── strategy-repository.ts
    ├── agent-session-repository.ts
    └── dashboard-repository.ts
```

步骤：

1. 移动 `src/node/db/client.ts` 与 `schema.ts`，同步 `drizzle.config.ts`。
2. 保持 `drizzle/` 迁移目录和历史不变。
3. 建立 repository 接口与 Drizzle 实现。
4. 将 `local-db/index.ts`、`prompt-strategies-store.ts`、`agent-bar-turns-store.ts`、`dashboard-store.ts` 拆为应用服务 + repository。
5. 为 repository 增加集成测试，覆盖启动迁移和主要 CRUD。

风险：

- 启动时迁移目录当前依赖编译后相对路径，移动文件时必须测试生产构建路径。
- MySQL 5.7 兼容性不能被新 SQL 破坏。

## 阶段 6：按领域拆分应用服务

目标：让复杂业务链路由清晰的 command/query/service 组成。

### Config / Strategy

- 拆分配置模型、持久化、保存后副作用。
- 策略 CRUD 统一输入校验、排序和默认值。
- 保持 `config:save` 保存后触发行情路由和 Dashboard 采样。

### Market / Scheduler

- 将 OKX WS 连接、订阅管理、K 线确认、收盘任务队列拆开。
- 明确串行队列不变量：同一运行进程中收盘 Agent 任务不得并发破坏流式事件顺序。
- 为重连、订阅失败、非 OKX symbol 提示补测试。

### Capture

- 拆分 capture request registry、WS client role registry、headless browser adapter。
- 保持 `request-chart-capture` channel 和 `chart-capture-result` 入站消息兼容。
- 增加截图超时、角色 fallback、客户端断连测试。

### Agent / LLM / Trading Tools

- 从 `bar-close.ts` 提取：
  - prompt 构建纯函数
  - exchange context gate
  - capture 编排
  - LLM streaming 编排
  - 落库和事件发布
- OpenAI/LLM SDK 调用放入 infrastructure adapter。
- Trading tool executor 明确模拟/真实执行、通知和状态事件边界。

### Dashboard

- 分离权益采样、统计计算、展示 DTO。
- 明确采样失败不影响主流程，但必须有 warn 日志和指标。

完成标准：

- 每个领域至少有一组单元测试或契约测试。
- application service 不依赖 Express、WebSocket、React。
- 复杂函数被拆分到可命名、可测试的小模块。

## 阶段 7：前端目录迁移与 UI 边界

目标：让 Web 前端消费稳定 public API，而不是依赖后端实现细节。

步骤：

1. 将 `src/renderer` 迁移到 `web/renderer`。
2. 更新 `vite.config.ts` root、alias、tsconfig include。
3. `argus-bridge.ts` 引用 `pkg/public-api` 类型。
4. 将大型 `argus-renderer.ts` 按职责拆分：
   - TradingView widget adapter
   - chart capture service
   - market context state
   - UI event handlers
5. 为 bridge 和关键组件补测试。
6. 检查 `src/renderer/index.html` CSP，确保新资源路径和域名仍符合安全策略。

完成标准：

- 构建产物路径不变：`dist`。
- Vite dev proxy `/api` 与 `/ws` 行为不变。
- `window.argus` 方法和事件订阅行为不变。

## 阶段 8：API 文档与 RESTful facade

目标：让公开 API 可被文档、测试和未来 SDK 消费。

步骤：

1. 完善 `api/openapi.yaml`，覆盖当前 RPC。
2. 完善 `api/asyncapi.yaml`，覆盖 WS channel。
3. 根据 `03-api-design.md` 新增 RESTful resource router。
4. REST handler 复用 application service；RPC handler 作为兼容 facade。
5. README 增加 API 文档入口和兼容说明。

完成标准：

- OpenAPI/AsyncAPI 与代码中的 method/channel 枚举一致。
- 新 REST 端点不改变旧 RPC 行为。
- 分页、过滤、排序有统一 DTO 和测试。

## 阶段 9：可观测性增强

目标：把日志、指标、追踪从规范落到运行时。

步骤：

1. 在 HTTP、WS、scheduler、capture、LLM、OKX、DB 加入指标调用点。
2. 新增 `/metrics` 端点。
3. 引入 Prometheus client 或等价实现。
4. 加入 OpenTelemetry trace facade。
5. 对核心链路建立 span：
   - RPC
   - bar close agent
   - chart capture
   - LLM streaming
   - DB repository
6. 更新部署文档，说明如何抓取 metrics 和配置 exporter。

完成标准：

- 本地启动后可访问 `/metrics`。
- 关键失败能通过 requestId/correlationId 在日志中串联。
- 指标标签不包含高基数或敏感信息。

## 阶段 10：文档与发布收口

目标：确保团队能理解、运行、部署和继续演进新架构。

更新：

- `README.md`
  - 项目概述
  - 快速开始
  - 架构说明
  - 开发命令
  - 测试与质量检查
  - 部署指南
  - API 文档入口
  - 故障排查
- `docs/architecture.md`
- `docs/development.md`
- `docs/deployment.md`
- `docs/testing.md`
- `docs/observability.md`
- `docs/database-migrations.md`

完成标准：

- 新成员可仅依赖 README 和 docs 完成本地启动、测试和一次小改动。
- 生产部署步骤与当前 `pnpm build && pnpm start` 兼容或有明确迁移说明。
- 数据库迁移策略和回滚注意事项明确。

## 推荐提交切分

每个提交只覆盖一个逻辑边界：

1. `test: add contract test harness`
2. `api: define public rpc and websocket contracts`
3. `server: split http rpc router`
4. `server: split websocket server`
5. `infra: add structured logger and request context`
6. `db: move drizzle client behind repositories`
7. `strategy: extract strategy application service`
8. `capture: isolate browser capture service`
9. `agent: split bar close agent workflow`
10. `web: move renderer under web directory`
11. `docs: update architecture and deployment guides`

## 回滚策略

- 目录迁移阶段保留小步提交，出现问题时回滚单个领域提交。
- 数据库迁移必须向后兼容；新增字段优先 nullable 或有默认值，删除字段需分两步完成。
- API 新增字段只做可选，不改变旧字段语义。
- RESTful facade 初期不替换 RPC 调用，确认稳定后再考虑前端内部切换。

## 风险清单

| 风险 | 影响 | 缓解 |
|------|------|------|
| 无现有自动化测试 | 重构易回归 | 阶段 1 先补契约测试 |
| `src/server/index.ts` 职责过多 | 拆分容易影响启动流程 | 先提 app factory 和 WS factory |
| 收盘 Agent 链路复杂 | 流式事件、截图、落库顺序易破坏 | 保持串行队列不变量并补链路测试 |
| MySQL 迁移路径依赖构建目录 | 生产启动可能找不到迁移 | 移动 DB 前做 build/start 验证 |
| 前端 bridge 是隐式公开 API | UI 静默失配 | 类型集中到 `pkg/public-api`，增加契约测试 |
| Playwright/headless 环境敏感 | 截图功能不稳定 | 将 capture adapter 隔离并加超时/fallback 测试 |
| 日志与指标可能泄漏敏感信息 | 安全风险 | 脱敏规则和禁止字段纳入 logger |

## 第一轮执行建议范围

在规划获认可后，第一轮执行建议聚焦以下低风险高收益内容：

1. 引入测试框架与最小契约测试。
2. 提取 public API 契约。
3. 拆分 `src/server/index.ts` 的 HTTP RPC 与 WS 外壳。
4. 增加 requestId 与结构化 logger facade。

这些改动能为后续领域拆分提供安全网和清晰边界，同时不触碰数据库 schema 和复杂 Agent 行为。
