# 架构说明

Argus 采用“兼容入口 + 分层内部实现”的渐进式架构。

## 当前分层

```mermaid
flowchart TD
  Renderer[src/renderer React + TradingView] --> PublicAPI[pkg/public-api]
  Renderer --> RPC[POST /api/rpc]
  Renderer <--> WS[/ws WebSocket]
  Entry[src/server/index.ts] --> Bootstrap[internal/app/lifecycle]
  Bootstrap --> HTTP[internal/app/http]
  Bootstrap --> WSServer[internal/app/websocket]
  HTTP --> AppServices[internal/application/services]
  WSServer --> RuntimeBus[src/node/runtime-bus]
  AppServices --> LegacyCore[src/node existing core]
  LegacyCore --> DB[(MySQL + Drizzle)]
  LegacyCore --> OKX[OKX]
  LegacyCore --> LLM[LLM Provider]
```

## 设计原则

- `pkg/public-api` 是公开契约的单一来源。
- `internal/app/http` 和 `internal/app/websocket` 只负责协议适配。
- `internal/application` 负责编排用例，逐步承接 `src/node` 中的业务流程。
- `src/node` 保留为迁移中的领域/基础设施实现，后续按 config、strategy、market、capture、agent、dashboard 继续纵切。
- `src/server/index.ts` 保持薄入口，便于部署脚本兼容。

## 兼容边界

必须保持兼容：

- `POST /api/rpc`
- `/ws`
- `window.argus`
- Drizzle 迁移历史和现有 MySQL 表结构

新增字段必须可选，旧客户端可以忽略。
