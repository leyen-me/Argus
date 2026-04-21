import { useCallback, useEffect, useId, useState, type ComponentType, type ReactNode } from "react"
import {
  Activity,
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  LayoutDashboard,
  LineChart,
  List,
  Percent,
  Plug,
  RefreshCw,
  Wallet,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

type EquityPoint = { t: string; equity: number }

type AgentToolStats = {
  openOk: number
  openFail: number
  closeOk: number
  closeFail: number
  sessionsWithTrace: number
}

type SwapCloseFillStats = {
  wins: number
  losses: number
  breakeven: number
  closeFills: number
  realizedPnlUsdtSum: number
  winRate: number | null
  pagesFetched: number
  capped: boolean
}

type PositionRow = {
  instId?: string
  posSide?: string
  pos?: string | number
  upl?: string | number
  margin?: string | number
  lever?: string | number
}

type DashboardPayload = {
  ok?: boolean
  skipped?: boolean
  reason?: string
  message?: string
  simulated?: boolean
  equityUsdt?: number | null
  availEqUsdt?: number | null
  marginUsedUsdt?: number | null
  uplUsdt?: number | null
  baselineEquityUsdt?: number | null
  pnlVsBaselineUsdt?: number | null
  positions?: PositionRow[]
  agentToolStats?: AgentToolStats
  dashboardAgentToolStatsSince?: string | null
  equitySeries?: EquityPoint[]
  swapCloseFillStats?: SwapCloseFillStats | null
}

function fmtUsd(n: number | null | undefined, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "—"
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function fmtSignedUsd(n: number | null | undefined, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "—"
  return `${n >= 0 ? "+" : ""}${fmtUsd(n, digits)}`
}

function fmtPct(ratio: number | null | undefined, digits = 1) {
  if (ratio == null || !Number.isFinite(ratio)) return "—"
  return `${(ratio * 100).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`
}

function EquitySparkline({ series }: { series: EquityPoint[] }) {
  const gradId = useId().replace(/:/g, "")
  const w = 320
  const h = 80
  const pad = 6
  if (!series.length) {
    return (
      <div
        className="flex h-[92px] items-center justify-center rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 text-center text-xs leading-snug text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        暂无采样数据
        <span className="mt-0.5 block text-[11px] opacity-80">启用 OKX 并刷新后将记录权益曲线</span>
      </div>
    )
  }
  const vals = series.map((p) => p.equity)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min || 1
  const innerW = w - pad * 2
  const innerH = h - pad * 2
  const pts = series.map((p, i) => {
    const x = pad + (innerW * i) / Math.max(1, series.length - 1)
    const y = pad + innerH - (innerH * (p.equity - min)) / span
    return `${x},${y}`
  })
  const lineD = `M ${pts.join(" L ")}`
  const lastX = pad + innerW
  const bottomY = pad + innerH
  const areaD = `${lineD} L ${lastX} ${bottomY} L ${pad} ${bottomY} Z`
  const first = series[0]?.equity
  const last = series[series.length - 1]?.equity
  const delta = first != null && last != null ? last - first : null
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2 text-[11px] tabular-nums">
        <div className="text-muted-foreground">
          <span className="text-[10px] uppercase tracking-wide">区间</span>
          <span className="ml-1.5 font-medium text-foreground">
            {fmtUsd(min)} – {fmtUsd(max)}
          </span>
        </div>
        {delta != null && Number.isFinite(delta) ? (
          <div
            className={cn(
              "flex items-center gap-0.5 font-medium",
              delta >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
            )}
          >
            {delta >= 0 ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
            {fmtSignedUsd(delta)} <span className="font-normal text-muted-foreground">（首尾点）</span>
          </div>
        ) : null}
      </div>
      <div className="rounded-lg border border-border/50 bg-linear-to-b from-primary/5 to-transparent p-1.5 ring-1 ring-inset ring-border/30">
        <svg
          className="w-full max-w-full text-primary"
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          aria-label="资金曲线"
        >
          <defs>
            <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.22} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={areaD} fill={`url(#${gradId})`} className="text-primary" />
          <path
            d={lineD}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
        <span>起点 {fmtUsd(first)}</span>
        <span>末点 {fmtUsd(last)}</span>
        <span>采样点 {series.length}</span>
      </div>
    </div>
  )
}

function DashboardSectionCard({
  title,
  description,
  icon: Icon,
  className,
  children,
  contentClassName,
}: {
  title: string
  description?: ReactNode
  icon?: ComponentType<{ className?: string }>
  className?: string
  children: ReactNode
  contentClassName?: string
}) {
  return (
    <Card
      size="sm"
      className={cn(
        "gap-0 overflow-hidden py-0 shadow-none ring-border/60 data-[size=sm]:gap-0 data-[size=sm]:py-0",
        className,
      )}
    >
      <CardHeader className="rounded-none border-b border-border/60 bg-muted/45 px-3 pb-2.5 pt-3">
        <div className="flex items-start gap-2.5">
          {Icon ? (
            <div
              className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-background/90 shadow-sm ring-1 ring-border/55"
              aria-hidden
            >
              <Icon className="size-3.5 text-muted-foreground" />
            </div>
          ) : null}
          <div className="min-w-0 flex-1 space-y-0.5">
            <CardTitle className="text-xs font-semibold tracking-tight text-foreground">
              {title}
            </CardTitle>
            {description ? (
              <div className="text-[11px] leading-snug text-muted-foreground">{description}</div>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className={cn("px-3 pb-3 pt-3", contentClassName)}>{children}</CardContent>
    </Card>
  )
}

function MetricTile({
  label,
  children,
  className,
  emphasized,
}: {
  label: string
  children: ReactNode
  className?: string
  emphasized?: boolean
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border/55 bg-background/60 px-2.5 py-2 shadow-sm ring-1 ring-inset ring-border/20",
        emphasized && "border-primary/25 bg-linear-to-br from-primary/[0.07] to-transparent ring-primary/15",
        className,
      )}
    >
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-[13px] leading-tight">{children}</div>
    </div>
  )
}

function CountPill({ value, tone }: { value: number; tone: "ok" | "bad" | "neutral" }) {
  const toneLabel = tone === "ok" ? "OK" : tone === "bad" ? "ERR" : "ALL"
  return (
    <div
      className={cn(
        "rounded-md px-2 py-1.5 text-center ring-1 ring-inset",
        tone === "ok" && "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-400",
        tone === "bad" && "bg-red-500/10 text-red-700 ring-red-500/20 dark:text-red-400",
        tone === "neutral" && "bg-muted/50 text-foreground ring-border/40",
      )}
    >
      <div className="text-[10px] font-semibold tracking-wide opacity-80">{toneLabel}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums leading-none">{value}</div>
    </div>
  )
}

function DashboardToolbarCard({
  embedded,
  simulated,
  simBadge,
  strategyRunning,
  loading,
  equityUsdt,
  onToggleStrategy,
  onRefresh,
}: {
  embedded: boolean
  simulated: boolean | undefined
  simBadge: ReactNode
  strategyRunning: boolean
  loading: boolean
  equityUsdt: number | null | undefined
  onToggleStrategy: () => void
  onRefresh: () => void
}) {
  const actionsPullRight = embedded && simulated !== true
  const strategyStatusClassName = strategyRunning
    ? "bg-emerald-500/12 text-emerald-700 ring-emerald-500/20 dark:text-emerald-400"
    : "bg-muted/70 text-muted-foreground ring-border/40"
  return (
    <Card
      size="sm"
      className="gap-0 overflow-hidden py-0 shadow-none ring-border/60 data-[size=sm]:gap-0 data-[size=sm]:py-0"
    >
      <CardHeader
        className={cn(
          "grid auto-rows-min grid-cols-1 items-center gap-2 rounded-none border-b border-border/60 bg-muted/45 px-3 pb-3 pt-3 sm:grid-cols-[1fr_auto]",
          embedded && "has-data-[slot=card-action]:grid-cols-1",
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          {!embedded ? (
            <>
              <div
                className="flex size-7 shrink-0 items-center justify-center rounded-md bg-background/90 shadow-sm ring-1 ring-border/55"
                aria-hidden
              >
                <LayoutDashboard className="size-3.5 text-muted-foreground" />
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <CardTitle className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  仪表盘
                </CardTitle>
                <span
                  className={cn(
                    "rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset",
                    strategyStatusClassName,
                  )}
                >
                  {strategyRunning ? "策略进行中" : "未设置策略区间"}
                </span>
                {simBadge}
              </div>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset",
                  strategyStatusClassName,
                )}
              >
                {strategyRunning ? "策略进行中" : "未设置策略区间"}
              </span>
              {simBadge}
            </div>
          )}
        </div>
        <CardAction
          className={cn(
            "flex flex-wrap items-center gap-1.5 justify-self-stretch sm:justify-self-end",
            actionsPullRight && "ml-auto justify-end",
          )}
        >
          <Button
            type="button"
            variant={strategyRunning ? "default" : "outline"}
            size="sm"
            className="h-8 px-3 text-xs shadow-none"
            disabled={
              loading || (!strategyRunning && (equityUsdt == null || !Number.isFinite(equityUsdt)))
            }
            title={
              strategyRunning
                ? "策略进行中：点击将结束策略并清除初始资金与 Agent 统计起点"
                : "开始策略：以当前权益为初始资金，并从此刻起统计 Agent 工具结果"
            }
            aria-pressed={strategyRunning}
            onClick={() => void onToggleStrategy()}
          >
            {strategyRunning ? "结束策略" : "开始策略"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-8 gap-1 px-3 text-xs shadow-none"
            disabled={loading}
            onClick={() => void onRefresh()}
          >
            <RefreshCw className={cn("size-3", loading && "animate-spin")} aria-hidden />
            {loading ? "刷新中…" : "刷新"}
          </Button>
        </CardAction>
      </CardHeader>
    </Card>
  )
}

function SwapCloseWinRateCard({
  stats,
  sinceIso,
  sinceValid,
}: {
  stats: SwapCloseFillStats | null | undefined
  sinceIso: string | null | undefined
  sinceValid: boolean
}) {
  const sinceHint =
    sinceValid && typeof sinceIso === "string" && sinceIso.length > 0
      ? `仅统计 ${fmtSampleTime(sinceIso) ?? sinceIso} 之后（与资金曲线、开平仓次数起点一致）。`
      : null
  const decided = (stats?.wins ?? 0) + (stats?.losses ?? 0)

  return (
    <DashboardSectionCard
      title="平仓胜率（OKX 成交）"
      description={
        <>
          按永续平仓成交统计，含模型平仓与止盈/止损触发；分批平仓记为多笔。胜率 = 盈利笔数 /（盈利 + 亏损）；保本单独列出。
          {sinceHint ? <span className="mt-1 block">{sinceHint}</span> : null}
          {stats?.capped ? (
            <span className="mt-1 block text-amber-700/90 dark:text-amber-300/90">
              已拉取分页上限，更早记录未计入。
            </span>
          ) : null}
        </>
      }
      icon={Percent}
    >
      {!sinceValid ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-muted/15 px-3 py-3 text-[11px] leading-snug text-muted-foreground">
          请先通过上方工具栏「开始策略范围」设置基准时间与统计起点；胜率仅统计该时点之后的平仓成交，不会纳入更早历史。
        </div>
      ) : !stats ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-muted/15 px-3 py-3 text-[11px] leading-snug text-muted-foreground">
          暂无法拉取成交明细，请稍后刷新。
        </div>
      ) : stats.closeFills === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-muted/15 px-3 py-3 text-[11px] leading-snug text-muted-foreground">
          当前时间窗内尚无平仓类成交。
        </div>
      ) : (
        <div className="space-y-2">
          <div className="rounded-lg border border-border/55 bg-background/50 p-2.5 ring-1 ring-inset ring-border/25">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              胜率（盈 / 盈+亏）
            </div>
            <div
              className={cn(
                "mt-1 text-lg font-semibold tabular-nums",
                stats.winRate != null && stats.winRate >= 0.5
                  ? "text-emerald-600 dark:text-emerald-400"
                  : stats.winRate != null
                    ? "text-amber-700 dark:text-amber-400"
                    : "text-foreground",
              )}
            >
              {fmtPct(stats.winRate)}
              {decided > 0 ? (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {stats.wins} / {decided}
                </span>
              ) : null}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MetricTile label="平仓成交笔数">
              <span className="font-semibold tabular-nums text-foreground">{stats.closeFills}</span>
            </MetricTile>
            <MetricTile label="盈利 / 亏损">
              <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                {stats.wins}
              </span>
              <span className="text-muted-foreground"> / </span>
              <span className="font-semibold tabular-nums text-red-600 dark:text-red-400">
                {stats.losses}
              </span>
            </MetricTile>
            <MetricTile label="保本">
              <span className="font-semibold tabular-nums text-foreground">{stats.breakeven}</span>
            </MetricTile>
            <MetricTile label="已实现盈亏（估）">
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  stats.realizedPnlUsdtSum >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-red-600 dark:text-red-400",
                )}
              >
                {fmtSignedUsd(stats.realizedPnlUsdtSum)}
              </span>
              <span className="text-[10px] font-normal text-muted-foreground"> USDT</span>
            </MetricTile>
          </div>
        </div>
      )}
    </DashboardSectionCard>
  )
}

function AgentToolStatsCard({ stats }: { stats: AgentToolStats }) {
  return (
    <DashboardSectionCard
      title="开平仓次数"
      description="Agent 工具调用结果汇总（成功 / 失败）"
      icon={Activity}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-border/55 bg-background/50 p-2.5 ring-1 ring-inset ring-border/25">
          <div className="mb-2 flex items-center gap-1.5 border-b border-border/40 pb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span className="rounded bg-blue-500/15 px-1 py-px text-[9px] font-bold text-blue-700 dark:text-blue-400">
              开
            </span>
            开仓
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="mb-1 text-[10px] text-muted-foreground">成功</div>
              <CountPill value={stats.openOk} tone="ok" />
            </div>
            <div>
              <div className="mb-1 text-[10px] text-muted-foreground">失败</div>
              <CountPill value={stats.openFail} tone="bad" />
            </div>
          </div>
        </div>
        <div className="rounded-lg border border-border/55 bg-background/50 p-2.5 ring-1 ring-inset ring-border/25">
          <div className="mb-2 flex items-center gap-1.5 border-b border-border/40 pb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span className="rounded bg-violet-500/15 px-1 py-px text-[9px] font-bold text-violet-700 dark:text-violet-400">
              平
            </span>
            平仓
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="mb-1 text-[10px] text-muted-foreground">成功</div>
              <CountPill value={stats.closeOk} tone="ok" />
            </div>
            <div>
              <div className="mb-1 text-[10px] text-muted-foreground">失败</div>
              <CountPill value={stats.closeFail} tone="bad" />
            </div>
          </div>
        </div>
      </div>
    </DashboardSectionCard>
  )
}

function AccountMetricsCard({ snap }: { snap: DashboardPayload }) {
  const upl = snap.uplUsdt
  const uplTone =
    upl != null && Number.isFinite(Number(upl))
      ? Number(upl) >= 0
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-red-600 dark:text-red-400"
      : "text-foreground"

  return (
    <DashboardSectionCard
      title="账户与盈亏"
      description="相对策略基准的资金变化与账户快照"
      icon={Wallet}
    >
      <div className="space-y-2">
        <MetricTile label="总盈亏（相对基准）" emphasized className="sm:col-span-3">
          <div
            className={cn(
              "text-[1.125rem] font-semibold tabular-nums tracking-tight",
              snap.pnlVsBaselineUsdt != null && snap.pnlVsBaselineUsdt >= 0
                ? "text-emerald-600 dark:text-emerald-400"
                : snap.pnlVsBaselineUsdt != null
                  ? "text-red-600 dark:text-red-400"
                  : "text-foreground",
            )}
          >
            {snap.pnlVsBaselineUsdt != null ? `${fmtSignedUsd(snap.pnlVsBaselineUsdt)} USDT` : "—"}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span
              className={cn(
                "rounded-md px-1.5 py-px font-medium ring-1 ring-inset",
                snap.pnlVsBaselineUsdt == null
                  ? "bg-muted/70 text-muted-foreground ring-border/40"
                  : snap.pnlVsBaselineUsdt >= 0
                    ? "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-400"
                    : "bg-red-500/10 text-red-700 ring-red-500/20 dark:text-red-400",
              )}
            >
              {snap.pnlVsBaselineUsdt == null ? "未设置基准" : snap.pnlVsBaselineUsdt >= 0 ? "盈利" : "亏损"}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className="rounded-md bg-muted/80 px-1.5 py-px tabular-nums ring-1 ring-border/40">
              初始 {fmtUsd(snap.baselineEquityUsdt ?? null)}
            </span>
            <span className="text-muted-foreground/70">→</span>
            <span className="rounded-md bg-muted/80 px-1.5 py-px tabular-nums ring-1 ring-border/40">
              当前 {fmtUsd(snap.equityUsdt ?? null)}
            </span>
          </div>
        </MetricTile>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <MetricTile label="未实现盈亏">
            <span className={cn("font-semibold tabular-nums", uplTone)}>
              {fmtSignedUsd(snap.uplUsdt ?? null)}
            </span>
          </MetricTile>
          <MetricTile label="当前权益（USDT）">
            <span className="font-semibold tabular-nums text-foreground">
              {fmtUsd(snap.equityUsdt ?? null)}
            </span>
          </MetricTile>
          <MetricTile label="可用资金" className="sm:col-span-1">
            <span className="font-semibold tabular-nums text-foreground">
              {fmtUsd(snap.availEqUsdt ?? null)}
            </span>
          </MetricTile>
          <MetricTile label="占用资金" className="col-span-2 sm:col-span-1">
            <span className="font-semibold tabular-nums text-foreground">
              {fmtUsd(snap.marginUsedUsdt ?? null)}
            </span>
          </MetricTile>
        </div>
      </div>
    </DashboardSectionCard>
  )
}

function positionSideStyle(posSide: string | undefined) {
  const s = String(posSide ?? "").toLowerCase()
  if (s === "long") {
    return "bg-emerald-500/12 text-emerald-800 ring-emerald-500/25 dark:text-emerald-300"
  }
  if (s === "short") {
    return "bg-red-500/12 text-red-800 ring-red-500/25 dark:text-red-300"
  }
  return "bg-muted/70 text-muted-foreground ring-border/40"
}

function PositionsCard({ positions }: { positions: PositionRow[] }) {
  return (
    <DashboardSectionCard
      title={`持仓（${positions.length}）`}
      description={positions.length ? "SWAP 持仓明细 · 可滚动查看" : "当前无永续持仓"}
      icon={List}
    >
      {positions.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border/60 bg-muted/15 py-6 text-center">
          <span className="text-xs font-medium text-muted-foreground">无 SWAP 持仓</span>
          <span className="text-[11px] text-muted-foreground/80">开仓后将在此列出合约与盈亏</span>
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="hidden grid-cols-[minmax(0,1.5fr)_auto_repeat(4,minmax(0,0.8fr))] gap-3 px-2.5 text-[10px] font-medium tracking-wide text-muted-foreground sm:grid">
            <span>合约</span>
            <span>方向</span>
            <span className="text-right">张数</span>
            <span className="text-right">未实现盈亏</span>
            <span className="text-right">保证金</span>
            <span className="text-right">杠杆</span>
          </div>
          <ul className="max-h-[184px] space-y-1.5 overflow-y-auto pr-0.5 [-ms-overflow-style:none] [scrollbar-width:thin]">
          {positions.map((p, i) => {
            const side = String(p.posSide ?? "").trim() || "—"
            const uplNum = Number(p.upl)
            const uplOk = Number.isFinite(uplNum)
            return (
              <li
                key={`${String(p.instId ?? "x")}-${String(p.posSide ?? "")}-${i}`}
                className="rounded-lg border border-border/50 bg-background/70 px-2.5 py-2.5 text-xs shadow-sm ring-1 ring-inset ring-border/20 transition-colors hover:bg-muted/30"
              >
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1.5fr)_auto_repeat(4,minmax(0,0.8fr))] sm:items-center sm:gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-semibold tracking-tight text-foreground">{p.instId ?? "—"}</div>
                  </div>
                  <span
                    className={cn(
                      "w-fit rounded-md px-1.5 py-px text-[10px] font-bold uppercase tracking-wide ring-1 ring-inset",
                      positionSideStyle(p.posSide),
                    )}
                  >
                    {side}
                  </span>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:contents">
                    <div>
                      <div className="text-[10px] text-muted-foreground sm:hidden">张数</div>
                      <div className="tabular-nums font-medium text-foreground sm:text-right">{p.pos ?? "—"}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground sm:hidden">未实现盈亏</div>
                      <div
                        className={cn(
                          "tabular-nums font-medium sm:text-right",
                          uplOk && uplNum >= 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : uplOk
                              ? "text-red-600 dark:text-red-400"
                              : "text-foreground",
                        )}
                      >
                        {fmtSignedUsd(uplOk ? uplNum : Number.NaN)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground sm:hidden">保证金</div>
                      <div className="tabular-nums font-medium text-muted-foreground sm:text-right">
                        {fmtUsd(Number(p.margin))}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground sm:hidden">杠杆</div>
                      <div className="tabular-nums font-medium text-muted-foreground sm:text-right">
                        {p.lever != null ? `${p.lever}x` : "—"}
                      </div>
                    </div>
                  </div>
                </div>
              </li>
            )
          })}
          </ul>
        </div>
      )}
    </DashboardSectionCard>
  )
}

function fmtSampleTime(t: string | undefined) {
  if (!t) return null
  try {
    const d = new Date(t)
    if (Number.isNaN(d.getTime())) return t
    return d.toLocaleString(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
  } catch {
    return t
  }
}

function EquityCurveCard({
  series,
  scopedToStatsSince,
  statsSinceIso,
}: {
  series: EquityPoint[]
  scopedToStatsSince: boolean
  statsSinceIso?: string | null
}) {
  const last = series[series.length - 1]
  const lastEq = last?.equity
  const scopeLine =
    scopedToStatsSince && statsSinceIso
      ? `仅展示 ${fmtSampleTime(statsSinceIso) ?? statsSinceIso} 之后的采样（与胜率、开平仓统计起点一致）。`
      : "未设置策略统计起点时，展示最近本地采样（与胜率统计范围无关）。"
  const desc =
    series.length && last
      ? `${scopeLine} 最近点 ${fmtSampleTime(last.t) ?? last.t} · 共 ${series.length} 点${
          lastEq != null && Number.isFinite(lastEq) ? ` · 末值 ${fmtUsd(lastEq)}` : ""
        }`
      : scopedToStatsSince
        ? `${scopeLine} 该时间之后尚无权益采样，请启用 OKX 并刷新以积累曲线。`
        : "启用 OKX 后持续写入本地，可用于回顾资金形状。"

  return (
    <DashboardSectionCard
      title="资金曲线（本地采样）"
      description={desc}
      icon={LineChart}
      contentClassName="space-y-0"
    >
      <EquitySparkline series={series} />
    </DashboardSectionCard>
  )
}

function SkippedHintCard() {
  return (
    <DashboardSectionCard
      title="OKX 未启用"
      description="资金与持仓卡片已隐藏，其他数据仍可用"
      icon={Plug}
    >
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/6 px-3 py-2.5 text-[11px] leading-relaxed text-amber-950/90 dark:text-amber-100/90">
        请在配置中心启用「OKX 永续」并填写 API，即可查看资金、持仓与基于成交的平仓胜率。本地仍会保留已采样的资金曲线；Agent 开平仓次数统计不依赖 OKX。
      </div>
    </DashboardSectionCard>
  )
}

export function TradingDashboardCard({ embedded = false }: { embedded?: boolean }) {
  const [snap, setSnap] = useState<DashboardPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!window.argus?.getDashboard) return
    setLoading(true)
    setErr(null)
    try {
      const p = (await window.argus.getDashboard()) as DashboardPayload
      setSnap(p)
      if (p && p.ok === false && typeof p.message === "string") setErr(p.message)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const t = window.setInterval(() => void load(), 45_000)
    return () => window.clearInterval(t)
  }, [load])

  const startStrategyRange = useCallback(async () => {
    const eq = snap?.equityUsdt
    if (eq == null || !Number.isFinite(eq)) {
      setErr("需要当前权益以设为初始资金，请确认已连接 OKX 并刷新。")
      return
    }
    try {
      setErr(null)
      await window.argus?.saveConfig?.({
        dashboardBaselineEquityUsdt: eq,
        dashboardAgentToolStatsSince: new Date().toISOString(),
      })
      void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [snap?.equityUsdt, load])

  const endStrategyRange = useCallback(async () => {
    try {
      setErr(null)
      await window.argus?.saveConfig?.({
        dashboardBaselineEquityUsdt: null,
        dashboardAgentToolStatsSince: null,
      })
      void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [load])

  const skipped = snap?.skipped === true
  const series = Array.isArray(snap?.equitySeries) ? snap!.equitySeries! : []
  const positions = Array.isArray(snap?.positions) ? snap!.positions! : []
  const at = snap?.agentToolStats
  const showLive = !skipped && snap?.ok === true

  const baselinePresent =
    snap?.baselineEquityUsdt != null && Number.isFinite(Number(snap.baselineEquityUsdt))
  const sincePresent =
    typeof snap?.dashboardAgentToolStatsSince === "string" &&
    snap.dashboardAgentToolStatsSince.length > 0
  const sinceRaw = snap?.dashboardAgentToolStatsSince
  const sinceValid =
    typeof sinceRaw === "string" && sinceRaw.trim().length > 0 && Number.isFinite(Date.parse(sinceRaw.trim()))
  const strategyRunning = baselinePresent && sincePresent

  const simBadge =
    snap?.simulated === true ? (
      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
        模拟盘
      </span>
    ) : null

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 shrink-0 flex-col gap-2",
        embedded ? "px-1 pt-0 pb-2" : "border-b border-border/60 px-3 pt-3 pb-2",
      )}
    >
      <DashboardToolbarCard
        embedded={embedded}
        simulated={snap?.simulated}
        simBadge={simBadge}
        strategyRunning={strategyRunning}
        loading={loading}
        equityUsdt={snap?.equityUsdt}
        onToggleStrategy={() => void (strategyRunning ? endStrategyRange() : startStrategyRange())}
        onRefresh={() => void load()}
      />

      {err ? (
        <Card
          size="sm"
          className="gap-0 overflow-hidden border-destructive/35 py-0 shadow-none ring-destructive/20 data-[size=sm]:gap-0 data-[size=sm]:py-0"
        >
          <CardContent className="flex gap-2.5 px-3 py-2.5" role="alert" aria-live="polite">
            <div
              className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-destructive/10"
              aria-hidden
            >
              <AlertCircle className="size-3.5 text-destructive" />
            </div>
            <p className="min-w-0 flex-1 text-xs leading-snug text-destructive">{err}</p>
          </CardContent>
        </Card>
      ) : null}

      {skipped ? <SkippedHintCard /> : null}

      {at ? <AgentToolStatsCard stats={at} /> : null}

      {showLive && snap ? (
        <>
          <AccountMetricsCard snap={snap} />
          <SwapCloseWinRateCard
            stats={snap.swapCloseFillStats}
            sinceIso={snap.dashboardAgentToolStatsSince}
            sinceValid={sinceValid}
          />
          <PositionsCard positions={positions} />
        </>
      ) : null}

      <EquityCurveCard
        series={series}
        scopedToStatsSince={sinceValid}
        statsSinceIso={snap?.dashboardAgentToolStatsSince}
      />
    </div>
  )
}
