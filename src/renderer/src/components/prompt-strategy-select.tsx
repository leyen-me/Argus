import { useEffect, useMemo, useState } from "react"

import { cn } from "@/lib/utils"

export const ARGUS_PROMPT_STRATEGY_SYNC = "argus:prompt-strategy-sync"

type SyncDetail = {
  options: Array<{ value: string; label: string }>
  value: string
}

/**
 * 顶栏仅展示当前使用的策略名称。切换在「仪表盘」内进行；若执行态为运行中/已暂停则需先停止。
 * 仍挂载隐藏 `#config-prompt-strategy`，供 `argus-renderer` 与配置流同步。
 */
export function PromptStrategySelect({
  className,
  triggerClassName,
}: {
  className?: string
  triggerClassName?: string
}) {
  const [options, setOptions] = useState<Array<{ value: string; label: string }>>([])
  const [value, setValue] = useState("")

  useEffect(() => {
    const onSync = (e: Event) => {
      const detail = (e as CustomEvent<SyncDetail>).detail
      if (!detail?.options?.length) {
        setOptions([])
        setValue("")
        return
      }
      setOptions(detail.options)
      setValue(String(detail.value ?? detail.options[0]?.value ?? ""))
    }
    window.addEventListener(ARGUS_PROMPT_STRATEGY_SYNC, onSync)
    return () => window.removeEventListener(ARGUS_PROMPT_STRATEGY_SYNC, onSync)
  }, [])

  const displayLabel = useMemo(() => {
    if (!options.length) return ""
    const v = value.trim()
    const matched = v ? options.find((o) => o.value === v) : undefined
    return matched?.label?.trim() || matched?.value || options[0]?.label || options[0]?.value || ""
  }, [options, value])

  return (
    <div className={cn("prompt-strategy-select flex min-w-0 shrink items-center justify-end", className)}>
      <select
        id="config-prompt-strategy"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        title="当前策略（由程序同步，顶栏不在此切换）"
      />
      {options.length === 0 ? (
        <div
          className={cn(
            "flex h-7 min-w-0 max-w-full items-center rounded-lg border border-border px-2.5 text-sm text-muted-foreground",
            triggerClassName,
          )}
          title="策略列表加载中，或请先在策略中心创建"
        >
          加载策略…
        </div>
      ) : (
        <div
          role="status"
          className={cn(
            "flex h-7 min-w-0 max-w-full items-center rounded-lg border border-border px-2.5 text-sm text-foreground shadow-none",
            triggerClassName,
          )}
          title="当前使用的策略 · 切换请打开「仪表盘」（执行态运行中/已暂停时需先停止策略）"
        >
          <span className="min-w-0 truncate font-medium tabular-nums">{displayLabel || "—"}</span>
        </div>
      )}
    </div>
  )
}
