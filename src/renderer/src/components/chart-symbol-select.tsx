import { useEffect, useState } from "react";

/** 与 `argus-renderer.js` 中 `applySymbolSelect` 派发的名称一致 */
export const ARGUS_SYMBOL_SELECT_SYNC = "argus:symbol-select-sync";

type SymbolOption = { label: string; value: string };

type SyncDetail = { symbols: SymbolOption[]; value: string };

function readSymbolSelectFromDom(): SyncDetail | null {
  const sel = document.getElementById("symbol-select");
  if (!(sel instanceof HTMLSelectElement)) return null;
  const symbols: SymbolOption[] = [...sel.options].map((o) => ({
    label: (o.textContent ?? o.value).trim(),
    value: o.value,
  }));
  if (!symbols.length) return null;
  const v = (sel.value || symbols[0]?.value || "").trim();
  return { symbols, value: v };
}

/**
 * 交易标的由当前策略在「策略中心」绑定的代币决定；此处仅展示，不可切换。
 * 仍保留隐藏 `#symbol-select` 供 argus-renderer 命令式读写。
 */
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
    const dom = readSymbolSelectFromDom();
    if (dom) {
      setOptions(dom.symbols);
      setValue(dom.value);
    }
    return () => window.removeEventListener(ARGUS_SYMBOL_SELECT_SYNC, onSync);
  }, []);

  const resolvedValue = options.some((o) => o.value === value)
    ? value
    : (options[0]?.value ?? "");

  const currentLabel =
    options.find((o) => o.value === resolvedValue)?.label?.trim() || resolvedValue || "—";

  return (
    <div className="chart-symbol-select flex min-w-0 shrink items-center justify-end">
      <select id="symbol-select" className="sr-only" tabIndex={-1} title="交易对（随当前策略）" />
      {options.length === 0 ? (
        <div
          className="inline-flex h-7 max-w-[min(240px,42vw)] items-center rounded-lg border border-border bg-background px-2.5 text-sm text-muted-foreground"
          aria-hidden
        >
          加载品种…
        </div>
      ) : (
        <div
          className="inline-flex h-7 max-w-[min(240px,42vw)] items-center rounded-lg border border-border bg-muted/30 px-2.5 text-sm text-foreground"
          title={`${currentLabel}（在策略中心修改）`}
          aria-label={`当前标的 ${currentLabel}，请在策略中心切换策略或代币`}
        >
          <span className="max-w-48 truncate">{currentLabel}</span>
        </div>
      )}
    </div>
  );
}
