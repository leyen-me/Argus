import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react"
import { AlertCircle, Pause, Play } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

type EquityPoint = { t: string; equity: number }

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
  dashboardAgentToolStatsSince?: string | null
  equitySeries?: EquityPoint[]
  swapCloseFillStats?: SwapCloseFillStats | null
}

type SymbolOption = {
  label: string
  value: string
}

type DashboardConfig = {
  promptStrategy?: string
  defaultSymbol?: string
  symbols?: SymbolOption[]
}

type StrategyMeta = {
  id: string
  label: string
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

function toneForSignedValue(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "text-foreground"
  return v >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
}

function resolveStrategyName(config: DashboardConfig | null, rows: StrategyMeta[]) {
  const id = typeof config?.promptStrategy === "string" ? config.promptStrategy.trim() : ""
  if (!id) return "未命名策略"
  const matched = rows.find((row) => row.id === id)
  return matched?.label?.trim() || matched?.id || id
}

function resolveSymbolLabel(config: DashboardConfig | null) {
  const current = typeof config?.defaultSymbol === "string" ? config.defaultSymbol.trim() : ""
  const options = Array.isArray(config?.symbols) ? config.symbols : []
  const matched = options.find((item) => item?.value === current)
  return matched?.label?.trim() || current || "未选择品种"
}

function MetricCard({
  label,
  value,
  desc,
  valueClassName,
}: {
  label: string
  value: ReactNode
  desc?: ReactNode
  valueClassName?: string
}) {
  return (
    <Card className="h-full gap-0 py-0 shadow-none ring-border/60">
      <CardContent className="flex h-full flex-col justify-between gap-4 px-4 py-4">
        <div className="text-[11px] font-medium tracking-wide text-muted-foreground">{label}</div>
        <div className={cn("space-y-1", valueClassName)}>
          {typeof value === "string" ? (
            <div className="text-[1.6rem] leading-none font-semibold tracking-tight tabular-nums">{value}</div>
          ) : (
            value
          )}
        </div>
        <div className="min-h-4 text-[11px] text-muted-foreground">{desc ?? <span>&nbsp;</span>}</div>
      </CardContent>
    </Card>
  )
}

function StrategyInfoCard({
  strategyName,
  symbolLabel,
  simulated,
  strategyRunning,
  loading,
  disabled,
  statusText,
  onToggle,
}: {
  strategyName: string
  symbolLabel: string
  simulated: boolean
  strategyRunning: boolean
  loading: boolean
  disabled: boolean
  statusText: string
  onToggle: () => void
}) {
  return (
    <Card className="gap-0 py-0 shadow-none ring-border/60">
      <CardContent className="flex h-full flex-col px-6 py-5">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0 flex-1">
            <div className="text-[2rem] leading-none font-semibold tracking-tight text-foreground">
              {strategyName}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="h-7 rounded-full px-3 text-xs font-medium">
                {symbolLabel}
              </Badge>
              {simulated ? (
                <Badge
                  variant="outline"
                  className="h-7 rounded-full border-amber-500/25 bg-amber-500/10 px-3 text-xs font-medium text-amber-700 dark:text-amber-300"
                >
                  模拟盘
                </Badge>
              ) : null}
            </div>
          </div>

          <Button
            type="button"
            size="lg"
            variant={strategyRunning ? "secondary" : "default"}
            className="h-11 min-w-28 gap-2 px-4 text-sm shadow-none"
            disabled={disabled}
            title={
              strategyRunning
                ? "暂停后会清空当前统计范围与初始资金。"
                : "启动后会以当前权益作为初始资金，并开始统计胜率和净值曲线。"
            }
            aria-pressed={strategyRunning}
            onClick={onToggle}
          >
            {strategyRunning ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
            {loading ? "更新中…" : strategyRunning ? "暂停" : "启动"}
          </Button>
        </div>

        <div className="mt-5 flex items-center gap-2 rounded-xl border border-border/60 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
          <AlertCircle className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{statusText}</span>
        </div>
      </CardContent>
    </Card>
  )
}

function AccountOverviewCard({
  snap,
  strategyRunning,
}: {
  snap: DashboardPayload | null
  strategyRunning: boolean
}) {
  const winRate = snap?.swapCloseFillStats?.winRate ?? null
  const totalPnl = snap?.pnlVsBaselineUsdt ?? null
  const baseline = snap?.baselineEquityUsdt ?? null
  const totalPnlRatio =
    totalPnl != null && baseline != null && Number.isFinite(totalPnl) && Number.isFinite(baseline) && baseline > 0
      ? totalPnl / baseline
      : null
  const unrealizedPnl = snap?.uplUsdt ?? null
  const avail = snap?.availEqUsdt ?? null
  const equity = snap?.equityUsdt ?? null
  const freeRatio =
    avail != null && equity != null && Number.isFinite(avail) && Number.isFinite(equity) && equity > 0
      ? avail / equity
      : null

  return (
    <Card className="gap-0 py-0 shadow-none ring-border/60">
      <CardHeader className="gap-1 border-b border-border/60 px-5 py-4">
        <CardTitle className="text-base font-semibold">账户模块</CardTitle>
        <CardDescription>
          {strategyRunning ? "聚合展示当前策略范围内的核心账户指标。" : "启动策略后会按当前权益生成基准。"}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-5 py-5">
        <div className="grid grid-cols-4 gap-3">
          <MetricCard
            label="胜率"
            value={
              <div
                className={cn(
                  "text-[1.6rem] leading-none font-semibold tracking-tight tabular-nums",
                  toneForSignedValue(winRate != null ? winRate - 0.5 : null),
                )}
              >
                {fmtPct(winRate)}
              </div>
            }
          />

          <MetricCard
            label="总盈亏"
            value={
              <div className="space-y-1">
                <div className={cn("text-[1.6rem] leading-none font-semibold tracking-tight tabular-nums", toneForSignedValue(totalPnl))}>
                  {fmtSignedUsd(totalPnl)}
                </div>
                <div className={cn("text-sm font-medium tabular-nums", toneForSignedValue(totalPnl))}>
                  {fmtPct(totalPnlRatio)}
                </div>
              </div>
            }
            desc={baseline != null ? `初始 ${fmtUsd(baseline)} USDT` : "初始 —"}
          />

          <MetricCard
            label="未实现盈亏"
            value={
              <div className={cn("text-[1.6rem] leading-none font-semibold tracking-tight tabular-nums", toneForSignedValue(unrealizedPnl))}>
                {fmtSignedUsd(unrealizedPnl)}
              </div>
            }
          />

          <MetricCard
            label="可用资金"
            value={
              <div className="space-y-1">
                <div className="text-[1.6rem] leading-none font-semibold tracking-tight tabular-nums">
                  {fmtUsd(avail)}
                </div>
              </div>
            }
            desc={`空闲 ${fmtPct(freeRatio)}`}
          />
        </div>
      </CardContent>
    </Card>
  )
}

function EquityCurveChart({ series }: { series: EquityPoint[] }) {
  const gradId = useId().replace(/:/g, "")
  const w = 1000
  const h = 300
  const padX = 24
  const padY = 20

  if (!series.length) {
    return (
      <div className="flex h-full min-h-[220px] items-center justify-center rounded-2xl border border-dashed border-border/60 bg-muted/20 text-center text-sm text-muted-foreground">
        暂无账户净值采样数据
      </div>
    )
  }

  const vals = series.map((p) => p.equity)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min || 1
  const innerW = w - padX * 2
  const innerH = h - padY * 2
  const points = series.map((p, idx) => {
    const x = padX + (innerW * idx) / Math.max(1, series.length - 1)
    const y = padY + innerH - (innerH * (p.equity - min)) / span
    return { x, y }
  })
  const lineD = points.map((pt, idx) => `${idx === 0 ? "M" : "L"} ${pt.x} ${pt.y}`).join(" ")
  const last = points[points.length - 1]
  const areaD = `${lineD} L ${last?.x ?? padX} ${padY + innerH} L ${padX} ${padY + innerH} Z`
  const ticks = [max, min + span / 2, min]

  return (
    <div className="h-full rounded-2xl border border-border/60 bg-linear-to-b from-primary/8 via-background to-background p-3 ring-1 ring-inset ring-border/25">
      <svg className="h-full w-full" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label="账户净值曲线">
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.22} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
          </linearGradient>
        </defs>

        {ticks.map((tick) => {
          const y = padY + innerH - (innerH * (tick - min)) / span
          return (
            <g key={tick}>
              <line
                x1={padX}
                y1={y}
                x2={w - padX}
                y2={y}
                stroke="currentColor"
                strokeOpacity="0.08"
                strokeDasharray="5 5"
              />
              <text
                x={w - padX}
                y={y - 6}
                textAnchor="end"
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {fmtUsd(tick)}
              </text>
            </g>
          )
        })}

        <path d={areaD} fill={`url(#${gradId})`} className="text-primary" />
        <path
          d={lineD}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          className="text-primary"
        />
        {last ? <circle cx={last.x} cy={last.y} r="5" className="fill-primary stroke-background" strokeWidth="3" /> : null}
      </svg>
    </div>
  )
}

function EquityCurveCard({
  series,
  sinceIso,
}: {
  series: EquityPoint[]
  sinceIso?: string | null
}) {
  const first = series[0]?.equity
  const last = series[series.length - 1]?.equity
  const delta =
    first != null && last != null && Number.isFinite(first) && Number.isFinite(last) ? last - first : null
  const latestAt = series.length ? fmtSampleTime(series[series.length - 1]?.t) : null
  const scopeLabel = sinceIso ? `统计起点 ${fmtSampleTime(sinceIso) ?? sinceIso}` : "展示最近本地采样"

  return (
    <Card className="min-h-0 gap-0 py-0 shadow-none ring-border/60">
      <CardHeader className="border-b border-border/60 px-5 py-4">
        <div className="flex items-end justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base font-semibold">账户净值曲线</CardTitle>
            <CardDescription>{scopeLabel}</CardDescription>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>最新采样 {latestAt ?? "—"}</div>
            <div className={cn("mt-1 font-medium tabular-nums", toneForSignedValue(delta))}>
              区间变化 {fmtSignedUsd(delta)}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 px-5 py-5">
        <EquityCurveChart series={series} />
      </CardContent>
    </Card>
  )
}

export function TradingDashboardCard({ embedded = false }: { embedded?: boolean }) {
  const [snap, setSnap] = useState<DashboardPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [config, setConfig] = useState<DashboardConfig | null>(null)
  const [strategies, setStrategies] = useState<StrategyMeta[]>([])

  const load = useCallback(async () => {
    if (!window.argus?.getDashboard) return
    setLoading(true)
    setErr(null)

    try {
      const [dashboardPayload, rawConfig, rawStrategies] = await Promise.all([
        window.argus.getDashboard(),
        window.argus.getConfig ? window.argus.getConfig() : Promise.resolve({}),
        window.argus.listPromptStrategiesMeta ? window.argus.listPromptStrategiesMeta() : Promise.resolve([]),
      ])

      const nextSnap = dashboardPayload as DashboardPayload
      setSnap(nextSnap)
      setConfig((rawConfig ?? {}) as DashboardConfig)
      setStrategies(Array.isArray(rawStrategies) ? (rawStrategies as StrategyMeta[]) : [])

      if (nextSnap && nextSnap.ok === false && typeof nextSnap.message === "string") {
        setErr(nextSnap.message)
      }
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
  }, [load, snap?.equityUsdt])

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

  const series = useMemo(
    () => (Array.isArray(snap?.equitySeries) ? snap?.equitySeries.filter((item) => Number.isFinite(item?.equity)) : []),
    [snap?.equitySeries],
  )
  const baselinePresent =
    snap?.baselineEquityUsdt != null && Number.isFinite(Number(snap.baselineEquityUsdt))
  const sincePresent =
    typeof snap?.dashboardAgentToolStatsSince === "string" && snap.dashboardAgentToolStatsSince.trim().length > 0
  const strategyRunning = baselinePresent && sincePresent
  const canStartStrategy = snap?.equityUsdt != null && Number.isFinite(Number(snap.equityUsdt))
  const strategyName = useMemo(() => resolveStrategyName(config, strategies), [config, strategies])
  const symbolLabel = useMemo(() => resolveSymbolLabel(config), [config])
  const statusText = err
    ? err
    : snap?.skipped
      ? "未启用 OKX 永续，当前账户数据将显示为空。"
      : loading
        ? "正在同步最新账户数据。"
        : strategyRunning
          ? "策略已启动，胜率、盈亏和净值曲线都按当前范围统计。"
          : "策略尚未启动，点击右侧按钮即可开始统计。"

  return (
    <div
      className={cn(
        "grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-4",
        embedded ? "px-0 py-0" : "px-3 py-3",
      )}
    >
      <StrategyInfoCard
        strategyName={strategyName}
        symbolLabel={symbolLabel}
        simulated={snap?.simulated === true}
        strategyRunning={strategyRunning}
        loading={loading}
        disabled={loading || (!strategyRunning && !canStartStrategy)}
        statusText={statusText}
        onToggle={() => void (strategyRunning ? endStrategyRange() : startStrategyRange())}
      />

      <AccountOverviewCard snap={snap} strategyRunning={strategyRunning} />

      <EquityCurveCard series={series} sinceIso={snap?.dashboardAgentToolStatsSince} />
    </div>
  )
}
