import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfigHelpTooltip } from "./config-help-tooltip";

export function ConfigModalLlmSection() {
  return (
    <div className="space-y-4 pt-1">
      <div className="flex items-center gap-2">
        <p className="m-0 text-xs text-muted-foreground">OpenAI 兼容 API；未填 Key 时可读环境变量 OPENAI_API_KEY。</p>
        <ConfigHelpTooltip>
          <p className="m-0">
            API Key 保存在本机用户目录配置文件；<strong>配置优先于</strong>环境变量{" "}
            <code>OPENAI_API_KEY</code>。填写后即可启用分析。
          </p>
        </ConfigHelpTooltip>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(88px,auto)_1fr] sm:items-center sm:gap-x-4">
        <Label htmlFor="config-openai-api-key" className="text-muted-foreground sm:pt-0.5">
          API Key
        </Label>
        <Input
          type="password"
          id="config-openai-api-key"
          className="config-in config-openai-input h-8"
          placeholder="sk-… 或兼容服务的密钥"
          spellCheck={false}
          autoComplete="new-password"
        />
        <Label htmlFor="config-openai-base-url" className="text-muted-foreground sm:pt-0.5">
          API 根 URL
        </Label>
        <Input
          type="text"
          id="config-openai-base-url"
          className="config-in config-openai-input h-8"
          placeholder="https://api.openai.com/v1"
          spellCheck={false}
          autoComplete="off"
        />
        <Label htmlFor="config-openai-model" className="text-muted-foreground sm:pt-0.5">
          模型
        </Label>
        <Input
          type="text"
          id="config-openai-model"
          className="config-in config-openai-input h-8"
          placeholder="gpt-4o-mini"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border/80 bg-muted/20 px-3 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <input
            type="checkbox"
            id="config-llm-reasoning"
            className="size-4 shrink-0 rounded border-input accent-primary"
            title="OpenRouter 发 reasoning.enabled；通义等发 enable_thinking，并流式展示思考；默认关闭"
          />
          <Label htmlFor="config-llm-reasoning" className="cursor-pointer font-normal">
            深度思考 reasoning
          </Label>
          <ConfigHelpTooltip>
            <div className="space-y-2">
              <p className="m-0">
                <a href="https://openrouter.ai/docs" target="_blank" rel="noreferrer">
                  OpenRouter
                </a>{" "}
                使用 <code>{`reasoning: { "enabled": true }`}</code>；其它兼容端点（如阿里云通义）使用{" "}
                <code>enable_thinking: true</code>。
              </p>
              <p className="m-0">仅部分模型支持；不支持时可能被忽略或报错。</p>
            </div>
          </ConfigHelpTooltip>
        </div>
      </div>
    </div>
  );
}
