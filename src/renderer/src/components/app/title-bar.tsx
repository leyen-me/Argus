import { EyeOff, Settings, Terminal } from "lucide-react"

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
