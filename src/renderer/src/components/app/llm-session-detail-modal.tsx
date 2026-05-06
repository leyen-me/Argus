import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  ImageIcon,
  MessageSquareText,
  UserRound,
  Wrench,
  XIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  type AgentSessionMessage,
  formatAssistantSessionMainText,
  formatSessionCapturedAt,
  formatSessionMessageRowBody,
  sanitizeSessionMsgRoleClass,
  shouldCollapseSessionMessage,
} from "@/lib/agent-session-display";
import {
  ARGUS_LLM_SESSION_DETAIL_OPEN,
  type ArgusLlmSessionDetailOpenDetail,
} from "@/lib/argus-llm-session-detail-events";
import { ARGUS_LLM_CHART_PREVIEW_OPEN } from "@/lib/argus-llm-chart-preview-events";
import { buildLlmSessionDetailRows, type SessionDetailRow } from "@/lib/llm-session-detail-rows";
import { cn } from "@/lib/utils";

async function copyTextToClipboard(text: string): Promise<boolean> {
  const value = String(text || "");
  if (!value) return false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "true");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(ta);
    return copied === true;
  } catch {
    return false;
  }
}

function CopyTextButton({ text, className }: { text: string; className?: string }) {
  const [state, setState] = useState<"idle" | "ok" | "err">("idle");

  const onCopy = useCallback(async () => {
    const ok = await copyTextToClipboard(text);
    setState(ok ? "ok" : "err");
    window.setTimeout(() => setState("idle"), ok ? 1200 : 1600);
  }, [text]);

  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className={cn(
        "h-7 gap-1 border-border/80 bg-background/80 px-2 text-[11px] font-medium shadow-none",
        className,
      )}
      aria-label={state === "ok" ? "已复制" : state === "err" ? "复制失败" : "复制内容"}
      onClick={() => void onCopy()}
    >
      {state === "ok" ? (
        <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
      ) : state === "err" ? (
        <XIcon className="size-3.5 text-destructive" aria-hidden />
      ) : (
        <Copy className="size-3.5 opacity-70" aria-hidden />
      )}
      {state === "ok" ? "已复制" : state === "err" ? "失败" : "复制"}
    </Button>
  );
}

const sessionMarkdownComponents = {
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
  li: ({ children }: { children?: React.ReactNode }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mt-4 mb-2 text-base font-semibold tracking-tight text-foreground first:mt-0">{children}</h3>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mt-4 mb-2 text-[15px] font-semibold tracking-tight text-foreground first:mt-0">{children}</h3>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mt-3 mb-1.5 text-sm font-semibold tracking-tight text-foreground first:mt-0">{children}</h3>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-primary/35 pl-3 text-[13px] text-muted-foreground italic">
      {children}
    </blockquote>
  ),
  hr: () => <Separator className="my-3" />,
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-primary underline underline-offset-4 hover:text-primary/80"
      children={children}
    />
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-2 overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-left text-[12px]">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => (
    <thead className="border-b border-border bg-muted/50">{children}</thead>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="px-2.5 py-1.5 font-semibold text-foreground">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border-t border-border/80 px-2.5 py-1.5 text-muted-foreground">{children}</td>
  ),
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="my-2 overflow-x-auto rounded-lg border border-border/80 bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">
      {children}
    </pre>
  ),
  code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
    const isBlock = Boolean(className?.includes("language-"));
    if (isBlock) {
      return <code className={cn("block font-mono text-[11px]", className)}>{children}</code>;
    }
    return (
      <code className="rounded border border-border/70 bg-muted/50 px-1 py-px font-mono text-[0.85em] text-foreground">
        {children}
      </code>
    );
  },
};

function CollapsiblePlainText({ text, label }: { text: string; label: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="space-y-2">
      <pre
        className={cn(
          "font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground",
          !expanded && "line-clamp-8",
        )}
      >
        {text}
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="h-7 px-1 text-[11px] text-primary"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? "收起" : `展开${label}`}
      </Button>
    </div>
  );
}

function SecondarySection({
  title,
  text,
  defaultOpen = false,
  tone = "muted",
}: {
  title: string;
  text: string;
  defaultOpen?: boolean;
  tone?: "muted" | "reasoning";
}) {
  const [open, setOpen] = useState(defaultOpen);
  const preview = text.trim().split("\n").find(Boolean) || "暂无内容";

  return (
    <div
      className={cn(
        "group/secondary rounded-2xl border px-3.5 py-3 transition-colors",
        tone === "reasoning"
          ? "border-chart-4/20 bg-chart-4/6 hover:bg-chart-4/10"
          : "border-border/70 bg-muted/22 hover:bg-muted/35",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
          {tone === "reasoning" ? (
            <MessageSquareText className="size-3.5" aria-hidden />
          ) : (
            <Wrench className="size-3.5" aria-hidden />
          )}
          <span>{title}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <CopyTextButton
            text={text}
            className="h-6 px-2 text-[10px] opacity-0 transition-opacity group-hover/secondary:opacity-100 focus-visible:opacity-100"
          />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-6 px-1.5 text-[10px] text-muted-foreground"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <ChevronUp className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
            {open ? "收起" : "展开"}
          </Button>
        </div>
      </div>
      {open ? (
        <pre className="mt-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground">
          {text}
        </pre>
      ) : (
        <p className="mt-2 line-clamp-1 text-[12px] leading-relaxed text-muted-foreground">{preview}</p>
      )}
    </div>
  );
}

function roleMeta(role: string | undefined): {
  label: string;
  icon: React.ReactNode;
  align: "start" | "end";
} {
  const r = String(role || "").toLowerCase();
  if (r === "user") {
    return {
      label: "你",
      icon: <UserRound className="size-3.5" aria-hidden />,
      align: "end",
    };
  }
  if (r === "assistant") {
    return {
      label: "Argus",
      icon: <Bot className="size-3.5" aria-hidden />,
      align: "start",
    };
  }
  if (r === "tool") {
    return {
      label: "工具",
      icon: <Wrench className="size-3.5" aria-hidden />,
      align: "start",
    };
  }
  return {
    label: String(role || "system"),
    icon: <MessageSquareText className="size-3.5" aria-hidden />,
    align: "start",
  };
}

function MessageTextBlock({
  text,
  markdown = false,
  bubble = false,
}: {
  text: string;
  markdown?: boolean;
  bubble?: boolean;
}) {
  if (markdown) {
    return (
      <div className={cn("min-w-0", bubble && "rounded-[22px] bg-muted/55 px-4 py-3")}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={sessionMarkdownComponents}>
          {text}
        </ReactMarkdown>
      </div>
    );
  }

  return (
    <div
      className={cn(
        bubble &&
          "rounded-[22px] border border-primary/15 bg-primary/8 px-4 py-3 shadow-sm",
      )}
    >
      <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground">{text}</pre>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-5 pt-2" aria-label="加载会话明细">
      <div className="flex justify-end">
        <div className="h-16 w-[52%] animate-pulse rounded-[22px] bg-muted/45" />
      </div>
      <div className="flex gap-3">
        <div className="size-7 animate-pulse rounded-full bg-muted/60" />
        <div className="flex-1 space-y-3">
          <div className="h-4 w-24 animate-pulse rounded bg-muted/60" />
          <div className="space-y-2">
            <div className="h-3.5 w-full animate-pulse rounded bg-muted/45" />
            <div className="h-3.5 w-[92%] animate-pulse rounded bg-muted/45" />
            <div className="h-3.5 w-[68%] animate-pulse rounded bg-muted/45" />
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusState({ tone, message }: { tone: "empty" | "error"; message: string }) {
  return (
    <div className="flex h-full min-h-[260px] items-center justify-center px-4">
      <div
        className={cn(
          "w-full max-w-sm rounded-3xl border px-5 py-6 text-center shadow-sm",
          tone === "error"
            ? "border-destructive/25 bg-destructive/6 text-destructive"
            : "border-border/70 bg-background/80 text-muted-foreground",
        )}
      >
        <div
          className={cn(
            "mx-auto mb-3 flex size-10 items-center justify-center rounded-full border",
            tone === "error"
              ? "border-destructive/25 bg-destructive/8"
              : "border-border/70 bg-muted/35",
          )}
        >
          <MessageSquareText className="size-4" aria-hidden />
        </div>
        <p className="m-0 text-sm font-medium">{message}</p>
      </div>
    </div>
  );
}

function MessageRowContent({ msg }: { msg: AgentSessionMessage }) {
  const role = String(msg.role || "").toLowerCase();
  const toolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
  const hasToolCalls = toolCalls.length > 0;
  const isAssistant = role === "assistant";

  if (isAssistant && hasToolCalls) {
    const mainText = formatAssistantSessionMainText(msg);
    const toolText = JSON.stringify(toolCalls, null, 2);
    return (
      <div className="space-y-4">
        {mainText ? (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
              <div className="text-[11px] text-muted-foreground">回答</div>
              <CopyTextButton text={mainText} className="h-6 px-2 text-[10px]" />
            </div>
            <MessageTextBlock text={mainText} markdown />
          </div>
        ) : null}
        <SecondarySection title="工具调用" text={toolText} />
      </div>
    );
  }

  const bodyText = formatSessionMessageRowBody(msg);
  const collapse = shouldCollapseSessionMessage(msg.role, bodyText);
  const useMarkdown = isAssistant && !hasToolCalls && bodyText !== "（空）";

  return (
    <div className="space-y-2.5">
      <div className="flex justify-end opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
        <CopyTextButton text={bodyText} className="h-6 px-2 text-[10px]" />
      </div>
      {collapse ? (
        <CollapsiblePlainText text={bodyText} label="全文" />
      ) : useMarkdown ? (
        <MessageTextBlock text={bodyText} markdown />
      ) : (
        <MessageTextBlock text={bodyText} bubble={role === "user"} />
      )}
    </div>
  );
}

function SessionDetailRowView({
  row,
  onOpenChart,
}: {
  row: SessionDetailRow;
  onOpenChart: (dataUrl: string) => void;
}) {
  if (row.kind === "chart") {
    return (
      <div className="flex justify-start" role="listitem">
        <div className="w-full max-w-[78%] space-y-2 rounded-3xl border border-border/75 bg-background/75 px-4 py-3 shadow-sm transition-colors hover:bg-background">
          <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
            <ImageIcon className="size-3.5" aria-hidden />
            <span>图表附件</span>
            <span className="text-[10px] opacity-70">本轮收盘截图</span>
          </div>
          <button
            type="button"
            className="group relative w-full max-w-[320px] overflow-hidden rounded-2xl border border-border/70 bg-background/70 text-left ring-1 ring-transparent transition hover:ring-primary/25"
            title="放大查看本轮截图"
            aria-label="放大预览图表截图"
            onClick={() => onOpenChart(row.dataUrl)}
          >
            <img
              src={row.dataUrl}
              alt="本轮 K 线收盘时的图表截图"
              className="max-h-[180px] w-full object-contain"
              decoding="async"
            />
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/0 opacity-0 transition group-hover:bg-background/35 group-hover:opacity-100">
              <span className="flex items-center gap-1 rounded-full bg-background/90 px-2.5 py-1 text-[10px] font-semibold shadow-sm ring-1 ring-border/70">
                <ImageIcon className="size-3 opacity-80" aria-hidden />
                预览
              </span>
            </span>
          </button>
        </div>
      </div>
    );
  }

  if (row.kind === "reasoning") {
    return (
      <div className="flex justify-start" role="listitem">
        <div className="w-full max-w-[78%]">
          <SecondarySection title="深度思考" text={row.text} tone="reasoning" />
        </div>
      </div>
    );
  }

  const { msg } = row;
  const seq = msg.seq != null ? ` · #${msg.seq}` : "";
  const role = String(msg.role || "").toLowerCase();
  const meta = roleMeta(msg.role);
  const isUser = role === "user";
  const isAssistant = role === "assistant";
  const roleKey = sanitizeSessionMsgRoleClass(msg.role);
  return (
    <div
      className={cn("group/message flex", meta.align === "end" ? "justify-end" : "justify-start")}
      role="listitem"
    >
      <div
        className={cn(
          "w-full",
          isUser ? "max-w-[78%]" : isAssistant ? "max-w-none" : "max-w-[82%]",
        )}
      >
        <div
          className={cn(
            "mb-2 flex items-center gap-2 text-[11px] text-muted-foreground",
            meta.align === "end" && "justify-end",
          )}
        >
          {meta.align === "start" ? (
            <>
              <span className="flex size-6 items-center justify-center rounded-full border border-border/70 bg-background shadow-sm">
                {meta.icon}
              </span>
              <span className="font-medium">{meta.label}</span>
              <span className="opacity-70">{seq ? seq.slice(3) : roleKey}</span>
            </>
          ) : (
            <>
              <span className="opacity-70">{seq ? seq.slice(3) : roleKey}</span>
              <span className="font-medium">{meta.label}</span>
              <span className="flex size-6 items-center justify-center rounded-full border border-primary/20 bg-primary/8 text-primary shadow-sm">
                {meta.icon}
              </span>
            </>
          )}
        </div>
        <div
          className={cn(
            isAssistant && "pl-8",
            !isAssistant &&
              !isUser &&
              "rounded-3xl border border-border/70 bg-background/70 px-4 py-3 shadow-sm",
          )}
        >
          <MessageRowContent msg={msg} />
        </div>
      </div>
    </div>
  );
}

export function LlmSessionDetailModal() {
  const [open, setOpen] = useState(false);
  const [barCloseId, setBarCloseId] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ tvSymbol?: string; capturedAt?: string }>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<unknown[]>([]);
  const [chartUrl, setChartUrl] = useState("");
  const [reasoningText, setReasoningText] = useState("");

  useEffect(() => {
    const onOpenSession = (e: Event) => {
      const d = (e as CustomEvent<ArgusLlmSessionDetailOpenDetail>).detail;
      if (!d?.barCloseId) return;
      setBarCloseId(d.barCloseId);
      setMeta({ tvSymbol: d.tvSymbol, capturedAt: d.capturedAt });
      setOpen(true);
      setError(null);
      setMessages([]);
      setChartUrl("");
      setReasoningText("");
    };
    window.addEventListener(ARGUS_LLM_SESSION_DETAIL_OPEN, onOpenSession);
    return () => window.removeEventListener(ARGUS_LLM_SESSION_DETAIL_OPEN, onOpenSession);
  }, []);

  useEffect(() => {
    if (!open || !barCloseId) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      if (!window.argus || typeof window.argus.getAgentSessionMessages !== "function") {
        if (!cancelled) {
          setLoading(false);
          setError("当前环境无法读取会话明细");
        }
        return;
      }
      try {
        const rawSession = await window.argus.getAgentSessionMessages(barCloseId);
        let msgs: unknown[] = [];
        let assistantReasoning = "";
        if (Array.isArray(rawSession)) {
          msgs = rawSession;
        } else if (rawSession && typeof rawSession === "object") {
          const rs = rawSession as { messages?: unknown; assistantReasoningText?: unknown };
          msgs = Array.isArray(rs.messages) ? rs.messages : [];
          assistantReasoning =
            typeof rs.assistantReasoningText === "string" && rs.assistantReasoningText.trim()
              ? rs.assistantReasoningText.trim()
              : "";
        }
        let chartData: unknown = null;
        if (typeof window.argus.getAgentBarTurnChart === "function") {
          try {
            chartData = await window.argus.getAgentBarTurnChart(barCloseId);
          } catch {
            chartData = null;
          }
        }
        if (cancelled) return;
        setLoading(false);
        if (!Array.isArray(msgs) || msgs.length === 0) {
          setError("暂无消息记录（可能尚未落库）");
          return;
        }
        const chart =
          chartData && typeof chartData === "object" && chartData !== null && "dataUrl" in chartData
            ? String((chartData as { dataUrl?: unknown }).dataUrl ?? "")
            : "";
        setMessages(msgs);
        setChartUrl(chart);
        setReasoningText(assistantReasoning);
      } catch (e) {
        if (!cancelled) {
          setLoading(false);
          const msg = e instanceof Error ? e.message : String(e);
          setError(`加载失败：${msg}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, barCloseId]);

  const rows = useMemo(
    () => buildLlmSessionDetailRows(messages, chartUrl, reasoningText),
    [messages, chartUrl, reasoningText],
  );

  const timeLine = formatSessionCapturedAt(meta.capturedAt);
  const headline = [meta.tvSymbol, timeLine].filter(Boolean).join(" · ") || "Agent 多轮对话";
  const messageCount = messages.length;

  const onOpenChart = useCallback((dataUrl: string) => {
    window.dispatchEvent(
      new CustomEvent(ARGUS_LLM_CHART_PREVIEW_OPEN, { detail: { dataUrl } }),
    );
  }, []);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setBarCloseId(null);
          setMessages([]);
          setChartUrl("");
          setReasoningText("");
          setError(null);
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        forceMount
        data-argus-llm-session-detail=""
        className={cn(
          "flex h-[min(88vh,780px)] w-[min(820px,calc(100%-2rem))] flex-col gap-0 overflow-hidden rounded-[28px] bg-background p-0 shadow-2xl ring-1 ring-foreground/10 sm:max-w-[820px]",
        )}
      >
        <DialogHeader className="shrink-0 space-y-0 border-b border-border/70 bg-background/96 px-5 py-4 text-left supports-backdrop-filter:backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-start gap-2.5">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-border/75 bg-muted/35">
                <MessageSquareText className="size-4 opacity-75" aria-hidden />
              </div>
              <div className="min-w-0 flex-1 space-y-0.5">
                <DialogTitle className="text-sm font-medium text-muted-foreground">会话明细</DialogTitle>
                <p className="truncate text-[17px] font-semibold tracking-tight text-foreground">{headline}</p>
              </div>
            </div>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="关闭"
              >
                <XIcon className="size-4" />
              </Button>
            </DialogClose>
          </div>
          <DialogDescription className="sr-only">
            查看本轮收盘 Agent 多轮对话、工具调用与图表截图
          </DialogDescription>
          {!loading && !error && messageCount > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span>{messageCount} 条消息</span>
              {chartUrl ? <span>含图表附件</span> : null}
              {reasoningText.trim() ? <span>含推理记录</span> : null}
            </div>
          ) : null}
        </DialogHeader>

        <div className="min-h-0 flex-1 bg-linear-to-b from-background via-background to-muted/25 px-5 py-4">
          {loading ? (
            <LoadingState />
          ) : error ? (
            <StatusState tone="error" message={error} />
          ) : (
            <ScrollArea className="h-[min(60vh,620px)] pr-3 md:h-[min(64vh,660px)]">
              <div className="mx-auto flex max-w-[720px] flex-col gap-5 pb-3 pt-1" role="list" aria-label="多轮消息">
                {rows.map((row, i) => (
                  <SessionDetailRowView key={`${row.kind}-${i}`} row={row} onOpenChart={onOpenChart} />
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
