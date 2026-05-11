# 部署指南

## 构建

```bash
pnpm build
```

构建产物：

- `dist/`：Vite 前端静态资源
- `dist-server/`：Node 服务端输出

服务端入口：

```bash
node dist-server/src/server/index.js
```

也可以使用：

```bash
pnpm start
```

## Docker

Dockerfile 使用多阶段构建：

1. 安装依赖
2. 构建前端与服务端
3. 安装生产依赖和 Playwright Chromium
4. 运行 `node dist-server/src/server/index.js`

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HOST` | `0.0.0.0` | 服务监听地址 |
| `PORT` | `8080` | HTTP/WS 端口 |
| `MYSQL_HOST` | `127.0.0.1` | MySQL 地址 |
| `MYSQL_PORT` | `3306` | MySQL 端口 |
| `MYSQL_USER` | `root` | MySQL 用户 |
| `MYSQL_PASSWORD` | 空 | MySQL 密码 |
| `MYSQL_DATABASE` | `argus` | 数据库名 |
| `ARGUS_PUBLIC_PASSWORD` | 空 | 公网访问密码；为空时不启用限制。配置后，内网/localhost 仍可直接访问，公网访问需输入密码 |
| `ARGUS_TRUST_PROXY` | `false` | 是否信任反向代理转发的客户端 IP。仅当 Nginx/Caddy 等可信代理正确设置 `X-Forwarded-For` 时开启 |

## 公网域名访问保护

如果容器绑定公网域名，建议配置：

```bash
ARGUS_PUBLIC_PASSWORD=替换为强密码
```

开启后访问规则为：

- 来自 `127.0.0.1`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16` 等内网地址的请求不受限制。
- 其它公网来源首次打开页面会看到密码页；密码正确后，浏览器会把访问 token 缓存在 localStorage 中。
- `/api/rpc`、`/metrics` 和 `/ws` 会使用同一套公网 token 校验；内网访问保持原样。

如果前面有反向代理，并且应用看到的远端地址总是代理 IP，可在确认代理可信后开启：

```bash
ARGUS_TRUST_PROXY=true
```

反向代理必须保留 WebSocket Upgrade，否则页面和截图回传会断开。Nginx 示例：

```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 120s;
}
```

截图注意事项：

- 无头截图页默认访问容器内的 `http://127.0.0.1:${PORT}/?argus_headless=1&argus_client_role=headless_capture`，仍被视为内网访问，不需要输入密码。
- 不要把 `HEADLESS_CAPTURE_URL` 改成公网域名，除非确认公网认证 token 和 WebSocket 都同步配置好了。
- CSP 暂时保留 TradingView 所需来源，避免影响图表加载和截图。

## 迁移

应用启动时会执行 `drizzle/` 下未应用的迁移。部署前请确认目标数据库已创建，且账号具备建表/迁移权限。
