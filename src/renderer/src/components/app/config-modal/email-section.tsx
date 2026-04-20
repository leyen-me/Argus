import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfigHelpTooltip } from "./config-help-tooltip";

export function ConfigModalEmailSection() {
  return (
    <div className="space-y-4 pt-1">
      <div className="flex items-center gap-2">
        <p className="m-0 text-xs text-muted-foreground">模拟仓位开平仓或触发止损/止盈时发邮件（QQ SMTP）。</p>
        <ConfigHelpTooltip>
          <div className="space-y-2">
            <p className="m-0">
              需在{" "}
              <a
                href="https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/authorizationCode"
                target="_blank"
                rel="noreferrer"
              >
                QQ 邮箱
              </a>{" "}
              开启 SMTP，使用<strong>授权码</strong>作密码（非 QQ 登录密码）。
            </p>
            <p className="m-0">
              也可用环境变量 <code>ARGUS_SMTP_USER</code>、<code>ARGUS_SMTP_PASS</code>；收件人可用{" "}
              <code>ARGUS_NOTIFY_EMAIL_TO</code>。
            </p>
          </div>
        </ConfigHelpTooltip>
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border/80 bg-muted/20 px-3 py-2.5">
        <input
          type="checkbox"
          id="config-trade-notify-email"
          className="size-4 shrink-0 rounded border-input accent-primary"
          title="写入应用设置的 tradeNotifyEmailEnabled（SQLite）"
        />
        <Label htmlFor="config-trade-notify-email" className="cursor-pointer font-normal">
          启用仓位邮件
        </Label>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(88px,auto)_1fr] sm:items-center sm:gap-x-4">
        <Label htmlFor="config-smtp-user" className="text-muted-foreground sm:pt-0.5">
          发件邮箱
        </Label>
        <Input
          type="text"
          id="config-smtp-user"
          className="config-in config-openai-input h-8"
          placeholder="123456789@qq.com"
          spellCheck={false}
          autoComplete="off"
        />
        <Label htmlFor="config-smtp-pass" className="text-muted-foreground sm:pt-0.5">
          SMTP 授权码
        </Label>
        <Input
          type="password"
          id="config-smtp-pass"
          className="config-in config-openai-input h-8"
          placeholder="在 QQ 邮箱设置中生成"
          spellCheck={false}
          autoComplete="new-password"
        />
        <Label htmlFor="config-notify-email-to" className="text-muted-foreground sm:pt-0.5">
          收件人
        </Label>
        <Input
          type="text"
          id="config-notify-email-to"
          className="config-in config-openai-input h-8"
          placeholder="默认同发件邮箱"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </div>
  );
}
