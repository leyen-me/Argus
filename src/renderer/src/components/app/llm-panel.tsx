import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"

export function LlmPanel() {
  return (
    <Card className="bg-background flex min-h-0 min-w-0 flex-[0.75] gap-0 rounded-none border-0 py-0 shadow-none ring-0">
      <CardHeader className="flex h-10 shrink-0 flex-row items-center justify-between gap-0 border-b border-border px-3 py-0">
        <CardTitle className="text-xs leading-none font-semibold tracking-wider text-muted-foreground uppercase">
          LLM 分析
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge
            id="llm-context-usage"
            variant="outline"
            className="panel-badge panel-badge--usage h-7 min-w-11 max-w-[72px] truncate border px-2.5 text-primary tabular-nums"
            title="启用 LLM 后，每次收盘请求会显示估算输入占比。默认按 200K 上下文窗口；可用环境变量 ARGUS_CONTEXT_WINDOW_TOKENS 覆盖。含图时为粗估。"
          >
            —
          </Badge>
          <Badge
            id="llm-status"
            variant="outline"
            className="panel-badge panel-badge--status h-7 min-w-14 max-w-[72px] truncate border border-emerald-500/35 bg-background px-2.5 text-emerald-500"
            title=""
          >
            就绪
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-0 p-0">
        <div
          className="flex shrink-0 items-start gap-2 border-b border-border bg-muted/25 px-3 py-2 text-xs leading-snug text-foreground"
          id="okx-position-bar"
          hidden
          role="status"
          aria-live="polite"
          title="OKX 永续持仓、普通挂单与算法单（止盈止损等，收盘推送或刷新）；须启用永续并配置 API。"
        >
          <span className="shrink-0 text-[11px] font-semibold tracking-wide text-primary uppercase">
            OKX 持仓
          </span>
          <div className="min-w-0 flex-1">
            <span className="block wrap-break-word" id="okx-position-text">
              —
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 shrink-0 px-2.5 text-[11px] shadow-none"
            id="okx-position-refresh"
            title="重新查询"
          >
            刷新
          </Button>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="shrink-0 px-3.5 pt-3">
            <div
              className="llm-current-system border-b border-border pb-3"
              id="llm-current-system"
              aria-label="当前图表品种对应的系统提示词"
            />
          </div>
          <ScrollArea className="min-h-0 min-w-0 flex-1 px-3.5 pb-3">
            <div
              className="llm-chat-history flex min-h-0 flex-col gap-0"
              id="llm-chat-history"
              hidden
              aria-label="各次 K 线收盘与 LLM 回复"
            />
          </ScrollArea>
        </div>
      </CardContent>
    </Card>
  )
}
