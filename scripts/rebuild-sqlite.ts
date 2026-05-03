/**
 * better-sqlite3 绑定当前 Node ABI；切换 Node 大版本后必须重建。
 * pnpm 仓库优先用 `pnpm rebuild`，否则回退 `npm rebuild`。
 */
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");

function tryRebuild(cmd: string, args: readonly string[]) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  return r.status === 0;
}

if (tryRebuild("pnpm", ["rebuild", "better-sqlite3"])) process.exit(0);
if (tryRebuild("npm", ["rebuild", "better-sqlite3"])) process.exit(0);

console.error(
  "[Argus] better-sqlite3 重建失败。请在本目录手动执行：pnpm rebuild better-sqlite3（需与本机 Node 版本一致）",
);
process.exit(1);
