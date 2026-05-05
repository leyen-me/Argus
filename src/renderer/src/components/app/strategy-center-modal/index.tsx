import { useCallback, useEffect, useState } from "react";
import { BookOpen, PencilLine, Plus, Save, Trash2, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ConfigHelpTooltip } from "@/components/app/config-modal/config-help-tooltip";
import {
  ARGUS_PROMPT_STRATEGIES_CHANGED,
  ARGUS_STRATEGY_MODAL_CLOSE,
  ARGUS_STRATEGY_MODAL_OPEN,
} from "@/lib/argus-strategy-modal-events";
import { ARGUS_APP_CONFIG_CHANGED } from "@/lib/argus-config-modal-events";
import {
  STRATEGY_DECISION_INTERVAL_TV,
  STRATEGY_TOKEN_SYMBOL_OPTIONS,
  normalizeStrategyTokenSymbol,
  type StrategyChartIndicatorId,
  type StrategyDecisionIntervalTv,
  type StrategyExtrasV1,
  type StrategyIndicatorId,
} from "@shared/strategy-fields";
import { formatPromptStrategyDisplayLabel } from "@shared/prompt-strategy-display-label";

type StrategyMeta = { id: string; label: string; sort_order: number };

type PromptStrategyRow = {
  id: string;
  label: string;
  body: string;
  sort_order: number;
  decisionIntervalTv: StrategyDecisionIntervalTv;
  extras: StrategyExtrasV1;
};

type DashboardStrategyRangeRow = {
  baselineEquityUsdt?: number | null;
  statsSince?: string | null;
};

type ArgusApi = {
  listPromptStrategiesMeta?: () => Promise<StrategyMeta[]>;
  getPromptStrategy?: (id: string) => Promise<PromptStrategyRow | null>;
  savePromptStrategy?: (payload: Record<string, unknown>) => Promise<unknown>;
  deletePromptStrategy?: (id: string) => Promise<unknown>;
  getConfig?: () => Promise<unknown>;
};

const MARKET_TF_META: { id: StrategyDecisionIntervalTv; label: string }[] = [
  { id: "5", label: "5M" },
  { id: "15", label: "15M" },
  { id: "60", label: "1H" },
  { id: "1D", label: "1D" },
];

const INDICATORS: { id: StrategyIndicatorId; label: string }[] = [
  { id: "VOL", label: "Vol" },
  { id: "EM20", label: "EMA(20)" },
  { id: "BB", label: "BB(20,2)" },
  { id: "ATR", label: "ATR(14)" },
  { id: "RSI14", label: "RSI(14)" },
  { id: "MACD", label: "MACD(12,26,9)" },
];

/** 与 {@link INDICATORS} 同 id，用于左侧 TradingView 图层 */
const CHART_INDICATORS: { id: StrategyChartIndicatorId; label: string }[] = INDICATORS;

function getArgus(): ArgusApi | undefined {
  if (typeof window === "undefined") return undefined;
  return window.argus as ArgusApi | undefined;
}

function toggleInList<T>(list: T[], item: T): T[] {
  const has = list.includes(item);
  return has ? list.filter((x) => x !== item) : [...list, item];
}

/** 新建策略 / 清空表单时的扩展字段默认值 */
function createNewStrategyExtras(): StrategyExtrasV1 {
  return {
    tokenSymbols: ["BTC"],
    marketTimeframes: ["5", "60"],
    indicators: ["VOL", "EM20"],
    chartIndicators: ["EM20"],
  };
}

type DashboardStrategyRuntimeRow = {
  status?: string;
};

/**
 * 与 `normalizeConfig` 中 `dashboardStrategyRanges` 一致：仪表盘统计会话（独立于执行态）。
 */
function parseDashboardStrategyRanges(payload: unknown): Record<string, DashboardStrategyRangeRow> {
  const root = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  const raw = root?.dashboardStrategyRanges;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, DashboardStrategyRangeRow> = {};
  for (const [k, v] of Object.entries(raw)) {
    const id = k.trim();
    if (!id || !v || typeof v !== "object" || Array.isArray(v)) continue;
    const row = v as Record<string, unknown>;
    let baselineEquityUsdt: number | null = null;
    if (typeof row.baselineEquityUsdt === "number" && Number.isFinite(row.baselineEquityUsdt)) {
      baselineEquityUsdt = row.baselineEquityUsdt >= 0 ? row.baselineEquityUsdt : null;
    }
    const sr = row.statsSince;
    const statsSince = typeof sr === "string" && sr.trim() ? sr.trim() : null;
    out[id] = { baselineEquityUsdt, statsSince };
  }
  return out;
}

function parseStrategyRuntimeById(payload: unknown): Record<string, DashboardStrategyRuntimeRow> {
  const root = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  const raw = root?.strategyRuntimeById;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, DashboardStrategyRuntimeRow> = {};
  for (const [k, v] of Object.entries(raw)) {
    const id = k.trim();
    if (!id || !v || typeof v !== "object" || Array.isArray(v)) continue;
    const row = v as Record<string, unknown>;
    const status = typeof row.status === "string" && row.status.trim() ? row.status.trim() : "";
    out[id] = status ? { status } : {};
  }
  return out;
}

/** 仪表盘统计会话是否与 bar-close 旧版判定一致（有基线 + 有效起点时间） */
function isDashboardStrategyRunningEntry(row: DashboardStrategyRangeRow | undefined): boolean {
  if (!row) return false;
  const b = row.baselineEquityUsdt;
  const baselineOk = typeof b === "number" && Number.isFinite(b) && b >= 0;
  const s = typeof row.statsSince === "string" ? row.statsSince.trim() : "";
  const sinceOk = s.length > 0 && Number.isFinite(Date.parse(s));
  return baselineOk && sinceOk;
}

/** 策略执行态是否为运行或暂停（删除前须先停止） */
function isStrategyExecutionBlocking(row: DashboardStrategyRuntimeRow | undefined): boolean {
  const s = typeof row?.status === "string" ? row.status.trim() : "";
  return s === "running" || s === "paused";
}

export function StrategyCenterModal() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<StrategyMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftDecisionTv, setDraftDecisionTv] = useState<StrategyDecisionIntervalTv>("5");
  const [draftExtras, setDraftExtras] = useState<StrategyExtrasV1>(() => createNewStrategyExtras());
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [titleEditing, setTitleEditing] = useState(false);
  /** 与 `normalizeConfig` 中 `dashboardStrategyRanges` 一致：判断是否处于仪表盘统计区间 */
  const [dashboardStrategyRanges, setDashboardStrategyRanges] = useState<
    Record<string, DashboardStrategyRangeRow>
  >({});
  const [strategyRuntimeById, setStrategyRuntimeById] = useState<Record<string, DashboardStrategyRuntimeRow>>({});

  const isNew = selectedId === null;

  const executionBlockingSelected =
    Boolean(selectedId) && isStrategyExecutionBlocking(strategyRuntimeById[selectedId!.trim()]);
  const cannotDeleteSelected = executionBlockingSelected;

  const refreshDashboardSlicesFromServer = useCallback(async () => {
    const api = getArgus();
    if (!api?.getConfig) return;
    try {
      const cfg = await api.getConfig();
      setDashboardStrategyRanges(parseDashboardStrategyRanges(cfg));
      setStrategyRuntimeById(parseStrategyRuntimeById(cfg));
    } catch (e) {
      console.error(e);
    }
  }, []);

  const applyRowToForm = useCallback((row: PromptStrategyRow) => {
    setDraftId(row.id);
    setDraftLabel(row.label || row.id);
    setDraftBody(row.body || "");
    setDraftDecisionTv(row.decisionIntervalTv);
    setDraftExtras({
      tokenSymbols: [normalizeStrategyTokenSymbol(row.extras?.tokenSymbols)],
      marketTimeframes: [...(row.extras?.marketTimeframes ?? [...STRATEGY_DECISION_INTERVAL_TV])],
      indicators: [...(row.extras?.indicators ?? [])],
      chartIndicators: [...(row.extras?.chartIndicators ?? ["EM20"])],
    });
  }, []);

  const refreshList = useCallback(async (preferId?: string | null) => {
    const api = getArgus();
    await refreshDashboardSlicesFromServer();
    if (!api?.listPromptStrategiesMeta) {
      setList([]);
      return;
    }
    try {
      const rows = await api.listPromptStrategiesMeta();
      const listRows = Array.isArray(rows) ? rows : [];
      setList(listRows);
      const ids = listRows.map((r) => r.id);
      const pick =
        (preferId != null && preferId !== "" && ids.includes(preferId) ? preferId : null) ||
        ids[0] ||
        null;
      if (pick && api.getPromptStrategy) {
        setSelectedId(pick);
        const row = await api.getPromptStrategy(pick);
        if (row) applyRowToForm(row);
      } else {
        setSelectedId(null);
        setDraftId("");
        setDraftLabel("");
        setDraftBody("");
        setDraftDecisionTv("5");
        setDraftExtras(createNewStrategyExtras());
      }
    } catch (e) {
      console.error(e);
      setStatus("加载策略列表失败");
    }
  }, [applyRowToForm, refreshDashboardSlicesFromServer]);

  useEffect(() => {
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<unknown>).detail;
      setDashboardStrategyRanges(parseDashboardStrategyRanges(detail));
      setStrategyRuntimeById(parseStrategyRuntimeById(detail));
    };
    window.addEventListener(ARGUS_PROMPT_STRATEGIES_CHANGED, onChanged);
    return () => window.removeEventListener(ARGUS_PROMPT_STRATEGIES_CHANGED, onChanged);
  }, []);

  useEffect(() => {
    const onAppConfig = () => {
      void refreshDashboardSlicesFromServer();
    };
    window.addEventListener(ARGUS_APP_CONFIG_CHANGED, onAppConfig);
    return () => window.removeEventListener(ARGUS_APP_CONFIG_CHANGED, onAppConfig);
  }, [refreshDashboardSlicesFromServer]);

  useEffect(() => {
    if (!open) return;
    const sync = () => {
      void refreshDashboardSlicesFromServer();
    };
    window.addEventListener("focus", sync);
    const t = window.setInterval(sync, 45_000);
    return () => {
      window.removeEventListener("focus", sync);
      window.clearInterval(t);
    };
  }, [open, refreshDashboardSlicesFromServer]);

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      setStatus(null);
      setTitleEditing(false);
      void refreshList();
    };
    const onClose = () => setOpen(false);
    window.addEventListener(ARGUS_STRATEGY_MODAL_OPEN, onOpen);
    window.addEventListener(ARGUS_STRATEGY_MODAL_CLOSE, onClose);
    return () => {
      window.removeEventListener(ARGUS_STRATEGY_MODAL_OPEN, onOpen);
      window.removeEventListener(ARGUS_STRATEGY_MODAL_CLOSE, onClose);
    };
  }, [refreshList]);

  const loadOne = async (id: string) => {
    const api = getArgus();
    if (!api?.getPromptStrategy) return;
    const row = await api.getPromptStrategy(id);
    if (row) applyRowToForm(row);
  };

  const onSelectRow = (id: string) => {
    setSelectedId(id);
    setStatus(null);
    setTitleEditing(false);
    void loadOne(id);
  };

  const onNew = () => {
    setSelectedId(null);
    setDraftId(crypto.randomUUID());
    setDraftLabel("");
    setDraftBody("");
    setDraftDecisionTv("5");
    setDraftExtras(createNewStrategyExtras());
    setStatus(null);
    setTitleEditing(true);
  };

  const onSave = async () => {
    const api = getArgus();
    if (!api?.savePromptStrategy) {
      setStatus("当前环境无法保存");
      return;
    }
    const id = isNew ? draftId.trim() || crypto.randomUUID() : (selectedId || "").trim();
    const label = draftLabel.trim() || id;
    const body = draftBody.trim();
    if (!body) {
      setStatus("策略逻辑不能为空");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const nextConfig = await api.savePromptStrategy({
        id,
        label,
        body,
        decisionIntervalTv: draftDecisionTv,
        extras: {
          tokenSymbols: draftExtras.tokenSymbols,
          marketTimeframes: draftExtras.marketTimeframes,
          indicators: draftExtras.indicators,
          chartIndicators: draftExtras.chartIndicators,
        },
      });
      window.dispatchEvent(
        new CustomEvent(ARGUS_PROMPT_STRATEGIES_CHANGED, { detail: nextConfig }),
      );
      const ps =
        nextConfig &&
        typeof nextConfig === "object" &&
        typeof (nextConfig as { promptStrategy?: unknown }).promptStrategy === "string"
          ? (nextConfig as { promptStrategy: string }).promptStrategy.trim()
          : "";
      setStatus(
        ps && ps !== id
          ? `已保存。顶栏当前策略为「${ps}」，图表标的跟随顶栏；要看本条代币请先切换顶栏策略。`
          : "已保存",
      );
      setTitleEditing(false);
      await refreshList(id);
    } catch (e) {
      console.error(e);
      setStatus(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!selectedId) return;
    if (executionBlockingSelected) {
      setStatus(
        "无法删除：该策略处于运行或暂停（执行态），请先在仪表盘对该策略点「停止」后再删除。",
      );
      return;
    }
    const api = getArgus();
    if (!api?.deletePromptStrategy) return;
    const ok = window.confirm(`确定删除策略「${selectedId}」？`);
    if (!ok) return;
    setBusy(true);
    setStatus(null);
    try {
      const nextConfig = await api.deletePromptStrategy(selectedId);
      window.dispatchEvent(
        new CustomEvent(ARGUS_PROMPT_STRATEGIES_CHANGED, { detail: nextConfig }),
      );
      setStatus("已删除");
      setSelectedId(null);
      setDraftId("");
      setDraftLabel("");
      setDraftBody("");
      setDraftDecisionTv("5");
      await refreshList();
    } catch (e) {
      console.error(e);
      setStatus(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  const displayTitle = isNew ? draftLabel.trim() || "新建策略" : draftLabel.trim() || draftId.trim() || "";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        forceMount
        className={cn(
          "flex h-[min(90vh,940px)] w-[min(1240px,calc(100%-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1240px]",
        )}
      >
        <header className="flex shrink-0 flex-col gap-3 border-b border-border px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <BookOpen className="size-4 shrink-0 opacity-80" aria-hidden />
              <DialogTitle className="text-base font-semibold">策略中心</DialogTitle>
            </div>
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="icon-sm" className="shrink-0" aria-label="关闭">
                <XIcon className="size-4" />
              </Button>
            </DialogClose>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {titleEditing ? (
                <Input
                  className="h-9 max-w-[min(420px,60vw)] text-sm font-medium"
                  value={draftLabel}
                  onChange={(e) => setDraftLabel(e.target.value)}
                  placeholder="策略名称"
                  disabled={busy}
                  autoFocus
                />
              ) : (
                <p className="m-0 min-w-0 truncate text-lg font-semibold tracking-tight text-foreground">
                  {displayTitle}
                </p>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                onClick={() => setTitleEditing((v) => !v)}
                disabled={busy}
                aria-label={titleEditing ? "完成名称编辑" : "编辑策略名称"}
                title="编辑名称"
              >
                <PencilLine className="size-4" />
              </Button>
            </div>
            <Button type="button" size="sm" className="shrink-0" onClick={() => void onSave()} disabled={busy}>
              <Save className="size-3.5" aria-hidden />
              保存策略
            </Button>
          </div>
          <DialogDescription className="sr-only">管理系统策略：决策周期、扩展项与提示词文本</DialogDescription>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[200px] shrink-0 flex-col border-r border-border">
            <div className="flex flex-wrap gap-2 border-b border-border/80 p-3">
              <Button type="button" variant="secondary" size="sm" className="h-8 text-xs" onClick={() => onNew()} disabled={busy}>
                <Plus className="size-3.5" aria-hidden />
                新建
              </Button>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="p-2">
                {list.length === 0 ? (
                  <p className="m-0 px-2 py-3 text-xs text-muted-foreground">
                    {getArgus()?.listPromptStrategiesMeta
                      ? "暂无策略，请先新建。"
                      : "请在已连接服务端的环境使用策略中心。"}
                  </p>
                ) : (
                  <ul className="m-0 list-none space-y-0.5 p-0">
                    {list.map((row) => (
                      <li key={row.id}>
                        <button
                          type="button"
                          className={cn(
                            "flex w-full min-w-0 items-center rounded-md px-2.5 py-2 text-left text-[13px] transition-colors",
                            selectedId === row.id
                              ? "bg-muted font-medium text-foreground"
                              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                          )}
                          onClick={() => onSelectRow(row.id)}
                        >
                          <span className="truncate">{formatPromptStrategyDisplayLabel(row.id, row.label)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </ScrollArea>
            {selectedId ? (
              <div className="border-t border-border p-3">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-full justify-center gap-1.5 text-xs text-destructive hover:text-destructive"
                  onClick={() => void onDelete()}
                  disabled={busy || cannotDeleteSelected}
                  title={
                    executionBlockingSelected
                      ? "请先停止该策略的执行态再删除"
                      : undefined
                  }
                >
                  <Trash2 className="size-3.5 shrink-0" aria-hidden />
                  删除当前策略
                </Button>
              </div>
            ) : null}
          </aside>

          <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-[minmax(280px,340px)_1fr]">
            <ScrollArea className="min-h-0 border-b border-border lg:border-b-0 lg:border-r">
              <div className="space-y-5 p-4 pr-5">
                <section>
                  <div className="flex items-center gap-1.5">
                    <Label className="text-foreground">代币</Label>
                    <ConfigHelpTooltip className="size-6">
                      每条策略绑定单一标的
                    </ConfigHelpTooltip>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {STRATEGY_TOKEN_SYMBOL_OPTIONS.map((sym) => {
                      const selected = normalizeStrategyTokenSymbol(draftExtras.tokenSymbols) === sym;
                      return (
                        <Button
                          key={sym}
                          type="button"
                          size="sm"
                          variant={selected ? "default" : "outline"}
                          className="h-8 min-w-[52px] px-2 text-xs"
                          onClick={() =>
                            setDraftExtras((prev) => ({
                              ...prev,
                              tokenSymbols: [sym],
                            }))
                          }
                          disabled={busy}
                        >
                          {sym}
                        </Button>
                      );
                    })}
                  </div>
                </section>

                <Separator />

                <section>
                  <div className="flex items-center gap-1.5">
                    <Label className="text-foreground">决策时间</Label>
                    <ConfigHelpTooltip className="size-6">
                      K 线收盘触发 Agent 的周期
                    </ConfigHelpTooltip>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {MARKET_TF_META.map((m) => (
                      <Button
                        key={m.id}
                        type="button"
                        size="sm"
                        variant={draftDecisionTv === m.id ? "default" : "outline"}
                        className="h-8 min-w-[52px] px-2 text-xs"
                        onClick={() => setDraftDecisionTv(m.id)}
                        disabled={busy}
                      >
                        {m.label}
                      </Button>
                    ))}
                  </div>
                </section>

                <Separator />

                <section>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Label className="text-foreground">市场数据</Label>
                    <ConfigHelpTooltip className="size-6">
                      与「## 多周期上下文」及模型附图顺序一致，只投喂勾选的周期
                    </ConfigHelpTooltip>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {MARKET_TF_META.map((m) => {
                      const on = draftExtras.marketTimeframes.includes(m.id);
                      return (
                        <Button
                          key={m.id}
                          type="button"
                          size="sm"
                          variant={on ? "default" : "outline"}
                          className="h-8 min-w-[52px] px-2 text-xs"
                          onClick={() =>
                            setDraftExtras((prev) => ({
                              ...prev,
                              marketTimeframes: toggleInList(prev.marketTimeframes, m.id),
                            }))
                          }
                          disabled={busy}
                        >
                          {m.label}
                        </Button>
                      );
                    })}
                  </div>
                </section>

                <Separator />

                <section>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Label className="text-foreground">技术指标</Label>
                    <ConfigHelpTooltip className="size-6">
                      勾选后写入各周期「最近 K 线」表列；未勾选不出现该列。Vol=合约成交量（K/M/B）；EMA(20)；BB(20,2σ)；ATR(14)；RSI(14)；MACD(12,26,9)。不含成交额 Turnover。
                    </ConfigHelpTooltip>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {INDICATORS.map((ind) => {
                      const on = draftExtras.indicators.includes(ind.id);
                      return (
                        <Button
                          key={ind.id}
                          type="button"
                          size="sm"
                          variant={on ? "default" : "outline"}
                          className="h-8 min-w-[52px] px-2 text-xs"
                          onClick={() =>
                            setDraftExtras((prev) => ({
                              ...prev,
                              indicators: toggleInList(prev.indicators, ind.id),
                            }))
                          }
                          disabled={busy}
                        >
                          {ind.label}
                        </Button>
                      );
                    })}
                  </div>
                </section>

                <Separator />

                <section>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Label className="text-foreground">图表指标</Label>
                    <ConfigHelpTooltip className="size-6">
                      勾选后左侧 TradingView 多周期图会预置对应指标；与「技术指标」独立——后者只影响投喂模型的 K 线表列。全不选则主图无预置指标；勾选 Vol 会显示成交量副图。
                    </ConfigHelpTooltip>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {CHART_INDICATORS.map((ind) => {
                      const on = draftExtras.chartIndicators.includes(ind.id);
                      return (
                        <Button
                          key={ind.id}
                          type="button"
                          size="sm"
                          variant={on ? "default" : "outline"}
                          className="h-8 min-w-[52px] px-2 text-xs"
                          onClick={() =>
                            setDraftExtras((prev) => ({
                              ...prev,
                              chartIndicators: toggleInList(prev.chartIndicators, ind.id),
                            }))
                          }
                          disabled={busy}
                        >
                          {ind.label}
                        </Button>
                      );
                    })}
                  </div>
                </section>
              </div>
            </ScrollArea>

            <div className="flex min-h-0 min-w-0 flex-col gap-2 p-4 pl-5">
              <Label htmlFor="strategy-body" className="text-muted-foreground">
                策略逻辑
              </Label>
              <Textarea
                id="strategy-body"
                className="min-h-0 flex-1 resize-none font-mono text-[13px] leading-relaxed"
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                disabled={busy}
                spellCheck={false}
              />
              {status ? <p className="m-0 text-xs text-muted-foreground">{status}</p> : null}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
