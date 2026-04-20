import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const nativeSelectClass = cn(
  "flex h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm shadow-sm outline-none",
  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30",
);

export function ConfigModalSymbolsAndInterval() {
  return (
    <div className="space-y-4 pt-1">
      <div className="config-table-head">
        <span>展示名称</span>
        <span>TradingView 代码</span>
        <span className="config-col-actions" />
      </div>
      <div className="config-rows" id="config-rows" />
      <button type="button" className="btn-add-row" id="btn-config-add">
        + 添加品种
      </button>
      <div className="config-default-row flex flex-wrap items-center gap-3 sm:gap-4">
        <Label htmlFor="config-default-symbol" className="shrink-0 text-muted-foreground">
          默认打开
        </Label>
        <select
          id="config-default-symbol"
          className={cn("symbol-select config-default-select", nativeSelectClass)}
        />
      </div>
      <div className="config-interval-row flex flex-wrap items-center gap-3 sm:gap-4">
        <Label htmlFor="config-interval" className="shrink-0 text-muted-foreground">
          K 线周期
        </Label>
        <select
          id="config-interval"
          className={cn("symbol-select config-interval-select", nativeSelectClass)}
          title="与 TradingView、OKX WS 共用"
        >
          <option value="1">1 分钟</option>
          <option value="3">3 分钟</option>
          <option value="5">5 分钟</option>
          <option value="15">15 分钟</option>
          <option value="30">30 分钟</option>
          <option value="60">1 小时</option>
          <option value="120">2 小时</option>
          <option value="240">4 小时</option>
          <option value="D">日线</option>
          <option value="1D">1D</option>
        </select>
      </div>
    </div>
  );
}
