import { BookOpen, LayoutDashboard, Settings, Terminal } from "lucide-react"

import { Button } from "@/components/ui/button"
import { PromptStrategySelect } from "@/components/prompt-strategy-select"

export function TitleBar() {
  return (
    <header className="titlebar">
      <span className="titlebar-traffic-guard" aria-hidden="true" />
      <div className="titlebar-title">
        <PromptStrategySelect
          className="justify-start"
          triggerClassName="max-w-[180px] justify-start"
        />
      </div>
      <div className="titlebar-actions">
        {/* <Button
          type="button"
          variant="outline"
          size="sm"
          className="titlebar-config h-7 gap-1.5 px-2.5 text-xs font-semibold shadow-none"
          id="btn-open-devtools"
          title="开发者工具"
        >
          <Terminal className="size-3.5 opacity-80" aria-hidden />
          控制台
        </Button> */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="titlebar-config h-7 gap-1.5 px-2.5 text-xs font-semibold shadow-none"
          id="btn-open-dashboard"
          title="交易仪表盘：资金、持仓与 Agent 统计"
        >
          <LayoutDashboard className="size-3.5 opacity-80" aria-hidden />
          仪表盘
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
      </div>
    </header>
  )
}
