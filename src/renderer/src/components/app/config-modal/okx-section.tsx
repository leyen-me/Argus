import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { ConfigHelpTooltip } from "./config-help-tooltip";

const nativeSelectClass = cn(
  "flex h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm shadow-sm outline-none",
  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30",
);

export function ConfigModalOkxSection() {
  return (
    <div className="space-y-4 pt-1">
      <div className="flex items-center gap-2">
        <p className="m-0 text-xs text-muted-foreground">仅 OKX 品种：状态机联动永续市价单（默认关闭）。</p>
        <ConfigHelpTooltip>
          <div className="space-y-2">
            <p className="m-0">
              仅在 <code>OKX:*</code> 上生效：进入持仓、冷静期、止损/止盈硬触发时向 OKX 下对应{" "}
              <code>BTC-USDT-SWAP</code> 等永续市价单。
            </p>
            <p className="m-0">
              默认用 USDT 可用权益的 <strong>25%</strong> 作保证金；名义 ≈ 保证金 × 杠杆。模拟盘请用模拟 API 并勾选「模拟交易」。
            </p>
            <p className="m-0">
              <strong>默认关闭真实下单</strong>，避免误操作。
            </p>
          </div>
        </ConfigHelpTooltip>
      </div>
      <div className="flex flex-col gap-3 rounded-lg border border-border/80 bg-muted/20 px-3 py-2.5 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex items-center gap-2">
          <input type="checkbox" id="config-okx-swap-enabled" className="size-4 accent-primary" title="okxSwapTradingEnabled" />
          <Label htmlFor="config-okx-swap-enabled" className="cursor-pointer font-normal">
            启用永续下单
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <input type="checkbox" id="config-okx-simulated" className="size-4 accent-primary" title="okxSimulated" />
          <Label htmlFor="config-okx-simulated" className="cursor-pointer font-normal">
            模拟交易（x-simulated-trading）
          </Label>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(88px,auto)_1fr] sm:items-center sm:gap-x-4">
        <Label htmlFor="config-okx-api-key" className="text-muted-foreground sm:pt-0.5">
          API Key
        </Label>
        <Input
          type="password"
          id="config-okx-api-key"
          className="config-in config-openai-input h-8"
          placeholder="OKX API Key"
          spellCheck={false}
          autoComplete="new-password"
        />
        <Label htmlFor="config-okx-secret-key" className="text-muted-foreground sm:pt-0.5">
          Secret
        </Label>
        <Input
          type="password"
          id="config-okx-secret-key"
          className="config-in config-openai-input h-8"
          placeholder="OKX Secret Key"
          spellCheck={false}
          autoComplete="new-password"
        />
        <Label htmlFor="config-okx-passphrase" className="text-muted-foreground sm:pt-0.5">
          Passphrase
        </Label>
        <Input
          type="password"
          id="config-okx-passphrase"
          className="config-in config-openai-input h-8"
          placeholder="创建 API 时设置的口令"
          spellCheck={false}
          autoComplete="new-password"
        />
        <Label htmlFor="config-okx-leverage" className="text-muted-foreground sm:pt-0.5">
          杠杆
        </Label>
        <Input
          type="number"
          id="config-okx-leverage"
          className="config-in config-openai-input h-8"
          min={1}
          max={125}
          step={1}
          title="okxSwapLeverage"
        />
        <Label htmlFor="config-okx-margin-fraction" className="text-muted-foreground sm:pt-0.5">
          保证金占比
        </Label>
        <Input
          type="number"
          id="config-okx-margin-fraction"
          className="config-in config-openai-input h-8"
          min={0.01}
          max={1}
          step={0.01}
          title="okxSwapMarginFraction，默认 0.25"
        />
        <Label htmlFor="config-okx-td-mode" className="text-muted-foreground sm:pt-0.5">
          保证金模式
        </Label>
        <select id="config-okx-td-mode" className={cn("symbol-select config-interval-select", nativeSelectClass)} title="okxTdMode">
          <option value="isolated">逐仓 isolated（默认）</option>
          <option value="cross">全仓 cross</option>
        </select>
      </div>
    </div>
  );
}
