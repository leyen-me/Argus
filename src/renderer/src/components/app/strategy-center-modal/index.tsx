import { useCallback, useEffect, useState } from "react";
import { BookOpen, PencilLine, XIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
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
import {
  STRATEGY_DECISION_INTERVAL_TV,
  decisionIntervalLabel,
  type StrategyDecisionIntervalTv,
  type StrategyExtrasV1,
  type StrategyIndicatorId,
} from "@shared/strategy-fields";

type StrategyMeta = { id: string; label: string; sort_order: number };

type PromptStrategyRow = {
  id: string;
  label: string;
  body: string;
  sort_order: number;
  decisionIntervalTv: StrategyDecisionIntervalTv;
  extras: StrategyExtrasV1;
};

type ArgusApi = {
  listPromptStrategiesMeta?: () => Promise<StrategyMeta[]>;
  getPromptStrategy?: (id: string) => Promise<PromptStrategyRow | null>;
  savePromptStrategy?: (payload: Record<string, unknown>) => Promise<void>;
  deletePromptStrategy?: (id: string) => Promise<void>;
};

const MARKET_TF_META: { id: StrategyDecisionIntervalTv; label: string }[] = [
  { id: "5", label: "5M" },
  { id: "15", label: "15M" },
  { id: "60", label: "1H" },
  { id: "1D", label: "1D" },
];

const INDICATORS: { id: StrategyIndicatorId; label: string }[] = [
  { id: "EM20", label: "EMA 20" },
  { id: "BB", label: "布林带 BB" },
  { id: "ATR", label: "ATR" },
  { id: "MACD", label: "MACD" },
];

function getArgus(): ArgusApi | undefined {
  if (typeof window === "undefined") return undefined;
  return window.argus as ArgusApi | undefined;
}

function toggleInList<T>(list: T[], item: T): T[] {
  const has = list.includes(item);
  return has ? list.filter((x) => x !== item) : [...list, item];
}

export function StrategyCenterModal() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<StrategyMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftDecisionTv, setDraftDecisionTv] = useState<StrategyDecisionIntervalTv>("5");
  const [draftExtras, setDraftExtras] = useState<StrategyExtrasV1>({
    tokenSymbols: [],
    marketTimeframes: [...STRATEGY_DECISION_INTERVAL_TV],
    indicators: [],
  });
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [titleEditing, setTitleEditing] = useState(false);

  const isNew = selectedId === null;

  const applyRowToForm = useCallback((row: PromptStrategyRow) => {
    setDraftId(row.id);
    setDraftLabel(row.label || row.id);
    setDraftBody(row.body || "");
    setDraftDecisionTv(row.decisionIntervalTv);
    setDraftExtras({
      tokenSymbols: [...(row.extras?.tokenSymbols ?? [])],
      marketTimeframes: [...(row.extras?.marketTimeframes ?? [...STRATEGY_DECISION_INTERVAL_TV])],
      indicators: [...(row.extras?.indicators ?? [])],
    });
  }, []);

  const refreshList = useCallback(async (preferId?: string | null) => {
    const api = getArgus();
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
        setDraftExtras({
          tokenSymbols: [],
          marketTimeframes: [...STRATEGY_DECISION_INTERVAL_TV],
          indicators: [],
        });
      }
    } catch (e) {
      console.error(e);
      setStatus("加载策略列表失败");
    }
  }, [applyRowToForm]);

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
    setDraftId("");
    setDraftLabel("");
    setDraftBody("");
    setDraftDecisionTv("5");
    setDraftExtras({
      tokenSymbols: [],
      marketTimeframes: [...STRATEGY_DECISION_INTERVAL_TV],
      indicators: [],
    });
    setStatus(null);
    setTitleEditing(true);
  };

  const onSave = async () => {
    const api = getArgus();
    if (!api?.savePromptStrategy) {
      setStatus("当前环境无法保存");
      return;
    }
    const id = (isNew ? draftId : selectedId || "").trim();
    const label = draftLabel.trim() || id;
    const body = draftBody.trim();
    if (!id) {
      setStatus("请填写策略 ID");
      return;
    }
    if (!body) {
      setStatus("策略文本不能为空");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await api.savePromptStrategy({
        id,
        label,
        body,
        decisionIntervalTv: draftDecisionTv,
        extras: {
          tokenSymbols: draftExtras.tokenSymbols,
          marketTimeframes: draftExtras.marketTimeframes,
          indicators: draftExtras.indicators,
        },
      });
      window.dispatchEvent(new CustomEvent(ARGUS_PROMPT_STRATEGIES_CHANGED));
      setStatus("已保存");
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
    const api = getArgus();
    if (!api?.deletePromptStrategy) return;
    const ok = window.confirm(`确定删除策略「${selectedId}」？至少会保留一条策略。`);
    if (!ok) return;
    setBusy(true);
    setStatus(null);
    try {
      await api.deletePromptStrategy(selectedId);
      window.dispatchEvent(new CustomEvent(ARGUS_PROMPT_STRATEGIES_CHANGED));
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

  const displayTitle = draftLabel.trim() || draftId.trim() || (isNew ? "新建策略" : "");

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
              保存策略
            </Button>
          </div>
          <DialogDescription className="sr-only">管理系统策略：决策周期、扩展项与提示词文本</DialogDescription>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[200px] shrink-0 flex-col border-r border-border">
            <div className="flex flex-wrap gap-2 border-b border-border/80 p-3">
              <Button type="button" variant="secondary" size="sm" className="h-8 text-xs" onClick={() => onNew()} disabled={busy}>
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
                            "flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left text-xs transition-colors",
                            selectedId === row.id
                              ? "bg-muted font-medium text-foreground"
                              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                          )}
                          onClick={() => onSelectRow(row.id)}
                        >
                          <span className="truncate font-mono text-[13px] text-foreground">{row.id}</span>
                          {row.label && row.label !== row.id ? (
                            <span className="truncate text-[11px] text-muted-foreground">{row.label}</span>
                          ) : null}
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
                  className="h-8 w-full text-xs text-destructive hover:text-destructive"
                  onClick={() => void onDelete()}
                  disabled={busy || list.length <= 1}
                >
                  删除当前策略
                </Button>
              </div>
            ) : null}
          </aside>

          <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-[minmax(280px,340px)_1fr]">
            <ScrollArea className="min-h-0 border-b border-border lg:border-b-0 lg:border-r">
              <div className="space-y-5 p-4 pr-5">
                {isNew ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5">
                      <Label htmlFor="strategy-id-field" className="text-muted-foreground">
                        策略 ID
                      </Label>
                      <ConfigHelpTooltip className="size-6">
                        保存后不可修改；用于内部引用与文件级标识。
                      </ConfigHelpTooltip>
                    </div>
                    <Input
                      id="strategy-id-field"
                      className="font-mono text-sm"
                      value={draftId}
                      onChange={(e) => setDraftId(e.target.value)}
                      placeholder="如 swing_1h、scalp_5m"
                      disabled={busy}
                    />
                  </div>
                ) : null}

                <section className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label className="text-foreground">代币范围</Label>
                    <Badge variant="secondary" className="text-[10px] font-normal">
                      即将推出
                    </Badge>
                  </div>
                  <Input disabled placeholder="占位：不同策略可绑定不同交易对（未实现）" className="bg-muted/40 text-muted-foreground" />
                </section>

                <Separator />

                <section>
                  <div className="flex items-center gap-1.5">
                    <Label className="text-foreground">决策时间</Label>
                    <ConfigHelpTooltip className="size-6">
                      K 线收盘触发 Agent 的周期；与当前策略绑定。
                    </ConfigHelpTooltip>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {STRATEGY_DECISION_INTERVAL_TV.map((tv) => (
                      <Button
                        key={tv}
                        type="button"
                        size="sm"
                        variant={draftDecisionTv === tv ? "default" : "outline"}
                        className="h-9 justify-center text-xs font-medium"
                        onClick={() => setDraftDecisionTv(tv)}
                        disabled={busy}
                      >
                        {decisionIntervalLabel(tv)}
                      </Button>
                    ))}
                  </div>
                </section>

                <Separator />

                <section>
                  <div className="flex flex-wrap items-center gap-2">
                    <Label className="text-foreground">市场数据</Label>
                    <ConfigHelpTooltip className="size-6">
                      选择拟提供给模型的多周期数据（已持久化，尚未接入行情筛选逻辑）。
                    </ConfigHelpTooltip>
                    <Badge variant="secondary" className="text-[10px] font-normal">
                      占位
                    </Badge>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {MARKET_TF_META.map((m) => {
                      const on = draftExtras.marketTimeframes.includes(m.id);
                      return (
                        <Button
                          key={m.id}
                          type="button"
                          size="sm"
                          variant={on ? "secondary" : "outline"}
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
                  <div className="flex flex-wrap items-center gap-2">
                    <Label className="text-foreground">技术指标</Label>
                    <ConfigHelpTooltip className="size-6">
                      勾选会写入策略配置，图表与提示词尚未自动应用。
                    </ConfigHelpTooltip>
                    <Badge variant="secondary" className="text-[10px] font-normal">
                      占位
                    </Badge>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {INDICATORS.map((ind) => {
                      const on = draftExtras.indicators.includes(ind.id);
                      return (
                        <Button
                          key={ind.id}
                          type="button"
                          size="sm"
                          variant={on ? "secondary" : "outline"}
                          className="h-8 px-2.5 text-xs"
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
              </div>
            </ScrollArea>

            <div className="flex min-h-0 min-w-0 flex-col gap-2 p-4 pl-5">
              <Label htmlFor="strategy-body" className="text-muted-foreground">
                策略文本（系统提示词）
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
