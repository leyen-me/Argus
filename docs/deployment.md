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

## 迁移

应用启动时会执行 `drizzle/` 下未应用的迁移。部署前请确认目标数据库已创建，且账号具备建表/迁移权限。
