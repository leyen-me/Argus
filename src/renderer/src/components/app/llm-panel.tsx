import { useCallback, useEffect, useState } from "react"
import { PauseCircle, PlayCircle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
export function LlmPanel() {
  const [barCloseAgentAuto, setBarCloseAgentAuto] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const cfg = await window.argus?.getConfig?.()
        if (cancelled || !cfg || typeof cfg !== "object") return
        setBarCloseAgentAuto(
          (cfg as { barCloseAgentAutoEnabled?: boolean }).barCloseAgentAutoEnabled !== false,
        )
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const toggleBarCloseAgent = useCallback(async () => {
    const next = !barCloseAgentAuto
    setBarCloseAgentAuto(next)
    try {
      await window.argus?.saveConfig?.({ barCloseAgentAutoEnabled: next })
    } catch {
      setBarCloseAgentAuto(!next)
    }
  }, [barCloseAgentAuto])

  return (
    <Card className="bg-background flex min-h-0 min-w-0 flex-[0.75] gap-0 rounded-none border-0 py-0 shadow-none ring-0">
      <CardContent className="flex min-h-0 flex-1 flex-col gap-0 p-0">
        <div className="flex h-10 shrink-0 items-center border-b border-border/60 px-3 py-0">
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <span className="shrink-0 text-[11px] leading-none font-medium text-muted-foreground">Argus</span>
            <div className="flex min-w-0 shrink items-center gap-2">
              <Button
                type="button"
                variant={barCloseAgentAuto ? "default" : "secondary"}
                size="sm"
                className={
                  barCloseAgentAuto
                    ? "h-7 gap-1.5 bg-emerald-600 px-3 text-[11px] text-white shadow-none hover:bg-emerald-600/90 dark:bg-emerald-500 dark:hover:bg-emerald-500/90"
                    : "h-7 gap-1.5 border-border/80 bg-muted/40 px-3 text-[11px] text-muted-foreground shadow-none hover:bg-muted/70"
                }
                id="btn-bar-close-agent-toggle"
                title="开启后，须在已配 LLM Key、截图成功、OKX 账户/仓位/挂单快照就绪时，K 线收盘才会自动调用 Agent"
                aria-pressed={barCloseAgentAuto}
                onClick={() => void toggleBarCloseAgent()}
              >
                {barCloseAgentAuto ? <PlayCircle className="size-3.5" aria-hidden /> : <PauseCircle className="size-3.5" aria-hidden />}
                {barCloseAgentAuto ? "运行中" : "已暂停"}
              </Button>
              <Badge
                id="llm-status"
                variant="outline"
                className="panel-badge panel-badge--status h-7 min-w-14 max-w-[84px] shrink-0 truncate rounded-lg border border-emerald-500/35 bg-emerald-500/8 px-2.5 text-emerald-500 shadow-sm"
                title=""
              >
                就绪
              </Badge>
            </div>
          </div>
        </div>
        <div
          className="shrink-0 px-3 pt-3"
          id="okx-position-bar"
          hidden
          role="status"
          aria-live="polite"
          title="OKX 永续持仓、普通挂单与算法单（止盈止损等，收盘推送或刷新）；须启用永续并配置 API。"
        >
          <div className="flex items-start gap-3 rounded-lg border border-border/80 bg-muted/20 px-3 py-3 text-xs text-foreground shadow-sm">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
              <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-primary uppercase">
                  OKX 持仓
                </span>
                {/* <span className="text-[11px] leading-none text-muted-foreground">永续、挂单、算法单</span> */}
              </div>
              <span
                className="mt-2 block wrap-break-word text-[13px] leading-5 text-foreground"
                id="okx-position-text"
              >
                —
              </span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 border-border/80 bg-background/80 px-3 text-[11px] shadow-none"
              id="okx-position-refresh"
              title="重新查询"
            >
              刷新
            </Button>
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <ScrollArea className="min-h-0 min-w-0 flex-1 px-3.5 pt-3 pb-4">
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
