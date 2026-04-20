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
          className="titlebar-config h-7 text-xs font-semibold shadow-none"
          id="btn-fish-mode"
          title="按 ESC 退出"
          aria-pressed="false"
        >
          摸鱼模式
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="titlebar-config h-7 text-xs font-semibold shadow-none"
          id="btn-open-devtools"
          title="开发者工具"
        >
          控制台
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="titlebar-config h-7 text-xs font-semibold shadow-none"
          id="btn-open-config"
          title="配置中心"
        >
          配置
        </Button>
      </div>
    </header>
  )
}
