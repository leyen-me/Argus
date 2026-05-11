import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ClipboardList, ExternalLink, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AppDialogContent, AppDialogHeader, StatusPill } from "@/components/app/ui-shell";
import { ARGUS_LLM_SESSION_DETAIL_OPEN } from "@/lib/argus-llm-session-detail-events";
import { ARGUS_TRADE_REVIEW_MODAL_OPEN } from "@/lib/argus-trade-review-modal-events";
import { cn } from "@/lib/utils";

type TradeReviewRow = {
  id: string;
  tvSymbol: string;
  interval: string;
  entryBarCloseId: string;
  exitBarCloseId: string;
  entryAt: string;
  exitAt: string;
  side?: string | null;
  entryPrice?: number | null;
  exitPrice?: number | null;
  pnl?: number | null;
  exitType: string;
  exitReasonSource: string;
  contextSummary?: unknown;
  reviewText?: string | null;
  attribution?: string | null;
  lessons?: unknown[];
  sourceSessionIds?: string[];
  status: string;
  error?: string | null;
};

type TradeReviewPage = {
  rows?: TradeReviewRow[];
  nextCursor?: unknown;
  hasMore?: boolean;
};

const mdComponents = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="mb-2.5 text-[13px] leading-relaxed text-foreground last:mb-0">{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="mb-2.5 list-disc space-y-1 pl-4 text-[13px] leading-relaxed marker:text-muted-foreground">
      {children}
    </ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="mb-2.5 list-decimal space-y-1 pl-4 text-[13px] leading-relaxed marker:text-muted-foreground">
      {children}
    </ol>
  ),
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mt-4 mb-2 text-base font-semibold tracking-tight text-foreground first:mt-0">{children}</h3>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mt-4 mb-2 text-[15px] font-semibold tracking-tight text-foreground first:mt-0">{children}</h3>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mt-3 mb-1.5 text-sm font-semibold tracking-tight text-foreground first:mt-0">{children}</h3>
  ),
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="rounded border border-border/70 bg-muted/50 px-1 py-px font-mono text-[0.85em] text-foreground">
      {children}
    </code>
  ),
};

function fmtTime(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return value;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function fmtNum(value?: number | null, digits = 4) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return Number(value).toFixed(digits).replace(/\.?0+$/, "");
}

function exitTypeLabel(value: string) {
  switch (value) {
    case "active_close":
      return "主动平仓";
    case "passive_take_profit":
      return "被动止盈";
    case "passive_stop_loss":
      return "被动止损";
    case "manual_or_external":
      return "外部/手动";
    default:
      return "未知";
  }
}

function attributionLabel(value?: string | null) {
  switch (value) {
    case "market_error":
      return "市场验证失败";
    case "self_error":
      return "自己错";
    case "execution_issue":
      return "执行问题";
    case "risk_issue":
      return "风控问题";
    case "data_insufficient":
      return "数据不足";
    default:
      return "待归因";
  }
}

function openSession(barCloseId: string) {
  if (!barCloseId) return;
  window.dispatchEvent(new CustomEvent(ARGUS_LLM_SESSION_DETAIL_OPEN, { detail: { barCloseId } }));
}

export function TradeReviewModal() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TradeReviewRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => rows.find((row) => row.id === selectedId) ?? rows[0] ?? null,
    [rows, selectedId],
  );

  const load = useCallback(async () => {
    if (!window.argus?.listTradeReviewsPage) return;
    setLoading(true);
    setError(null);
    try {
      const page = (await window.argus.listTradeReviewsPage({ limit: 50 })) as TradeReviewPage;
      const nextRows = Array.isArray(page.rows) ? page.rows : [];
      setRows(nextRows);
      setSelectedId((prev) => (prev && nextRows.some((row) => row.id === prev) ? prev : nextRows[0]?.id ?? null));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      void load();
    };
    window.addEventListener(ARGUS_TRADE_REVIEW_MODAL_OPEN, onOpen);
    return () => window.removeEventListener(ARGUS_TRADE_REVIEW_MODAL_OPEN, onOpen);
  }, [load]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <AppDialogContent className="h-[min(88vh,860px)] w-[min(1180px,calc(100%-2rem))] sm:max-w-[1180px]">
        <AppDialogHeader
          title="交易复盘"
          eyebrow="trade review"
          icon={<ClipboardList aria-hidden />}
          closeId="btn-trade-review-close"
          actions={
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                disabled={loading}
                onClick={() => void load()}
              >
                <RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden />
                刷新
              </Button>
            </div>
          }
        />
        <DialogDescription className="sr-only">查看已完成交易的 LLM 复盘记录</DialogDescription>

        <div className="grid min-h-0 flex-1 grid-cols-[360px_minmax(0,1fr)]">
          <aside className="min-h-0 border-r border-border bg-muted/15">
            <ScrollArea className="h-full">
              <div className="space-y-2 p-3">
                {error ? <div className="border border-destructive/30 bg-destructive/8 p-3 text-xs text-destructive">{error}</div> : null}
                {!loading && rows.length === 0 ? (
                  <div className="border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
                    暂无复盘记录。交易完成后会自动生成。
                  </div>
                ) : null}
                {rows.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className={cn(
                      "w-full rounded-sm border p-3 text-left transition-colors",
                      selected?.id === row.id
                        ? "border-primary/50 bg-primary/8"
                        : "border-border bg-background/70 hover:bg-muted/40",
                    )}
                    onClick={() => setSelectedId(row.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-foreground">{row.tvSymbol}</span>
                      <span className="border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                        {exitTypeLabel(row.exitType)}
                      </span>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      {fmtTime(row.entryAt)} → {fmtTime(row.exitAt)}
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{row.side || "—"} · {row.interval}</span>
                      <span className={cn("font-medium", Number(row.pnl) > 0 ? "text-emerald-600" : Number(row.pnl) < 0 ? "text-destructive" : "text-muted-foreground")}>
                        PnL {fmtNum(row.pnl)}
                      </span>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      {row.status === "completed" ? attributionLabel(row.attribution) : row.status}
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </aside>

          <section className="min-h-0">
            <ScrollArea className="h-full">
              {selected ? (
                <div className="space-y-4 p-5">
                  <div className="border border-border bg-card p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-base font-semibold text-foreground">{selected.tvSymbol}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {fmtTime(selected.entryAt)} → {fmtTime(selected.exitAt)}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 text-xs">
                        <StatusPill>{exitTypeLabel(selected.exitType)}</StatusPill>
                        <StatusPill>{attributionLabel(selected.attribution)}</StatusPill>
                        {selected.exitReasonSource === "inferred" ? (
                          <StatusPill tone="warning">
                            出场类型为推断
                          </StatusPill>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
                      <div className="border border-border/60 bg-muted/25 p-3">
                        <div className="text-muted-foreground">方向</div>
                        <div className="mt-1 font-medium">{selected.side || "—"}</div>
                      </div>
                      <div className="border border-border/60 bg-muted/25 p-3">
                        <div className="text-muted-foreground">入场/出场</div>
                        <div className="mt-1 font-medium">{fmtNum(selected.entryPrice)} / {fmtNum(selected.exitPrice)}</div>
                      </div>
                      <div className="border border-border/60 bg-muted/25 p-3">
                        <div className="text-muted-foreground">PnL</div>
                        <div className="mt-1 font-medium">{fmtNum(selected.pnl)}</div>
                      </div>
                      <div className="border border-border/60 bg-muted/25 p-3">
                        <div className="text-muted-foreground">状态</div>
                        <div className="mt-1 font-medium">{selected.status}</div>
                      </div>
                    </div>
                  </div>

                  {selected.error ? (
                    <div className="border border-destructive/30 bg-destructive/8 p-3 text-sm text-destructive">
                      {selected.error}
                    </div>
                  ) : null}

                  <div className="border border-border bg-card p-4">
                    <h3 className="mb-3 text-sm font-semibold">复盘结论</h3>
                    {selected.reviewText ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                        {selected.reviewText}
                      </ReactMarkdown>
                    ) : (
                      <p className="text-sm text-muted-foreground">复盘尚未完成。</p>
                    )}
                  </div>

                  <div className="border border-border bg-card p-4">
                    <h3 className="mb-3 text-sm font-semibold">原始 Agent 会话</h3>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => openSession(selected.entryBarCloseId)}>
                        <ExternalLink className="size-3.5" aria-hidden />
                        开仓会话
                      </Button>
                      <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => openSession(selected.exitBarCloseId)}>
                        <ExternalLink className="size-3.5" aria-hidden />
                        出场会话
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
                  请选择一条复盘记录。
                </div>
              )}
            </ScrollArea>
          </section>
        </div>
      </AppDialogContent>
    </Dialog>
  );
}
