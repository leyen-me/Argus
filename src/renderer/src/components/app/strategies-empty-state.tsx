import { BookOpen, LineChart } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ARGUS_STRATEGY_MODAL_OPEN } from "@/lib/argus-strategy-modal-events"

export function StrategiesEmptyState() {
  const openStrategyCenter = () => {
    window.dispatchEvent(new CustomEvent(ARGUS_STRATEGY_MODAL_OPEN))
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-8 px-8 py-16">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div
          className="flex size-16 items-center justify-center rounded-2xl border border-border/80 bg-muted/30 text-muted-foreground shadow-sm"
          aria-hidden
        >
          <LineChart className="size-8 opacity-80" strokeWidth={1.5} />
        </div>
        <div className="space-y-2">
          <h1 className="m-0 text-lg font-semibold tracking-tight text-foreground">尚无交易策略</h1>
          <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">
            先在策略中心创建至少一个提示词策略，即可加载图表、连接 LLM 助手并查看仪表盘统计。创建后界面会自动恢复。
          </p>
        </div>
        <Button type="button" className="gap-2 shadow-sm" onClick={openStrategyCenter}>
          <BookOpen className="size-4 opacity-90" aria-hidden />
          打开策略中心
        </Button>
      </div>
    </div>
  )
}
