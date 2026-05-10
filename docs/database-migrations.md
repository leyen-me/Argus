# 数据库迁移

Argus 使用 Drizzle ORM + MySQL。

## Schema

当前 schema 位于：

```text
src/node/db/schema.ts
```

后续数据层迁移到 `internal/infrastructure/db` 时，需要同步更新 `drizzle.config.ts`。

## 生成迁移

```bash
pnpm db:generate
```

生成内容位于：

```text
drizzle/
```

## 启动时迁移

应用启动会调用数据库初始化逻辑并执行未应用迁移。生产部署前请确保：

- `MYSQL_DATABASE` 已存在。
- 数据库用户具备迁移权限。
- 迁移 SQL 兼容 MySQL 5.7+。

## 变更原则

- 新增字段优先 nullable 或提供默认值。
- 删除字段应分阶段完成，先停止读取/写入，再删除。
- 任何数据迁移都必须在 PR 中说明影响范围和回滚策略。
