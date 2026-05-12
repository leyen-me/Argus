import type { ReactNode } from "react"
import { DialogClose, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "info"

const toneClass: Record<Tone, string> = {
  neutral: "border-border/80 bg-muted/28 text-muted-foreground",
  primary: "border-primary/45 bg-primary/12 text-primary",
  success: "border-emerald-500/38 bg-emerald-500/10 text-emerald-500",
  warning: "border-amber-500/38 bg-amber-500/10 text-amber-500",
  danger: "border-red-500/38 bg-red-500/10 text-red-500",
  info: "border-cyan-500/38 bg-cyan-500/10 text-cyan-500",
}

const toneTextClass: Record<Tone, string> = {
  neutral: "text-foreground",
  primary: "text-primary",
  success: "text-emerald-500",
  warning: "text-amber-500",
  danger: "text-red-500",
  info: "text-cyan-500",
}

/**
 * 统一应用弹窗外壳，保持低圆角、强边界和固定头部结构。
 */
export function AppDialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogContent>) {
  return (
    <DialogContent
      showCloseButton={false}
      forceMount
      className={cn(
        "argus-app-dialog-content flex max-h-[min(90vh,820px)] w-[min(760px,calc(100%-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[760px]",
        className,
      )}
      {...props}
    >
      {children}
    </DialogContent>
  )
}

/**
 * 统一弹窗标题栏；closeId 用于保留旧 DOM 绑定和自动化选择器。
 */
export function AppDialogHeader({
  title,
  eyebrow,
  icon,
  closeId,
  className,
  actions,
}: {
  title: ReactNode
  eyebrow?: ReactNode
  icon?: ReactNode
  closeId: string
  className?: string
  actions?: ReactNode
}) {
  return (
    <DialogHeader className={cn("argus-app-dialog-header sticky top-0 z-10 shrink-0 space-y-0 border-b border-border/85 bg-card/95 px-5 py-4 text-left supports-backdrop-filter:backdrop-blur-sm", className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {eyebrow ? (
            <div className="mb-1 text-[10px] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
              {eyebrow}
            </div>
          ) : null}
          <div className="flex min-w-0 items-center gap-2">
            {icon ? <span className="text-primary [&_svg]:size-4">{icon}</span> : null}
            <DialogTitle className="truncate text-[15px] font-semibold tracking-tight text-foreground">
              {title}
            </DialogTitle>
          </div>
        </div>
        <div className="flex shrink-0 items-start gap-2">
          {actions}
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
              id={closeId}
              aria-label="关闭"
            >
              ×
            </Button>
          </DialogClose>
        </div>
      </div>
    </DialogHeader>
  )
}

/**
 * 统一弹窗内容滚动容器，避免各弹窗自行处理 body 间距。
 */
export function AppDialogBody({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return <div className={cn("argus-app-dialog-body min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5", className)}>{children}</div>
}

/**
 * 统一工作台面板标题栏。
 */
export function PanelHeader({
  eyebrow,
  title,
  meta,
  actions,
  className,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex h-auto min-h-10 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/85 bg-card/65 px-3 py-2 sm:h-10 sm:flex-nowrap sm:gap-3 sm:py-0", className)}>
      <div className="min-w-0">
        {eyebrow ? <div className="text-[9px] font-semibold tracking-[0.2em] text-muted-foreground uppercase">{eyebrow}</div> : null}
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-xs font-semibold tracking-[0.12em] text-foreground uppercase">{title}</div>
          {meta}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  )
}

/**
 * 统一小型状态标签，替代页面里零散的胶囊样式。
 */
export function StatusPill({
  tone = "neutral",
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & {
  tone?: Tone
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 border px-2 text-[10px] font-semibold tracking-[0.14em] uppercase",
        toneClass[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  )
}

/**
 * 统一 Dashboard 与面板指标块。
 */
export function MetricCard({
  label,
  value,
  meta,
  tone = "neutral",
  className,
}: {
  label: ReactNode
  value: ReactNode
  meta?: ReactNode
  tone?: Tone
  className?: string
}) {
  return (
    <div className={cn("border border-border/75 bg-card/70 px-4 py-3", className)}>
      <div className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">{label}</div>
      <div className={cn("mt-2 text-2xl leading-none font-semibold tracking-tight", toneTextClass[tone])}>
        {value}
      </div>
      {meta ? <div className="mt-2 text-[11px] leading-5 text-muted-foreground">{meta}</div> : null}
    </div>
  )
}
