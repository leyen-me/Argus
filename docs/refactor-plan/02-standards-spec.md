# 02. 工程规范细则

## 目标

本规范用于约束后续重构中的代码风格、注释、错误处理、API envelope、日志、测试与静态检查。目标不是一次性追求“完美”，而是让每个模块在迁移后具备一致的可读性、可测试性和可维护性。

## TypeScript 代码规范

### 命名

- 文件名使用 `kebab-case.ts` / `kebab-case.tsx`，React 组件文件可沿用现有目录风格，但新增文件保持一致。
- 类型、接口、React 组件使用 `PascalCase`。
- 函数、变量、方法使用 `camelCase`。
- 常量使用 `UPPER_SNAKE_CASE`，仅限真正的不可变配置常量；领域枚举值使用字符串字面量联合类型。
- RPC method 和 WS channel 继续使用现有 `domain:action` / `kebab-case` 字符串，作为公开契约集中定义在 `pkg/public-api`。

### 模块边界

- 禁止 UI 直接导入 `internal/*`。
- 禁止 `internal/domain` 读取环境变量、访问数据库、发 HTTP 请求或写日志。
- 需要 IO 的能力通过 application port 注入，由 infrastructure 实现。
- 新增跨模块类型时先判断是否属于公开契约：
  - 前后端共同依赖、外部可见：放入 `pkg/public-api`。
  - 仅内部领域规则：放入 `internal/domain/<domain>`。
  - 仅基础设施实现细节：放入 `internal/infrastructure/<adapter>`。

### 类型与校验

- 新迁移模块默认启用严格类型风格：避免隐式 `any`，对 `unknown` 先校验再使用。
- 外部输入边界必须显式校验：HTTP body、WS message、环境变量、第三方 API 响应、数据库 JSON 字段。
- 兼容当前依赖的前提下，建议在执行阶段评估引入 `zod` 或同类 schema 校验库；如不引入依赖，则在 `internal/pkg/validation` 建立轻量类型守卫。
- 不在领域层使用可空值表达多状态；优先使用 discriminated union：

```ts
type CaptureResult =
  | { status: "ok"; image: ChartImage }
  | { status: "timeout"; requestId: string }
  | { status: "failed"; requestId: string; error: AppError };
```

### 注释与文档

- 导出的函数、类型、类必须有 JSDoc，说明“做什么”和“契约约束”，避免重复描述实现细节。
- 复杂业务规则必须在规则入口处注释原因，例如：
  - K 线收盘任务为什么必须串行。
  - 截图请求为什么要区分 `interactive` 与 `headless_capture`。
  - 策略执行态与 Dashboard 统计区间为什么相互独立。
- 私有小函数只有在意图不明显时添加注释。
- 注释语言以中文为主；公开 API 字段说明可中英双语，便于未来生成文档。

## 错误处理规范

### 错误模型

建立统一 `AppError`：

```ts
type AppErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_FAILED"
  | "UPSTREAM_UNAVAILABLE"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "DATABASE_ERROR"
  | "INTERNAL";

type AppError = {
  code: AppErrorCode;
  message: string;
  details?: unknown;
  cause?: unknown;
  retryable?: boolean;
};
```

### 使用规则

- application/domain 返回可识别错误，不直接拼 HTTP 状态码。
- HTTP 层负责将 `AppErrorCode` 映射为状态码和响应 envelope。
- WS 入站消息解析失败记录 debug/warn 日志，不抛出导致连接崩溃。
- 对外错误消息不泄漏密钥、完整上游响应、数据库连接串或堆栈。
- 内部日志可以记录 `cause`、`requestId`、模块名和必要上下文。
- 对第三方调用（OKX、LLM、SMTP、Playwright）统一标记 `retryable`，便于上层决定重试和用户提示。

## API 响应规范

保持当前 RPC 兼容格式，同时扩展可选字段：

```json
{
  "ok": true,
  "result": {},
  "requestId": "req_..."
}
```

```json
{
  "ok": false,
  "error": "用户可读错误",
  "code": "VALIDATION_FAILED",
  "details": {},
  "requestId": "req_..."
}
```

规则：

- `ok`、`result`、`error` 保持兼容。
- 新增 `code`、`details`、`requestId` 为可选字段，老客户端可忽略。
- 分页统一使用 cursor 优先：

```ts
type PageRequest = {
  cursor?: string;
  limit?: number;
  filters?: Record<string, unknown>;
  sort?: Array<{ field: string; direction: "asc" | "desc" }>;
};

type PageResult<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};
```

## 日志规范

### 日志字段

统一结构化日志字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `ts` | 是 | ISO 时间或 logger 自动时间 |
| `level` | 是 | `debug`/`info`/`warn`/`error` |
| `module` | 是 | 模块名，如 `http.rpc`、`market.scheduler` |
| `requestId` | HTTP/WS 请求必填 | 请求链路标识 |
| `operation` | 建议 | 操作名，如 `config.save` |
| `userVisible` | 否 | 是否已反馈给用户 |
| `durationMs` | IO 操作建议 | 耗时 |
| `error.code` | 错误时必填 | `AppErrorCode` |
| `error.message` | 错误时必填 | 安全错误消息 |

### 日志级别

- `debug`：开发排障细节，如上游原始状态摘要。
- `info`：进程启动、关停、任务开始/完成、重要状态切换。
- `warn`：可恢复异常、降级、重试、客户端消息格式错误。
- `error`：请求失败、后台任务最终失败、数据库/上游不可用。

执行阶段建议引入 `pino` 或同类结构化日志库；如果不新增依赖，先实现 `internal/infrastructure/logging/logger.ts` 作为 console 适配器，输出 JSON。

## 指标命名规范

采用 Prometheus 风格：

- Counter：`argus_rpc_requests_total`、`argus_ws_messages_total`、`argus_agent_turns_total`
- Histogram：`argus_rpc_duration_seconds`、`argus_llm_request_duration_seconds`、`argus_chart_capture_duration_seconds`
- Gauge：`argus_ws_clients`、`argus_capture_clients`、`argus_scheduler_running`

标签控制基数：

- 允许：`method`、`channel`、`status`、`module`、`role`、`retryable`
- 禁止：`barCloseId`、完整 `tvSymbol`、错误消息、用户输入文本、request body

## 测试规范

重构执行前先建立安全网：

1. **契约测试**：覆盖 `/api/rpc` 成功/失败 envelope、所有现有 method 名称、`/ws` channel envelope。
2. **单元测试**：覆盖纯函数、领域规则、prompt/Markdown 格式化、分页参数解析。
3. **集成测试**：覆盖 Drizzle repository、迁移路径、配置保存和策略 CRUD；数据库可使用测试 MySQL 容器或专用测试库。
4. **前端测试**：覆盖 bridge RPC 错误处理、WS 重连、关键组件的状态转换。
5. **端到端冒烟**：覆盖启动服务、打开页面、bridge 能访问 `/api/rpc`、WS 能连接。

建议执行阶段引入：

- `vitest`：TypeScript 单元与契约测试。
- `@testing-library/react`：React 组件测试。
- `supertest`：Express HTTP 契约测试。
- `playwright`：保留为运行时截图依赖；如用于 e2e，应分离测试脚本与运行时服务。

## 静态检查与格式化

当前已有 `eslint.config.mjs`、`pnpm lint`、`pnpm typecheck`。建议执行阶段演进为：

```json
{
  "scripts": {
    "format": "prettier . --write",
    "format:check": "prettier . --check",
    "test": "vitest run",
    "test:watch": "vitest",
    "check": "pnpm typecheck && pnpm lint && pnpm test"
  }
}
```

ESLint 建议逐步收紧：

- 新目录 `internal/**` 禁止隐式 `any`。
- 禁止跨层导入，例如 renderer 导入 internal。
- 禁止直接 `console.*`，基础设施 logger 适配层除外。
- 对 `@typescript-eslint/ban-ts-comment` 保持必须写说明。

格式化建议：

- 引入 Prettier，减少代码风格争论。
- Markdown/YAML/JSON 同步纳入 format check。
- 对迁移 SQL 不自动格式化，避免 Drizzle 生成物产生无意义 diff。

## 安全与配置规范

- `.env` 不提交；`.env.example` 只保留无密钥默认值。
- 日志与错误响应必须脱敏：API Key、SMTP 密码、数据库密码、完整 Authorization header。
- 配置读取集中在 infrastructure config 模块，业务代码不直接读 `process.env`。
- 对 OpenAI/OKX/SMTP 等外部调用设置超时、重试上限和可观测字段。
- 浏览器 CSP 变更必须随 API 文档或部署文档更新。

## Definition of Done

每个重构提交至少满足：

- 不破坏 `pnpm typecheck`、`pnpm lint`。
- 涉及行为变更时有对应测试或明确的契约测试覆盖。
- 对外 RPC/WS/bridge 契约保持兼容，或在 API 文档中明确新增可选字段。
- 新增模块遵守依赖规则。
- 新增关键路径日志包含 `module` 和 `requestId`。
- README 或 docs 中记录新的运行/部署/迁移方式。
