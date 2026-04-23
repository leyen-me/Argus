import { useCallback, useEffect, useState } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

export const ARGUS_PROMPT_STRATEGY_SYNC = "argus:prompt-strategy-sync"

type SyncDetail = {
  options: Array<{ value: string; label: string }>
  value: string
}

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

  const onValueChange = useCallback((next: string) => {
    setValue(next)
    const sel = document.getElementById("config-prompt-strategy") as HTMLSelectElement | null
    if (!sel) return
    sel.value = next
    sel.dispatchEvent(new Event("change", { bubbles: true }))
  }, [])

  const resolvedValue = options.some((o) => o.value === value) ? value : (options[0]?.value ?? "")

  return (
    <div className={cn("prompt-strategy-select flex min-w-0 shrink items-center justify-end", className)}>
      <select id="config-prompt-strategy" className="sr-only" tabIndex={-1} title="当前策略" />
      {options.length === 0 ? (
        <div
          className={cn(
            "flex h-7 w-[min(180px,34vw)] max-w-full items-center rounded-lg border border-border bg-background px-2.5 text-sm text-muted-foreground",
            triggerClassName,
          )}
          aria-hidden
        >
          加载策略…
        </div>
      ) : (
        <Select value={resolvedValue} onValueChange={onValueChange}>
          <SelectTrigger
            size="sm"
            className={cn("h-7 w-[min(180px,34vw)] max-w-full border-border bg-background shadow-none", triggerClassName)}
            title="当前策略"
          >
            <SelectValue placeholder="选择策略" />
          </SelectTrigger>
          <SelectContent position="popper" className="z-200">
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}
