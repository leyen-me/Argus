import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { ConfigHelpTooltip } from "./config-help-tooltip";

const nativeSelectClass = cn(
  "flex h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm shadow-sm outline-none",
  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30",
);

export function ConfigModalStrategySection() {
  return (
    <div className="space-y-3 pt-1">
      <div className="flex items-center gap-2">
        <p className="m-0 text-xs text-muted-foreground">
          从本地库已入库的策略中选择当前使用的系统提示词（在顶部「策略中心」编辑正文）。
        </p>
        <ConfigHelpTooltip>
          <div className="space-y-2">
            <p className="m-0">
              策略正文保存在 SQLite 表 <code className="rounded bg-muted px-1 text-[11px]">prompt_strategies</code>
              ；此处仅选择 <code className="rounded bg-muted px-1 text-[11px]">promptStrategy</code> id。
            </p>
            <p className="m-0">
              可用「同步内置」将仓库自带的 <code className="rounded bg-muted px-1 text-[11px]">src/prompts</code>{" "}
              模板写入或覆盖同名策略正文。
            </p>
          </div>
        </ConfigHelpTooltip>
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:gap-4">
        <Label htmlFor="config-prompt-strategy" className="shrink-0 text-muted-foreground">
          当前策略
        </Label>
        <select
          id="config-prompt-strategy"
          className={cn("symbol-select config-interval-select min-w-[160px] flex-1", nativeSelectClass)}
          title="策略列表来自本地库，编辑请打开「策略中心」"
        />
      </div>
    </div>
  );
}
