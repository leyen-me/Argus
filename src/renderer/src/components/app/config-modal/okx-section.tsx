import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfigHelpTooltip } from "./config-help-tooltip";

export function ConfigModalOkxSection() {
  return (
    <div className="space-y-4 pt-1">
      <div className="flex items-center gap-2">
        <p className="m-0 text-xs text-muted-foreground">仅 OKX 品种：K 线收盘后 LLM Agent 可调用工具对永续下单（默认关闭）。</p>
        <ConfigHelpTooltip>
          <div className="space-y-2">
            <p className="m-0">
              仅在 <code>OKX:*</code> 上生效：启用后，模型通过工具对 <code>BTC-USDT-SWAP</code> 等合约开仓、平仓、改单、撤单。
            </p>
            <p className="m-0">
              开仓时由模型在 <code>open_position</code> 中传入杠杆、保证金占比与逐仓/全仓。模拟盘请用模拟 API 并勾选「模拟交易」。
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
      </div>
    </div>
  );
}
