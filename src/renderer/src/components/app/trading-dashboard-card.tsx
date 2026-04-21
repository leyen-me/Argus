import { useCallback, useEffect, useState, type ReactNode } from "react"
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
}

function fmtUsd(n: number | null | undefined, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "—"
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function EquitySparkline({ series }: { series: EquityPoint[] }) {
  const w = 320
  const h = 72
  const pad = 4
  if (!series.length) {
    return (
      <div
        className="flex h-[72px] items-center justify-center rounded-md border border-dashed border-border/70 bg-muted/15 text-[11px] text-muted-foreground"
        aria-hidden
      >
        暂无采样数据（启用 OKX 并刷新后将记录权益曲线）
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
  const d = `M ${pts.join(" L ")}`
  return (
    <svg
      className="w-full max-w-full text-primary"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-label="资金曲线"
    >
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function DashboardSectionCard({
  title,
  className,
  children,
  contentClassName,
}: {
  title: string
  className?: string
  children: ReactNode
  contentClassName?: string
}) {
  return (
    <Card size="sm" className={cn("gap-0 py-0 shadow-none ring-border/60", className)}>
      <CardHeader className="px-3 pb-2 pt-3">
        <CardTitle className="text-[11px] font-medium text-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className={cn("px-3 pb-3 pt-0", contentClassName)}>{children}</CardContent>
    </Card>
  )
}

function DashboardToolbarCard({
  embedded,
  simulated,
  simBadge,
  strategyRunning,
  strategyEnded,
  loading,
  equityUsdt,
  onToggleStrategy,
  onEndStrategy,
  onRefresh,
}: {
  embedded: boolean
  simulated: boolean | undefined
  simBadge: ReactNode
  strategyRunning: boolean
  strategyEnded: boolean
  loading: boolean
  equityUsdt: number | null | undefined
  onToggleStrategy: () => void
  onEndStrategy: () => void
  onRefresh: () => void
}) {
  const actionsPullRight = embedded && simulated !== true
  return (
    <Card size="sm" className="gap-0 py-0 shadow-none ring-border/60">
      <CardHeader
        className={cn(
          "grid auto-rows-min grid-cols-1 items-center gap-2 px-3 pb-3 pt-3 sm:grid-cols-[1fr_auto]",
          embedded && "has-data-[slot=card-action]:grid-cols-1",
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {!embedded ? (
            <>
              <CardTitle className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                仪表盘
              </CardTitle>
              {simBadge}
            </>
          ) : (
            simBadge
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
            className="h-7 px-2.5 text-[11px] shadow-none"
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
            策略开始
          </Button>
          <Button
            type="button"
            variant={strategyEnded ? "default" : "outline"}
            size="sm"
            className="h-7 px-2.5 text-[11px] shadow-none"
            disabled={loading || strategyEnded}
            title={
              strategyEnded
                ? "当前未设置策略区间（无基准、统计全部历史回合）"
                : "结束策略：清除初始资金与 Agent 统计起点"
            }
            aria-pressed={strategyEnded}
            onClick={() => void onEndStrategy()}
          >
            策略结束
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 px-2.5 text-[11px] shadow-none"
            disabled={loading}
            onClick={() => void onRefresh()}
          >
            {loading ? "刷新中…" : "刷新"}
          </Button>
        </CardAction>
      </CardHeader>
    </Card>
  )
}

function AgentToolStatsCard({ stats }: { stats: AgentToolStats }) {
  return (
    <DashboardSectionCard title="开平仓次数">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div>
          <div className="text-[11px] text-muted-foreground">开仓 · 成功</div>
          <div className="text-[11px] font-medium tabular-nums">{stats.openOk}</div>
        </div>
        <div>
          <div className="text-[11px] text-muted-foreground">开仓 · 失败</div>
          <div className="text-[11px] font-medium tabular-nums">{stats.openFail}</div>
        </div>
        <div>
          <div className="text-[11px] text-muted-foreground">平仓 · 成功</div>
          <div className="text-[11px] font-medium tabular-nums">{stats.closeOk}</div>
        </div>
        <div>
          <div className="text-[11px] text-muted-foreground">平仓 · 失败</div>
          <div className="text-[11px] font-medium tabular-nums">{stats.closeFail}</div>
        </div>
      </div>
    </DashboardSectionCard>
  )
}

function AccountMetricsCard({ snap }: { snap: DashboardPayload }) {
  return (
    <DashboardSectionCard title="账户与盈亏">
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px] sm:grid-cols-3">
        <div>
          <div className="text-muted-foreground">总盈亏（相对基准）</div>
          <div
            className={cn(
              "font-medium tabular-nums",
              snap.pnlVsBaselineUsdt != null && snap.pnlVsBaselineUsdt >= 0
                ? "text-emerald-600 dark:text-emerald-400"
                : snap.pnlVsBaselineUsdt != null
                  ? "text-red-600 dark:text-red-400"
                  : "text-foreground",
            )}
          >
            {snap.pnlVsBaselineUsdt != null ? `${fmtUsd(snap.pnlVsBaselineUsdt)} USDT` : "—"}
          </div>
          <div className="text-[10px] text-muted-foreground">
            初始 {fmtUsd(snap.baselineEquityUsdt ?? null)} → 当前 {fmtUsd(snap.equityUsdt ?? null)}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">未实现盈亏</div>
          <div className="font-medium tabular-nums text-foreground">{fmtUsd(snap.uplUsdt ?? null)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">当前权益（USDT）</div>
          <div className="font-medium tabular-nums text-foreground">{fmtUsd(snap.equityUsdt ?? null)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">可用资金</div>
          <div className="font-medium tabular-nums text-foreground">{fmtUsd(snap.availEqUsdt ?? null)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">占用资金</div>
          <div className="font-medium tabular-nums text-foreground">
            {fmtUsd(snap.marginUsedUsdt ?? null)}
          </div>
        </div>
      </div>
    </DashboardSectionCard>
  )
}

function PositionsCard({ positions }: { positions: PositionRow[] }) {
  return (
    <DashboardSectionCard title={`持仓（${positions.length}）`}>
      {positions.length === 0 ? (
        <div className="rounded-md border border-border/60 bg-muted/10 px-2 py-2 text-[11px] text-muted-foreground">
          无 SWAP 持仓
        </div>
      ) : (
        <ul className="max-h-[140px] space-y-1.5 overflow-y-auto rounded-md border border-border/60 bg-muted/10 px-2 py-2 text-[11px]">
          {positions.map((p, i) => (
            <li
              key={`${String(p.instId ?? "x")}-${String(p.posSide ?? "")}-${i}`}
              className="flex flex-wrap gap-x-2 gap-y-0.5"
            >
              <span className="font-medium text-foreground">{p.instId ?? "—"}</span>
              <span className="text-muted-foreground">{String(p.posSide ?? "")}</span>
              <span className="tabular-nums">张数 {p.pos ?? "—"}</span>
              <span className="tabular-nums text-muted-foreground">upl {fmtUsd(Number(p.upl))}</span>
              <span className="tabular-nums text-muted-foreground">保证金 {fmtUsd(Number(p.margin))}</span>
              <span className="text-muted-foreground">{p.lever != null ? `${p.lever}x` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </DashboardSectionCard>
  )
}

function EquityCurveCard({ series }: { series: EquityPoint[] }) {
  return (
    <DashboardSectionCard title="资金曲线（本地采样）" contentClassName="space-y-0">
      <EquitySparkline series={series} />
    </DashboardSectionCard>
  )
}

function SkippedHintCard() {
  return (
    <DashboardSectionCard title="OKX 未启用">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        请在配置中心启用「OKX 永续」并填写 API，即可查看资金与持仓。本地仍会保留已采样的资金曲线；下方 Agent 统计不依赖 OKX。
      </p>
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
  const strategyRunning = baselinePresent && sincePresent
  const strategyEnded = !baselinePresent && !sincePresent

  const simBadge =
    snap?.simulated === true ? (
      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
        模拟盘
      </span>
    ) : null

  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-2",
        embedded ? "px-1 pt-0 pb-2" : "border-b border-border/60 px-3 pt-3 pb-2",
      )}
    >
      <DashboardToolbarCard
        embedded={embedded}
        simulated={snap?.simulated}
        simBadge={simBadge}
        strategyRunning={strategyRunning}
        strategyEnded={strategyEnded}
        loading={loading}
        equityUsdt={snap?.equityUsdt}
        onToggleStrategy={() => void (strategyRunning ? endStrategyRange() : startStrategyRange())}
        onEndStrategy={() => void endStrategyRange()}
        onRefresh={() => void load()}
      />

      {err ? (
        <Card size="sm" className="gap-0 border-destructive/40 py-0 shadow-none ring-destructive/25">
          <CardContent className="px-3 py-2.5">
            <p className="text-[11px] text-destructive">{err}</p>
          </CardContent>
        </Card>
      ) : null}

      {skipped ? <SkippedHintCard /> : null}

      {at ? <AgentToolStatsCard stats={at} /> : null}

      {showLive && snap ? (
        <>
          <AccountMetricsCard snap={snap} />
          <PositionsCard positions={positions} />
        </>
      ) : null}

      <EquityCurveCard series={series} />
    </div>
  )
}
