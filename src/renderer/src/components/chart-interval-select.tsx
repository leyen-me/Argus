import { useCallback, useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** 与 `argus-renderer.js` 中 `applyChartIntervalSelect` 派发的名称一致 */
export const ARGUS_CHART_INTERVAL_SYNC = "argus:chart-interval-sync";

export const CHART_INTERVAL_OPTIONS: { value: string; label: string }[] = [
  { value: "1", label: "1 分钟" },
  { value: "3", label: "3 分钟" },
  { value: "5", label: "5 分钟" },
  { value: "15", label: "15 分钟" },
  { value: "30", label: "30 分钟" },
  { value: "60", label: "1 小时" },
  { value: "120", label: "2 小时" },
  { value: "240", label: "4 小时" },
  { value: "D", label: "日线" },
  { value: "1D", label: "1D" },
];

export function ChartIntervalSelect() {
  const [value, setValue] = useState("5");

  useEffect(() => {
    const onSync = (e: Event) => {
      const v = (e as CustomEvent<{ value: string }>).detail?.value;
      if (v != null && v !== "") setValue(String(v));
    };
    window.addEventListener(ARGUS_CHART_INTERVAL_SYNC, onSync);
    return () => window.removeEventListener(ARGUS_CHART_INTERVAL_SYNC, onSync);
  }, []);

  const onValueChange = useCallback((next: string) => {
    setValue(next);
    const sel = document.getElementById("chart-interval-select") as HTMLSelectElement | null;
    if (!sel) return;
    sel.value = next;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, []);

  const resolved = CHART_INTERVAL_OPTIONS.some((o) => o.value === value) ? value : "5";

  return (
    <div className="chart-interval-select flex min-w-0 shrink items-center justify-end">
      <select id="chart-interval-select" className="sr-only" tabIndex={-1} title="K 线周期">
        {CHART_INTERVAL_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Select value={resolved} onValueChange={onValueChange}>
        <SelectTrigger
          size="sm"
          className="h-7 w-[min(112px,28vw)] max-w-full border-border bg-background shadow-none"
          title="K 线周期"
        >
          <SelectValue placeholder="周期" />
        </SelectTrigger>
        <SelectContent position="popper" className="z-200">
          {CHART_INTERVAL_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
