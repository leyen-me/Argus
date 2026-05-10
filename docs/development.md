# 开发指南

## 环境要求

- Node.js 20+
- pnpm 10.14+
- MySQL 5.7+

## 常用流程

```bash
pnpm install
pnpm dev
```

开发前建议运行：

```bash
pnpm check
```

`pnpm check` 会执行：

1. TypeScript 类型检查
2. ESLint
3. Vitest 契约测试

## 新增 API 的规则

1. 先在 `pkg/public-api` 增加 method/channel/type。
2. 同步更新 `api/openapi.yaml` 或 `api/asyncapi.yaml`。
3. 在 `tests/contract` 增加契约测试。
4. 在 `internal/app/http` 或 `internal/app/websocket` 增加协议适配。
5. 将业务逻辑放在 `internal/application` 或后续拆分的领域模块中。

## 日志与错误

- 新服务端代码使用 `internal/infrastructure/logging` 的 logger。
- 对外错误使用 `internal/pkg/errors/AppError`。
- HTTP 响应会带 `X-Request-Id`，RPC body 会带 `requestId`。
