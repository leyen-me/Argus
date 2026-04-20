import { BookOpen, EyeOff, Settings, Terminal } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

export function TitleBar() {
  return (
    <header className="titlebar">
      <span className="titlebar-traffic-guard" aria-hidden="true" />
      <span className="titlebar-title">Argus</span>
      <div className="titlebar-actions">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="titlebar-config h-7 gap-1.5 px-2.5 text-xs font-semibold shadow-none"
          id="btn-fish-mode"
          title="遮盖图表与侧栏内容，离开座位时可用。按 ESC 退出。"
          aria-pressed="false"
        >
          <EyeOff className="size-3.5 opacity-80" aria-hidden />
          <span id="btn-fish-mode-label">隐私遮挡</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="titlebar-config h-7 gap-1.5 px-2.5 text-xs font-semibold shadow-none"
          id="btn-open-devtools"
          title="开发者工具"
        >
          <Terminal className="size-3.5 opacity-80" aria-hidden />
          控制台
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="titlebar-config h-7 gap-1.5 px-2.5 text-xs font-semibold shadow-none"
          id="btn-open-strategy-center"
          title="策略中心：管理系统提示词"
        >
          <BookOpen className="size-3.5 opacity-80" aria-hidden />
          策略中心
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="titlebar-config h-7 gap-1.5 px-2.5 text-xs font-semibold shadow-none"
          id="btn-open-config"
          title="配置中心"
        >
          <Settings className="size-3.5 opacity-80" aria-hidden />
          配置
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
    </header>
  )
}
