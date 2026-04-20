用户运行时配置：SQLite 仓库根目录 `argus.sqlite`（与 `src` 同级，kv `app/settings`）；默认种子：`src/node/app-config.js` 中 `APP_SETTINGS_SEED`；系统提示词内置种子见 `src/node/builtin-prompts.js`，运行时存表 `prompt_strategies`。
使用pnpm作为包管理