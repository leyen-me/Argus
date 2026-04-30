# Argus

Node 后端 + Web 前端：OKX K 线收盘、TradingView 多周期截图、LLM Agent。

## 运行

```bash
pnpm install
pnpm dev
```

浏览器打开 **http://127.0.0.1:5173**（Vite）。API 与 WebSocket 由 **8787** 端口的后端提供。

**收盘截图**：由「当前打开的 Argus 网页」内的 **TradingView Widget**（`imageCanvas` / 四宫格拼图）完成，结果经 WebSocket 回传服务端。**请保持该标签页打开并已连接**（即正常使用 `pnpm dev` 打开的界面）；服务端推送 `request-chart-capture` 后由页面截图并上报。

### 常见问题

若终端出现 **`ws proxy error: connect ECONNREFUSED 127.0.0.1:8787`**，或 RPC 报错：**说明未启动 Node 后端**。请使用 **`pnpm dev`**（前后端一起），或另开终端 **`pnpm run server:dev`**。

若服务端日志出现 **`NODE_MODULE_VERSION`**：`better-sqlite3` 与当前 Node 不匹配。执行 **`pnpm rebuild better-sqlite3`** 或 **`pnpm run rebuild:native`** 后重启。

若截图超时：确认浏览器里 Argus 页面未休眠断连，且后端订阅的品种与图表一致（收盘请求会带上 `tvSymbol`，前端会先 `setMarketContext` 再截图）。

生产模式：

```bash
pnpm build
pnpm start
```

同一端口提供静态资源 + API + WebSocket。

## 环境变量（可选）

| 变量 | 说明 |
|------|------|
| `PORT` | HTTP/WS 端口，默认 `8787` |
| `ARGUS_USER_DATA` | 对话 JSON 等用户目录，默认 `%USERPROFILE%\.argus` |

## 从 Electron 迁移说明

若曾为 Electron 编译过 `better-sqlite3`，切换到 Node 后需针对当前 Node 重建原生模块（`postinstall`）。若仍有 ABI 报错：`pnpm rebuild better-sqlite3`。
