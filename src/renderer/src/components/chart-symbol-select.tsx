import { useCallback, useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** 与 `argus-renderer.js` 中 `applySymbolSelect` 派发的名称一致 */
export const ARGUS_SYMBOL_SELECT_SYNC = "argus:symbol-select-sync";

type SymbolOption = { label: string; value: string };

type SyncDetail = { symbols: SymbolOption[]; value: string };

export function ChartSymbolSelect() {
  const [options, setOptions] = useState<SymbolOption[]>([]);
  const [value, setValue] = useState("");

  useEffect(() => {
    const onSync = (e: Event) => {
      const ce = e as CustomEvent<SyncDetail>;
      const d = ce.detail;
      if (!d?.symbols) return;
      setOptions(d.symbols);
      setValue(String(d.value ?? d.symbols[0]?.value ?? ""));
    };
    window.addEventListener(ARGUS_SYMBOL_SELECT_SYNC, onSync);
    return () => window.removeEventListener(ARGUS_SYMBOL_SELECT_SYNC, onSync);
  }, []);

  const onValueChange = useCallback((next: string) => {
    setValue(next);
    const sel = document.getElementById("symbol-select") as HTMLSelectElement | null;
    if (!sel) return;
    sel.value = next;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, []);

  const resolvedValue = options.some((o) => o.value === value)
    ? value
    : (options[0]?.value ?? "");

  return (
    <div className="chart-symbol-select flex min-w-0 shrink items-center justify-end">
      {/*
        保留原生 select 供 argus-renderer  imperative 逻辑（选项、.value、change 监听）
      */}
      <select id="symbol-select" className="sr-only" tabIndex={-1} title="交易对" />
      {options.length === 0 ? (
        <div
          className="flex h-8 w-[min(240px,42vw)] max-w-full items-center rounded-lg border border-border bg-background px-2.5 text-sm text-muted-foreground"
          aria-hidden
        >
          加载品种…
        </div>
      ) : (
        <Select value={resolvedValue} onValueChange={onValueChange}>
          <SelectTrigger
            size="sm"
            className="h-8 w-[min(240px,42vw)] max-w-full border-border bg-background shadow-none"
            title="交易对"
          >
            <SelectValue placeholder="选择标的" />
          </SelectTrigger>
          <SelectContent position="popper" className="z-[200]">
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
