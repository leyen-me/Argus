# 测试指南

## 测试类型

当前已建立最小安全网：

- `tests/contract/rpc-router.test.ts`：锁定 `/api/rpc` envelope、requestId 和 method 注册。
- `tests/contract/ws-contract.test.ts`：锁定已上线 WS channel 与截图目标角色解析。

## 运行

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

或：

```bash
pnpm check
```

## 后续补强方向

- 为 config、strategy、dashboard repository 增加 MySQL 集成测试。
- 为 market scheduler、capture service、bar close agent 增加领域单元测试。
- 为 `window.argus` bridge 增加浏览器侧错误处理测试。
- 为 Docker 构建增加冒烟验证。
