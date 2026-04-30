# Argus

Node 后端 + Web 前端：OKX K 线收盘、TradingView 多周期截图、LLM Agent。

## 运行

```bash
pnpm install
pnpm exec playwright install chromium
pnpm dev
```

浏览器打开 **http://127.0.0.1:5173**（Vite）。API 与 WebSocket 由 **8787** 端口的后端提供；`pnpm dev` 已设置 `ARGUS_PUBLIC_URL=http://127.0.0.1:5173`，以便 Playwright 从 Vite 拉取 `/capture` 页面做截图。

### 常见问题

若终端出现 **`ws proxy error: connect ECONNREFUSED 127.0.0.1:8787`**，或页面报错 **`Unexpected end of JSON input`**：说明 **只启动了 Vite，没有启动 Node 后端**。请改用 **`pnpm dev`**（前后端一起），或另开终端执行 **`pnpm run server:dev`**（开发截图时需与 Vite 同源，脚本里已配好 `ARGUS_PUBLIC_URL`）。

若服务端日志出现 **`NODE_MODULE_VERSION`** / **`was compiled against a different Node.js version`**：`better-sqlite3` 原生模块与当前 Node 不匹配（例如升级了 Node 22 → 24）。在本仓库根目录执行 **`pnpm rebuild better-sqlite3`**，或 **`pnpm run rebuild:native`**，然后重新 **`pnpm dev`**。安装依赖时会自动跑一次重建脚本（`postinstall`）。

生产模式：

```bash
pnpm build
pnpm start
```

此时截图默认走 `http://127.0.0.1:${PORT}`（与静态资源同源），无需再设 `ARGUS_PUBLIC_URL`。

## 环境变量（可选）

| 变量 | 说明 |
|------|------|
| `PORT` | HTTP/WS 端口，默认 `8787` |
| `ARGUS_PUBLIC_URL` / `ARGUS_CAPTURE_ORIGIN` | Playwright 打开的前端根 URL（开发一般指向 Vite） |
| `ARGUS_USER_DATA` | 对话 JSON 等用户目录，默认 `%USERPROFILE%\.argus` |

## 从 Electron 迁移说明

若曾为 Electron 编译过 `better-sqlite3`，切换到 Node 后需针对当前 Node 版本重建原生模块（`package.json` 已配置 `postinstall`）。若仍有 ABI 报错，可手动执行：`pnpm rebuild better-sqlite3`。
