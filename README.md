# Argus

Argus 是一个 Node 后端 + Web 前端的多模态交易辅助应用，围绕 OKX K 线收盘、TradingView 多周期截图、LLM Agent、策略管理与 Dashboard 展示构建。

持久化使用 **MySQL 5.7+**（默认库名 `argus`）。首次启动会自动执行 `drizzle` 迁移建表；不迁移旧版 `argus.sqlite` 数据。

## 架构概览

当前重构后的核心边界：

```text
src/server/index.ts                  # 兼容启动入口，委托 internal bootstrap
internal/app/http                    # Express app、RPC router、requestId middleware
internal/app/websocket               # /ws 连接管理、频道广播、截图客户端角色
internal/app/lifecycle               # 数据库初始化、后台任务、关停流程
internal/application/services        # 应用用例编排服务
internal/infrastructure/logging      # 结构化日志 facade
internal/pkg/errors                  # 统一 AppError 与 HTTP 映射
pkg/public-api                       # RPC/WS/window.argus 公开契约
api/openapi.yaml                     # HTTP RPC 契约文档
api/asyncapi.yaml                    # WebSocket 契约文档
src/node                             # 现有领域和基础设施逻辑，后续按领域继续迁移
src/renderer                         # Vite + React 前端
```

公开兼容边界保持不变：

- HTTP：`POST /api/rpc`
- WebSocket：`/ws`
- 浏览器 bridge：`window.argus`

运维辅助端点：

- 健康检查：`GET /healthz`
- Prometheus 文本指标：`GET /metrics`

更详细的重构设计见 [`docs/refactor-plan/`](docs/refactor-plan/)。

## 快速开始

1. 准备 MySQL，并创建数据库：

```sql
CREATE DATABASE argus CHARACTER SET utf8mb4;
```

2. 配置环境变量（可复制 `.env.example` 为 `.env`）：

| 变量 | 说明 |
|------|------|
| `MYSQL_HOST` | 默认 `127.0.0.1` |
| `MYSQL_PORT` | 默认 `3306` |
| `MYSQL_USER` | 默认 `root` |
| `MYSQL_PASSWORD` | 默认空 |
| `MYSQL_DATABASE` | 默认 `argus` |
| `PORT` | HTTP/WS 端口，默认 `8080` |
| `HOST` | HTTP/WS 监听地址，默认 `0.0.0.0` |

3. 安装并启动开发环境：

```bash
pnpm install
pnpm dev
```

浏览器打开 **http://127.0.0.1:5173**（Vite）。API 与 WebSocket 由 **8080** 端口的后端提供，Vite 会代理 `/api` 与 `/ws`。

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 同时启动 Node 后端与 Vite 前端 |
| `pnpm build` | 构建前端 `dist/` 与服务端 `dist-server/` |
| `pnpm start` | 运行生产构建入口 `dist-server/src/server/index.js` |
| `pnpm typecheck` | 运行前端、Node、服务端 TypeScript 检查 |
| `pnpm lint` | 运行 ESLint |
| `pnpm test` | 运行 Vitest 契约测试 |
| `pnpm check` | 串行执行 typecheck、lint、test |
| `pnpm db:generate` | 根据 Drizzle schema 生成迁移 |

## API 文档

- HTTP RPC：[`api/openapi.yaml`](api/openapi.yaml)
- WebSocket：[`api/asyncapi.yaml`](api/asyncapi.yaml)
- 共享 TypeScript 契约：[`pkg/public-api`](pkg/public-api)

RPC 响应保持旧版 `{ ok, result/error }` 兼容格式，并新增可选 `requestId`、`code`、`details` 字段，旧客户端可安全忽略。

## 可观测性

服务端新协议层输出 JSON 结构化日志，并为 HTTP 请求注入 `X-Request-Id`。`/metrics` 当前导出进程 uptime、RPC 请求计数与 RPC 总耗时，后续可继续扩展 OKX、LLM、截图和 DB 指标。

## 收盘截图链路

收盘截图由已连接的 Argus 浏览器页或内置无头截图页完成：

1. 服务端通过 `/ws` 推送 `request-chart-capture`。
2. 浏览器内 TradingView Widget 生成截图。
3. 浏览器通过 `/ws` 上报 `chart-capture-result`。
4. 服务端继续执行 LLM Agent 链路。

请保持 Argus 页面打开并已连接；生产环境会尝试启动 Playwright 无头截图页作为默认截图客户端。

## 数据库迁移

修改 Drizzle schema 后：

```bash
pnpm db:generate
```

提交生成的 `drizzle/` SQL 与 meta。应用启动时会自动执行未应用迁移。任何数据库结构变更都必须保持 MySQL 5.7+ 兼容，并在 PR 中说明迁移与回滚影响。

## 部署

本地生产模式：

```bash
pnpm build
pnpm start
```

Docker 镜像使用多阶段构建，运行阶段执行：

```bash
node dist-server/src/server/index.js
```

同一 Node 进程提供静态资源、HTTP RPC 与 WebSocket。

## 故障排查

- **`ws proxy error: connect ECONNREFUSED 127.0.0.1:8080`**：Node 后端未启动，请使用 `pnpm dev`。
- **数据库初始化失败**：检查 MySQL 是否启动、账号权限、`MYSQL_DATABASE` 是否存在。
- **截图超时**：确认浏览器标签页未休眠，或等待无头截图页连接；后端请求会带上目标 `tvSymbol`。
- **LLM 无响应**：检查 API Key、模型配置和网络；服务端结构化日志会包含 `requestId` 与模块名。
