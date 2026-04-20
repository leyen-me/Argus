import { EyeOff, Keyboard } from "lucide-react"

import { Button } from "@/components/ui/button"

export function FishModeOverlay() {
  return (
    <div
      className="fish-mode-overlay"
      id="fish-mode-overlay"
      hidden
      aria-hidden="true"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fish-mode-title"
      aria-describedby="fish-mode-desc"
    >
      <div className="fish-mode-card">
        <div className="fish-mode-card-icon" aria-hidden="true">
          <EyeOff className="size-11" strokeWidth={1.15} />
        </div>
        <h2 id="fish-mode-title" className="fish-mode-title">
          界面已隐藏
        </h2>
        <p id="fish-mode-desc" className="fish-mode-desc">
          图表与侧栏内容已被遮盖，适合短暂离开工位或投屏时避免误露敏感信息。
        </p>
        <div className="fish-mode-hint-row">
          <Keyboard className="size-3.5 shrink-0 opacity-70" aria-hidden />
          <span>也可按</span>
          <kbd className="fish-mode-kbd">Esc</kbd>
          <span>退出</span>
        </div>
        <Button
          type="button"
          id="fish-mode-dismiss"
          variant="default"
          size="default"
          className="fish-mode-dismiss w-full sm:w-auto"
        >
          恢复显示
        </Button>
      </div>
    </div>
  )
}
