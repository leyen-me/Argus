import { useCallback, useEffect, useState } from "react";
import { BookOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  ARGUS_PROMPT_STRATEGIES_CHANGED,
  ARGUS_STRATEGY_MODAL_CLOSE,
  ARGUS_STRATEGY_MODAL_OPEN,
} from "@/lib/argus-strategy-modal-events";

type StrategyMeta = { id: string; label: string; sort_order: number };

type ArgusApi = {
  listPromptStrategiesMeta?: () => Promise<StrategyMeta[]>;
  getPromptStrategy?: (id: string) => Promise<{
    id: string;
    label: string;
    body: string;
    sort_order: number;
  } | null>;
  savePromptStrategy?: (payload: { id: string; label: string; body: string }) => Promise<unknown>;
  deletePromptStrategy?: (id: string) => Promise<unknown>;
  importBundledPromptStrategies?: () => Promise<unknown>;
};

function getArgus(): ArgusApi | undefined {
  if (typeof window === "undefined") return undefined;
  return window.argus as ArgusApi | undefined;
}

export function StrategyCenterModal() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<StrategyMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isNew = selectedId === null;

  const applyRowToForm = (row: { id: string; label: string; body: string }) => {
    setDraftId(row.id);
    setDraftLabel(row.label || row.id);
    setDraftBody(row.body || "");
  };

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
      }
    } catch (e) {
      console.error(e);
      setStatus("加载策略列表失败");
    }
  }, []);

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      setStatus(null);
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
    void loadOne(id);
  };

  const onNew = () => {
    setSelectedId(null);
    setDraftId("");
    setDraftLabel("");
    setDraftBody("");
    setStatus(null);
  };

  const onSave = async () => {
    const api = getArgus();
    if (!api?.savePromptStrategy) {
      setStatus("当前环境无法保存（非 Electron）");
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
      setStatus("提示词正文不能为空");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await api.savePromptStrategy({ id, label, body });
      window.dispatchEvent(new CustomEvent(ARGUS_PROMPT_STRATEGIES_CHANGED));
      setStatus("已保存");
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
      await refreshList();
    } catch (e) {
      console.error(e);
      setStatus(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  const onImportBundled = async () => {
    const api = getArgus();
    if (!api?.importBundledPromptStrategies) return;
    const ok = window.confirm(
      "将用应用内置的 src/prompts 目录同步：同名策略的正文会被覆盖，磁盘上有而库中没有的会新增；仅存在于库中的自定义策略不受影响。是否继续？",
    );
    if (!ok) return;
    setBusy(true);
    setStatus(null);
    try {
      await api.importBundledPromptStrategies();
      window.dispatchEvent(new CustomEvent(ARGUS_PROMPT_STRATEGIES_CHANGED));
      setStatus("已从内置模板同步正文");
      await refreshList(selectedId ?? undefined);
    } catch (e) {
      console.error(e);
      setStatus(e instanceof Error ? e.message : "导入失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        forceMount
        className={cn(
          "flex max-h-[min(92vh,800px)] w-[min(900px,calc(100%-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[900px]",
        )}
      >
        <DialogHeader className="shrink-0 space-y-0 border-b border-border px-5 py-4 text-left">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <BookOpen className="size-4 opacity-80" aria-hidden />
              <DialogTitle className="text-base font-semibold">策略中心</DialogTitle>
            </div>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                id="btn-strategy-close"
                aria-label="关闭"
              >
                ×
              </Button>
            </DialogClose>
          </div>
          <DialogDescription className="sr-only">管理系统提示词策略</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-0 sm:flex-row">
          <aside className="flex w-full shrink-0 flex-col border-b border-border sm:w-[220px] sm:border-b-0 sm:border-r">
            <div className="flex flex-wrap gap-2 border-b border-border/80 p-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-8 text-xs"
                onClick={() => onNew()}
                disabled={busy}
              >
                新建
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => void onImportBundled()}
                disabled={busy}
              >
                同步内置
              </Button>
            </div>
            <div className="min-h-[120px] flex-1 overflow-y-auto overscroll-contain p-2">
              {list.length === 0 ? (
                <p className="m-0 px-2 py-3 text-xs text-muted-foreground">
                  {getArgus()?.listPromptStrategiesMeta
                    ? "暂无策略，可先「同步内置」或新建。"
                    : "请在 Electron 应用中使用策略中心。"}
                </p>
              ) : (
                <ul className="m-0 list-none space-y-0.5 p-0">
                  {list.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        className={cn(
                          "w-full rounded-md px-2.5 py-2 text-left text-xs transition-colors",
                          selectedId === row.id
                            ? "bg-muted font-medium text-foreground"
                            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                        )}
                        onClick={() => onSelectRow(row.id)}
                      >
                        <span className="block truncate font-mono text-[13px] text-foreground">{row.id}</span>
                        {row.label && row.label !== row.id ? (
                          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                            {row.label}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="strategy-id-input" className="text-muted-foreground">
                  策略 ID
                </Label>
                <Input
                  id="strategy-id-input"
                  className="font-mono text-sm"
                  value={draftId}
                  onChange={(e) => setDraftId(e.target.value)}
                  placeholder="如 default、al_brooks"
                  disabled={busy}
                  readOnly={!isNew}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="strategy-label-input" className="text-muted-foreground">
                  展示名称（可选）
                </Label>
                <Input
                  id="strategy-label-input"
                  className="text-sm"
                  value={draftLabel}
                  onChange={(e) => setDraftLabel(e.target.value)}
                  placeholder="默认同 ID"
                  disabled={busy}
                />
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col space-y-1.5">
              <Label htmlFor="strategy-body" className="text-muted-foreground">
                系统提示词（加密行情分析）
              </Label>
              <Textarea
                id="strategy-body"
                className="min-h-[280px] flex-1 resize-y font-mono text-[13px] leading-relaxed"
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                disabled={busy}
                spellCheck={false}
              />
            </div>

            {status ? <p className="m-0 text-xs text-muted-foreground">{status}</p> : null}

            <div className="flex flex-wrap gap-2 border-t border-border/80 pt-3">
              <Button type="button" size="sm" onClick={() => void onSave()} disabled={busy}>
                保存
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => void onDelete()}
                disabled={busy || !selectedId}
              >
                删除当前
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
