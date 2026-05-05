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
    <Card className="bg-background flex min-h-0 min-w-0 flex-1 gap-0 rounded-none border-0 py-0 shadow-none ring-0">
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
                title="全局总开关：关闭后，即使策略为「运行中」也不会在 K 线收盘自动调用 Agent"
                aria-pressed={barCloseAgentAuto}
                onClick={() => void toggleBarCloseAgent()}
              >
                {barCloseAgentAuto ? <PlayCircle className="size-3.5" aria-hidden /> : <PauseCircle className="size-3.5" aria-hidden />}
                {barCloseAgentAuto ? "全局开启" : "全局关闭"}
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
          <div
            className="rounded-2xl border border-border/80 bg-card px-4 py-4 text-xs text-foreground shadow-md"
            id="okx-position-shell"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center rounded-full border border-primary/20 bg-primary/8 px-2.5 py-1 text-[10px] font-semibold tracking-[0.16em] text-primary uppercase">
                    OKX 持仓
                  </span>
                  <span
                    className="inline-flex items-center rounded-full border border-border/70 bg-muted/40 px-2 py-1 text-[11px] font-medium text-muted-foreground"
                    id="okx-position-mode"
                  >
                    —
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="truncate text-[12px] font-medium text-foreground" id="okx-position-symbol">
                    —
                  </span>
                  <span className="text-[11px] text-muted-foreground" id="okx-position-source">
                    —
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/50 ring-1 ring-border/70">
                  <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-10 shrink-0 border-border/80 bg-background/80 px-3 text-[11px] shadow-none rounded-xl"
                  id="okx-position-refresh"
                  title="重新查询"
                >
                  刷新
                </Button>
              </div>
            </div>
            <div className="mt-4 grid gap-3 lg:grid-cols-[1.35fr_1fr]">
              <div className="flex flex-col justify-between rounded-2xl border border-border/70 bg-muted/20 px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <span
                      className="inline-flex items-center rounded-full border border-border/70 bg-background/70 px-3 py-1 text-[13px] font-semibold text-foreground"
                      id="okx-position-side"
                    >
                      —
                    </span>
                    <div className="mt-3 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">未实现盈亏</div>
                    <div className="mt-1 text-4xl leading-none font-semibold tracking-tight text-foreground" id="okx-position-upl">
                      —
                    </div>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-background/60 px-3 py-2 text-right">
                    <div className="text-[10px] tracking-[0.12em] text-muted-foreground uppercase">状态</div>
                    <div className="mt-1 text-[13px] font-medium text-foreground" id="okx-position-status-copy">
                      —
                    </div>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <div className="rounded-xl border border-border/70 bg-background/60 px-3 py-2">
                    <div className="text-[10px] tracking-[0.12em] text-muted-foreground uppercase">仓位</div>
                    <div className="mt-1 text-[14px] font-semibold text-foreground" id="okx-position-size">
                      —
                    </div>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-background/60 px-3 py-2">
                    <div className="text-[10px] tracking-[0.12em] text-muted-foreground uppercase">开仓均价</div>
                    <div className="mt-1 text-[14px] font-semibold text-foreground" id="okx-position-entry">
                      —
                    </div>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-background/60 px-3 py-2">
                    <div className="text-[10px] tracking-[0.12em] text-muted-foreground uppercase">标记 / 杠杆</div>
                    <div className="mt-1 text-[14px] font-semibold text-foreground" id="okx-position-mark">
                      —
                    </div>
                  </div>
                </div>
              </div>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/6 px-3 py-3">
                    <div className="text-[10px] tracking-[0.14em] text-emerald-600/80 uppercase dark:text-emerald-400/80">Take Profit</div>
                    <div className="mt-2 text-[18px] font-semibold text-emerald-700 dark:text-emerald-300" id="okx-position-tp">
                      —
                    </div>
                  </div>
                  <div className="rounded-2xl border border-rose-500/20 bg-rose-500/6 px-3 py-3">
                    <div className="text-[10px] tracking-[0.14em] text-rose-600/80 uppercase dark:text-rose-400/80">Stop Loss</div>
                    <div className="mt-2 text-[18px] font-semibold text-rose-700 dark:text-rose-300" id="okx-position-sl">
                      —
                    </div>
                  </div>
                </div>
                <div className="rounded-2xl border border-border/70 bg-muted/15 px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[10px] tracking-[0.14em] text-muted-foreground uppercase">普通挂单</div>
                      <div className="mt-1 text-[18px] font-semibold text-foreground" id="okx-position-orders">
                        —
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 text-[11px] leading-5 text-muted-foreground" id="okx-position-orders-sub">
                    悬浮查看挂单详情
                  </div>
                </div>
                <div className="rounded-2xl border border-border/70 bg-muted/15 px-3 py-3">
                  <div className="text-[10px] tracking-[0.14em] text-muted-foreground uppercase">算法单</div>
                  <div className="mt-2 text-[13px] leading-6 text-foreground" id="okx-position-algos">
                    —
                  </div>
                </div>
              </div>
            </div>
            <span
              className="sr-only"
              id="okx-position-text"
            >
              —
            </span>
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
