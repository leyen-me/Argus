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
        <p className="m-0 text-xs text-muted-foreground">选择 <code className="rounded bg-muted px-1 text-[11px]">prompts</code>{" "}下的策略文件夹。</p>
        <ConfigHelpTooltip>
          <div className="space-y-2">
            <p className="m-0">
              每种策略对应 <code>{`src/prompts/<策略名>/system-crypto.txt`}</code>；保存后写入{" "}
              <code>config.json</code> 的 <code>promptStrategy</code>。
            </p>
            <p className="m-0">
              与行情一致：仅 <code>BINANCE:</code> / <code>OKX:</code> 或品种行 <code>feed: crypto</code>。改
              txt 后保存配置或重启应用加载最新内容。
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
          title="每种策略对应 src/prompts 下的一个子文件夹"
        />
      </div>
    </div>
  );
}
