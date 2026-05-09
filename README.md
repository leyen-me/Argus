# Argus

Node 后端 + Web 前端：OKX K 线收盘、TradingView 多周期截图、LLM Agent。

持久化使用 **MySQL 5.7+**（默认库名 `argus`）。首次启动会自动执行 `drizzle` 迁移建表；不迁移旧版 `argus.sqlite` 数据。

## 运行

1. 准备 MySQL，并创建数据库（例如 `CREATE DATABASE argus CHARACTER SET utf8mb4;`）。
2. 配置环境变量（可复制 `.env.example` 为 `.env`）：

| 变量 | 说明 |
|------|------|
| `MYSQL_HOST` | 默认 `127.0.0.1` |
| `MYSQL_PORT` | 默认 `3306` |
| `MYSQL_USER` | 默认 `root` |
| `MYSQL_PASSWORD` | 默认空 |
| `MYSQL_DATABASE` | 默认 `argus` |

3. 启动：

```bash
pnpm install
pnpm dev
```

浏览器打开 **http://127.0.0.1:5173**（Vite）。API 与 WebSocket 由 **8787** 端口的后端提供。

**收盘截图**：由「当前打开的 Argus 网页」内的 **TradingView Widget**（`imageCanvas` / 四宫格拼图）完成，结果经 WebSocket 回传服务端。**请保持该标签页打开并已连接**（即正常使用 `pnpm dev` 打开的界面）；服务端推送 `request-chart-capture` 后由页面截图并上报。

### 常见问题

若终端出现 **`ws proxy error: connect ECONNREFUSED 127.0.0.1:8787`**，或 RPC 报错：**说明未启动 Node 后端**。请使用 **`pnpm dev`**（前后端一起），或另开终端 **`pnpm run server:dev`**。

若启动报 **数据库初始化失败**：检查 MySQL 是否已启动、账号能否登录、`MYSQL_DATABASE` 是否已创建，以及用户是否有建表权限（首次启动会执行迁移 SQL）。

若截图超时：确认浏览器里 Argus 页面未休眠断连，且后端订阅的品种与图表一致（收盘请求会带上 `tvSymbol`，前端会先 `setMarketContext` 再截图）。

生产模式：

```bash
pnpm build
pnpm start
```

同一进程提供静态资源 + API + WebSocket。

## 环境变量（可选）

| 变量 | 说明 |
|------|------|
| `PORT` | HTTP/WS 端口，默认 `8787` |
| `ARGUS_USER_DATA` | 对话 JSON 等用户目录，默认 `%USERPROFILE%\.argus` |
| `MYSQL_*` | 见上文数据库配置 |

## 数据库迁移（开发）

修改 [`src/node/db/schema.ts`](src/node/db/schema.ts) 后：

```bash
pnpm run db:generate
```

提交生成的 `drizzle/` SQL 与 `meta`；应用启动时会自动执行未应用的迁移。
