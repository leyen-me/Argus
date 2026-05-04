import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { AlertCircle, Check, Pause, PencilLine, Play, RotateCcw, Square } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { ARGUS_APP_CONFIG_CHANGED } from "@/lib/argus-config-modal-events"
import { ARGUS_PROMPT_STRATEGIES_CHANGED } from "@/lib/argus-strategy-modal-events"
import { formatPromptStrategyDisplayLabel } from "@shared/prompt-strategy-display-label"

type EquityPoint = { t: string; equity: number }

type SwapClosePositionStats = {
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
  swapClosePositionStats?: SwapClosePositionStats | null
}

type SymbolOption = {
  label: string
  value: string
}

type StrategyRuntimeStatus = "idle" | "running" | "paused" | "stopped"

type StrategyRuntimeEntry = {
  status?: StrategyRuntimeStatus
  sessionId?: string | null
  startedAt?: string | null
  pausedAt?: string | null
  stoppedAt?: string | null
  lastDecisionAt?: string | null
  lastOrderAt?: string | null
  lastSkipReason?: string | null
}

type DashboardStatsSegment = {
  startedAt?: string | null
  endedAt?: string | null
}

type DashboardConfig = {
  promptStrategy?: string
  defaultSymbol?: string
  symbols?: SymbolOption[]
  dashboardStrategyRanges?: Record<
    string,
    {
      baselineEquityUsdt?: number | null
      statsSince?: string | null
      segments?: DashboardStatsSegment[]
    }
  >
  strategyRuntimeById?: Record<string, StrategyRuntimeEntry>
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

function resolveStrategyId(config: DashboardConfig | null) {
  return typeof config?.promptStrategy === "string" && config.promptStrategy.trim()
    ? config.promptStrategy.trim()
    : ""
}

function newSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID()
    }
  } catch {
    /* ignore */
  }
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function emptyStrategyRuntimeEntry(): StrategyRuntimeEntry {
  return {
    status: "idle",
    sessionId: null,
    startedAt: null,
    pausedAt: null,
    stoppedAt: null,
    lastDecisionAt: null,
    lastOrderAt: null,
    lastSkipReason: null,
  }
}

function resolveStrategyRuntime(config: DashboardConfig | null): StrategyRuntimeEntry {
  const id = resolveStrategyId(config)
  if (!id || !config?.strategyRuntimeById || typeof config.strategyRuntimeById !== "object") {
    return emptyStrategyRuntimeEntry()
  }
  const row = config.strategyRuntimeById[id]
  return row && typeof row === "object"
    ? { ...emptyStrategyRuntimeEntry(), ...row }
    : emptyStrategyRuntimeEntry()
}

function resolveExecutionStatus(config: DashboardConfig | null): StrategyRuntimeStatus {
  const s = resolveStrategyRuntime(config).status
  if (s === "running" || s === "paused" || s === "stopped") return s
  return "idle"
}

function normalizeStatsSegments(segments: DashboardStatsSegment[] | null | undefined): Array<{ startedAt: string; endedAt: string | null }> {
  if (!Array.isArray(segments)) return []
  return segments
    .map((seg) => {
      const startedAt =
        seg && typeof seg.startedAt === "string" && seg.startedAt.trim() && Number.isFinite(Date.parse(seg.startedAt.trim()))
          ? seg.startedAt.trim()
          : ""
      if (!startedAt) return null
      const endedAt =
        seg && typeof seg.endedAt === "string" && seg.endedAt.trim() && Number.isFinite(Date.parse(seg.endedAt.trim()))
          ? seg.endedAt.trim()
          : null
      return { startedAt, endedAt }
    })
    .filter((seg): seg is { startedAt: string; endedAt: string | null } => Boolean(seg))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
}

function resolveCurrentDashboardRange(config: DashboardConfig | null) {
  const id = resolveStrategyId(config)
  if (!id || !config?.dashboardStrategyRanges || typeof config.dashboardStrategyRanges !== "object") return null
  const row = config.dashboardStrategyRanges[id]
  return row && typeof row === "object" ? row : null
}

function buildNextStrategyRanges(
  config: DashboardConfig | null,
  updater: (
    current: Record<
      string,
      {
        baselineEquityUsdt?: number | null
        statsSince?: string | null
        segments?: DashboardStatsSegment[]
      }
    >,
    strategyId: string,
  ) => Record<
    string,
    {
      baselineEquityUsdt?: number | null
      statsSince?: string | null
      segments?: DashboardStatsSegment[]
    }
  >,
) {
  const strategyId = resolveStrategyId(config)
  const current = config?.dashboardStrategyRanges && typeof config.dashboardStrategyRanges === "object"
    ? { ...config.dashboardStrategyRanges }
    : {}
  return updater(current, strategyId)
}

function emptyDashboardRangeEntry() {
  return {
    baselineEquityUsdt: null,
    statsSince: null,
    segments: [] as DashboardStatsSegment[],
  }
}

function closeOpenStatsSegments(segments: Array<{ startedAt: string; endedAt: string | null }>, endedAt: string) {
  let closed = false
  return segments.map((seg, idx) => {
    const isLast = idx === segments.length - 1
    if (!closed && isLast && !seg.endedAt) {
      closed = true
      return { ...seg, endedAt }
    }
    return seg
  })
}

function buildSmoothLinePath(points: Array<{ x: number; y: number }>) {
  if (!points.length) return ""
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? p2
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`
  }
  return d
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
  executionStatusLabel,
  statsStatusLabel,
  loading,
  statusText,
  strategyEditDisabled,
  strategyEditBusy,
  strategyEditTitle,
  onStrategyEditClick,
  onStartExecution,
  onPauseExecution,
  onResumeExecution,
  onStopExecution,
  canStartExecution,
  canPauseExecution,
  canResumeExecution,
  canStopExecution,
}: {
  strategyName: string
  symbolLabel: string
  simulated: boolean
  executionStatusLabel: string
  statsStatusLabel: string
  loading: boolean
  statusText: string
  strategyEditDisabled: boolean
  strategyEditBusy: boolean
  strategyEditTitle: string
  onStrategyEditClick: () => void
  onStartExecution: () => void
  onPauseExecution: () => void
  onResumeExecution: () => void
  onStopExecution: () => void
  canStartExecution: boolean
  canPauseExecution: boolean
  canResumeExecution: boolean
  canStopExecution: boolean
}) {
  const busy = loading
  return (
    <Card className="gap-0 py-0 shadow-none ring-border/60">
      <CardContent className="flex h-full flex-col px-6 py-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-nowrap items-center gap-1">
              <p className="m-0 min-w-0 flex-1 truncate text-[2rem] font-semibold leading-none tracking-tight text-foreground">
                {strategyName}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-10 shrink-0 rounded-xl border border-transparent text-muted-foreground transition-colors hover:border-border/50 hover:bg-muted/40 hover:text-foreground disabled:opacity-40"
                aria-label="切换策略"
                title={strategyEditTitle}
                disabled={strategyEditDisabled || strategyEditBusy}
                onClick={onStrategyEditClick}
              >
                <PencilLine className="size-5" aria-hidden />
              </Button>
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
            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] leading-snug text-muted-foreground">
              <span className="font-medium text-foreground/80">执行</span>
              <span>{executionStatusLabel}</span>
              <span className="mx-1 text-border" aria-hidden>
                |
              </span>
              <span className="font-medium text-foreground/80">统计</span>
              <span>{statsStatusLabel}</span>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap justify-end gap-2 lg:max-w-md">
              <Button
                type="button"
                size="sm"
                className="h-9 min-w-22 gap-1.5 px-3 shadow-none"
                disabled={busy || !canStartExecution}
                title="允许当前策略在 K 线收盘时自动运行 Agent（仍受右侧面板总开关与其它前置条件约束）"
                onClick={onStartExecution}
              >
                <Play className="size-3.5" aria-hidden />
                启动策略
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-9 min-w-18 gap-1.5 px-3 shadow-none"
                disabled={busy || !canPauseExecution}
                title="暂停自动执行，可稍后恢复"
                onClick={onPauseExecution}
              >
                <Pause className="size-3.5" aria-hidden />
                暂停
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-9 min-w-18 gap-1.5 px-3 shadow-none"
                disabled={busy || !canResumeExecution}
                title="从暂停恢复为运行中"
                onClick={onResumeExecution}
              >
                <RotateCcw className="size-3.5" aria-hidden />
                恢复
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-9 min-w-18 gap-1.5 px-3 shadow-none"
                disabled={busy || !canStopExecution}
                title="结束本次执行会话；不会自动平仓"
                onClick={onStopExecution}
              >
                <Square className="size-3.5" aria-hidden />
                停止
              </Button>
          </div>
        </div>

        <div className="mt-5 flex items-center gap-2 rounded-xl border border-border/60 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
          <AlertCircle className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 leading-snug">{statusText}</span>
        </div>
      </CardContent>
    </Card>
  )
}

function AccountOverviewCard({
  snap,
}: {
  snap: DashboardPayload | null
}) {
  const winRate = snap?.swapClosePositionStats?.winRate ?? null
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
  )
}

function pointInSegment(t: string, seg: { startedAt: string; endedAt: string | null }) {
  const ms = Date.parse(t)
  if (!Number.isFinite(ms)) return false
  const startMs = Date.parse(seg.startedAt)
  const endMs = seg.endedAt ? Date.parse(seg.endedAt) : Number.POSITIVE_INFINITY
  return Number.isFinite(startMs) && ms >= startMs && ms <= endMs
}

function EquityCurveChart({
  series,
  hasStatsSession,
  statsSegments,
}: {
  series: EquityPoint[]
  hasStatsSession: boolean
  statsSegments: Array<{ startedAt: string; endedAt: string | null }>
}) {
  const w = 1000
  const h = 300
  const padX = 24
  const padY = 20

  if (!series.length) {
    return (
      <div className="flex h-full w-full min-h-[220px] flex-1 items-center justify-center rounded-2xl border border-dashed border-border/60 bg-muted/20 text-center text-sm text-muted-foreground">
        {hasStatsSession ? "当前统计会话暂无净值采样数据" : "启动策略后会自动开始绘制净值曲线"}
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
    return { x, y, t: p.t }
  })
  const normalizedSegments = statsSegments.length ? statsSegments : [{ startedAt: series[0]?.t ?? "", endedAt: series[series.length - 1]?.t ?? null }]
  const linePaths = normalizedSegments
    .map((seg) => buildSmoothLinePath(points.filter((point) => pointInSegment(point.t, seg)).map(({ x, y }) => ({ x, y }))))
    .filter(Boolean)
  const ticks = [max, min + span / 2, min]

  return (
    <div className="h-full w-full min-w-0 flex-1">
      <svg className="h-full w-full" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label="账户净值曲线">
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
            </g>
          )
        })}

        {linePaths.map((lineD, idx) => (
          <path
            key={`seg-${idx}`}
            d={lineD}
            fill="none"
            stroke="var(--chart-2)"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            opacity="0.98"
          />
        ))}
      </svg>
    </div>
  )
}

function EquityCurveCard({
  series,
  hasStatsSession,
  statsSegments,
}: {
  series: EquityPoint[]
  hasStatsSession: boolean
  statsSegments: Array<{ startedAt: string; endedAt: string | null }>
}) {
  return (
    <Card className="min-h-0 gap-0 bg-transparent py-0 shadow-none ring-border/60">
      <CardContent className="flex min-h-0 flex-1 flex-col px-5 py-5">
        <EquityCurveChart series={series} hasStatsSession={hasStatsSession} statsSegments={statsSegments} />
      </CardContent>
    </Card>
  )
}

export function TradingDashboardCard({
  embedded = false,
  active = true,
}: {
  embedded?: boolean
  active?: boolean
}) {
  const [snap, setSnap] = useState<DashboardPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [config, setConfig] = useState<DashboardConfig | null>(null)
  const [strategies, setStrategies] = useState<StrategyMeta[]>([])
  const [strategySwitchBusy, setStrategySwitchBusy] = useState(false)
  const [strategyPickerOpen, setStrategyPickerOpen] = useState(false)
  /** 弹窗内预选的策略 id（需点「确认」才保存） */
  const [pickerChoiceId, setPickerChoiceId] = useState<string | null>(null)

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
    if (!active) return
    const t0 = window.setTimeout(() => void load(), 0)
    const t = window.setInterval(() => void load(), 45_000)
    return () => {
      window.clearTimeout(t0)
      window.clearInterval(t)
    }
  }, [active, load])

  const persistExecutionAndStats = useCallback(
    async (
      nextEntry: StrategyRuntimeEntry,
      rangeUpdater: (
        current: Record<
          string,
          {
            baselineEquityUsdt?: number | null
            statsSince?: string | null
            segments?: DashboardStatsSegment[]
          }
        >,
        strategyId: string,
      ) => Record<
        string,
        {
          baselineEquityUsdt?: number | null
          statsSince?: string | null
          segments?: DashboardStatsSegment[]
        }
      >,
    ) => {
      const strategyId = resolveStrategyId(config)
      if (!strategyId || !window.argus?.saveConfig) {
        setErr("无法保存执行态：请先选用策略。")
        return
      }
      try {
        setErr(null)
        const baseRuntimeMap =
          config?.strategyRuntimeById && typeof config.strategyRuntimeById === "object"
            ? { ...config.strategyRuntimeById }
            : {}
        const strategyRuntimeById = { ...baseRuntimeMap, [strategyId]: nextEntry }
        const dashboardStrategyRanges = buildNextStrategyRanges(config, rangeUpdater)
        const saved = await window.argus.saveConfig({ strategyRuntimeById, dashboardStrategyRanges })
        window.dispatchEvent(new CustomEvent(ARGUS_APP_CONFIG_CHANGED))
        setConfig(saved as DashboardConfig)
        void load()
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    },
    [config, load],
  )

  const startExecution = useCallback(async () => {
    const strategyId = resolveStrategyId(config)
    if (!strategyId) {
      setErr("请先在策略中心创建并选用策略。")
      return
    }
    const prev = resolveStrategyRuntime(config)
    const eq = snap?.equityUsdt
    if (eq == null || !Number.isFinite(eq)) {
      setErr("需要当前权益以设为初始资金，请确认已连接 OKX 并刷新。")
      return
    }
    const now = new Date().toISOString()
    await persistExecutionAndStats(
      {
      ...emptyStrategyRuntimeEntry(),
      status: "running",
      sessionId: newSessionId(),
      startedAt: now,
      pausedAt: null,
      stoppedAt: null,
      lastDecisionAt: prev.lastDecisionAt ?? null,
      lastOrderAt: prev.lastOrderAt ?? null,
      lastSkipReason: null,
      },
      (current, sid) => ({
        ...current,
        [sid]: {
          ...emptyDashboardRangeEntry(),
          baselineEquityUsdt: eq,
          statsSince: now,
          segments: [{ startedAt: now, endedAt: null }],
        },
      }),
    )
  }, [config, persistExecutionAndStats, snap?.equityUsdt])

  const pauseExecution = useCallback(async () => {
    const prev = resolveStrategyRuntime(config)
    const now = new Date().toISOString()
    await persistExecutionAndStats(
      {
        ...prev,
        status: "paused",
        pausedAt: now,
      },
      (current, sid) => {
        const prevRange = current[sid] ?? emptyDashboardRangeEntry()
        const segments = closeOpenStatsSegments(normalizeStatsSegments(prevRange.segments), now)
        return {
          ...current,
          [sid]: {
            ...prevRange,
            statsSince: segments[0]?.startedAt ?? prevRange.statsSince ?? null,
            segments,
          },
        }
      },
    )
  }, [config, persistExecutionAndStats])

  const resumeExecution = useCallback(async () => {
    const prev = resolveStrategyRuntime(config)
    const prevRange = resolveCurrentDashboardRange(config)
    if (!prevRange?.baselineEquityUsdt || !Number.isFinite(Number(prevRange.baselineEquityUsdt))) {
      setErr("当前统计会话缺少初始资金，请重新点击「启动策略」。")
      return
    }
    const now = new Date().toISOString()
    await persistExecutionAndStats(
      {
        ...prev,
        status: "running",
        pausedAt: null,
      },
      (current, sid) => {
        const currentRange = current[sid] ?? emptyDashboardRangeEntry()
        const segments = normalizeStatsSegments(currentRange.segments)
        const nextSegments = segments.length && !segments[segments.length - 1]?.endedAt
          ? segments
          : [...segments, { startedAt: now, endedAt: null }]
        return {
          ...current,
          [sid]: {
            ...currentRange,
            statsSince: nextSegments[0]?.startedAt ?? currentRange.statsSince ?? now,
            segments: nextSegments,
          },
        }
      },
    )
  }, [config, persistExecutionAndStats])

  const stopExecution = useCallback(async () => {
    const prev = resolveStrategyRuntime(config)
    const now = new Date().toISOString()
    await persistExecutionAndStats(
      {
        ...prev,
        status: "stopped",
        stoppedAt: now,
        pausedAt: null,
      },
      (current, sid) => {
        const prevRange = current[sid] ?? emptyDashboardRangeEntry()
        const segments = closeOpenStatsSegments(normalizeStatsSegments(prevRange.segments), now)
        return {
          ...current,
          [sid]: {
            ...prevRange,
            statsSince: segments[0]?.startedAt ?? prevRange.statsSince ?? null,
            segments,
          },
        }
      },
    )
  }, [config, persistExecutionAndStats])

  const onPromptStrategyChange = useCallback(
    async (nextId: string): Promise<boolean> => {
      const cur = resolveStrategyId(config)
      if (nextId === cur || !window.argus?.saveConfig) return false
      const execSt = resolveExecutionStatus(config)
      if (execSt === "running" || execSt === "paused") {
        setErr("当前策略正在运行或已暂停（执行态），请先点「停止」后再切换策略。")
        return false
      }
      setStrategySwitchBusy(true)
      setErr(null)
      try {
        const saved = await window.argus.saveConfig({ promptStrategy: nextId })
        window.dispatchEvent(new CustomEvent(ARGUS_PROMPT_STRATEGIES_CHANGED, { detail: saved }))
        setConfig(saved as DashboardConfig)
        void load()
        return true
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
        return false
      } finally {
        setStrategySwitchBusy(false)
      }
    },
    [config, load],
  )

  const series = useMemo(
    () => (Array.isArray(snap?.equitySeries) ? snap?.equitySeries.filter((item) => Number.isFinite(item?.equity)) : []),
    [snap?.equitySeries],
  )
  const currentRange = resolveCurrentDashboardRange(config)
  const statsSegments = normalizeStatsSegments(currentRange?.segments)
  const baselinePresent = currentRange?.baselineEquityUsdt != null && Number.isFinite(Number(currentRange.baselineEquityUsdt))
  const hasStatsSession = baselinePresent && statsSegments.length > 0
  const executionStatus = resolveExecutionStatus(config)

  const executionStatusLabel =
    executionStatus === "running"
      ? "运行中"
      : executionStatus === "paused"
        ? "已暂停"
        : executionStatus === "stopped"
          ? "已停止"
          : "未启动"

  const statsStatusLabel =
    executionStatus === "running"
      ? hasStatsSession
        ? "统计中"
        : "准备中"
      : executionStatus === "paused"
        ? hasStatsSession
          ? "已暂停"
          : "未开始"
        : executionStatus === "stopped"
          ? hasStatsSession
            ? "已结束"
            : "未开始"
          : "未开始"

  const hasPromptStrategy = Boolean(resolveStrategyId(config))

  const canStartExecution =
    hasPromptStrategy && (executionStatus === "idle" || executionStatus === "stopped")
  const canPauseExecution = executionStatus === "running"
  const canResumeExecution = executionStatus === "paused"
  const canStopExecution = executionStatus === "running" || executionStatus === "paused"

  const strategyName = useMemo(() => resolveStrategyName(config, strategies), [config, strategies])
  const symbolLabel = useMemo(() => resolveSymbolLabel(config), [config])
  const statusText = err
    ? err
    : snap?.skipped
      ? "未启用 OKX 永续，当前账户数据将显示为空。"
      : loading
        ? "正在同步最新账户数据。"
        : executionStatus === "running"
          ? "策略正在运行，本轮统计会自动持续累积。"
          : executionStatus === "paused"
            ? "策略已暂停，统计结果已冻结；恢复后会继续接着当前会话统计。"
            : executionStatus === "stopped"
              ? "策略已停止，本轮统计已结束；下次启动会从新的基线重新统计。"
              : "策略尚未启动；启动后会自动开始本轮统计。"

  const currentPromptId = resolveStrategyId(config)
  const strategyRowsForSelect = useMemo(() => {
    if (!strategies.length) {
      return currentPromptId.trim()
        ? [{ id: currentPromptId, label: formatPromptStrategyDisplayLabel(currentPromptId, "") }]
        : []
    }
    if (!currentPromptId || strategies.some((s) => s.id === currentPromptId)) return strategies
    return [{ id: currentPromptId, label: formatPromptStrategyDisplayLabel(currentPromptId, "") }, ...strategies]
  }, [currentPromptId, strategies])
  const execBlocksStrategySwitch = executionStatus === "running" || executionStatus === "paused"
  const strategyEditAccessible = !execBlocksStrategySwitch && !loading && strategyRowsForSelect.length > 0
  const strategyEditTitle = execBlocksStrategySwitch
    ? "执行态为运行中或已暂停，请先点「停止」后再切换策略"
    : loading
      ? "数据加载完成后可切换"
      : strategyRowsForSelect.length === 0
        ? "暂无策略：请先到策略中心创建"
        : "切换当前使用的策略（将同步顶栏与图表）"

  useEffect(() => {
    if (!strategyPickerOpen) return
    setPickerChoiceId(currentPromptId.trim() ? currentPromptId : null)
  }, [strategyPickerOpen, currentPromptId])

  const pickerConfirmDisabled =
    !pickerChoiceId ||
    pickerChoiceId === currentPromptId ||
    strategySwitchBusy ||
    strategyRowsForSelect.length === 0

  const confirmStrategyPick = useCallback(async () => {
    if (!pickerChoiceId || pickerChoiceId === currentPromptId) return
    const ok = await onPromptStrategyChange(pickerChoiceId)
    if (ok) setStrategyPickerOpen(false)
  }, [currentPromptId, onPromptStrategyChange, pickerChoiceId])

  useEffect(() => {
    if (execBlocksStrategySwitch) setStrategyPickerOpen(false)
  }, [execBlocksStrategySwitch])

  return (
    <>
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
          executionStatusLabel={executionStatusLabel}
          statsStatusLabel={statsStatusLabel}
          loading={loading}
          statusText={statusText}
          strategyEditDisabled={!strategyEditAccessible}
          strategyEditBusy={strategySwitchBusy}
          strategyEditTitle={strategyEditTitle}
          onStrategyEditClick={() => setStrategyPickerOpen(true)}
          onStartExecution={() => void startExecution()}
          onPauseExecution={() => void pauseExecution()}
          onResumeExecution={() => void resumeExecution()}
          onStopExecution={() => void stopExecution()}
          canStartExecution={canStartExecution}
          canPauseExecution={canPauseExecution}
          canResumeExecution={canResumeExecution}
          canStopExecution={canStopExecution}
        />

        <AccountOverviewCard snap={snap} />

        <EquityCurveCard series={series} hasStatsSession={hasStatsSession} statsSegments={statsSegments} />
      </div>

      <Dialog open={strategyPickerOpen} onOpenChange={setStrategyPickerOpen}>
        <DialogContent
          showCloseButton
          className="gap-0 overflow-hidden p-0 sm:max-w-[min(420px,calc(100%-2rem))] sm:rounded-2xl"
        >
          <DialogHeader className="space-y-3 border-b border-border/60 bg-muted/20 px-6 py-5 text-left">
            <DialogTitle className="text-[1.05rem] font-semibold tracking-tight text-foreground">
              切换策略
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2.5 text-[13px] leading-relaxed text-muted-foreground">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground/90">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block size-2 shrink-0 rounded-full bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.22)] dark:shadow-[0_0_0_3px_hsl(var(--primary)/0.35)]" />
                    正在使用
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-md border border-dashed border-muted-foreground/35" />
                    选中待确认
                  </span>
                </div>
              </div>
            </DialogDescription>
          </DialogHeader>

          <div className="px-4 pb-1 pt-4 sm:px-5">
            <ScrollArea className="max-h-[min(288px,42vh)]">
              <div className="flex flex-col gap-2 pr-3 pb-2">
                {strategyRowsForSelect.length === 0 ? (
                  <p className="m-0 rounded-xl border border-dashed border-border/80 bg-muted/15 px-4 py-8 text-center text-[13px] text-muted-foreground">
                    暂无策略，请先到策略中心创建
                  </p>
                ) : (
                  strategyRowsForSelect.map((row) => {
                    const isCurrent = row.id === currentPromptId
                    const isPicked = pickerChoiceId !== null && row.id === pickerChoiceId
                    return (
                      <button
                        key={row.id}
                        type="button"
                        className={cn(
                          "flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left outline-none transition-[background-color,border-color,box-shadow] duration-200",
                          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                          "disabled:pointer-events-none disabled:opacity-45",
                          "border-border/70 bg-card/40 shadow-sm hover:border-border hover:bg-card/90 hover:shadow-md",
                          isCurrent &&
                            "border-primary/25 bg-linear-to-br from-primary/6 via-card/80 to-card/40 dark:from-primary/10 dark:via-card/50",
                          isPicked &&
                            "border-primary/40 bg-card ring-1 ring-primary/20 ring-offset-0 dark:ring-primary/30",
                          isPicked && isCurrent && "ring-primary/25 dark:ring-primary/35",
                        )}
                        disabled={strategySwitchBusy}
                        onClick={() => setPickerChoiceId(row.id)}
                      >
                        <span
                          className={cn(
                            "flex size-2 shrink-0 rounded-full transition-[background-color,box-shadow] duration-200",
                            isCurrent
                              ? "bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.2)] dark:shadow-[0_0_0_3px_hsl(var(--primary)/0.32)]"
                              : "bg-muted-foreground/25",
                          )}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 wrap-break-word text-[13px] font-medium leading-snug tracking-tight text-foreground">
                          {formatPromptStrategyDisplayLabel(row.id, row.label)}
                        </span>
                        {isPicked ? (
                          <span
                            className="flex size-6 shrink-0 items-center justify-center rounded-md border border-primary/25 bg-primary/10 text-primary"
                            aria-hidden
                          >
                            <Check className="size-3.5 stroke-[2.5]" aria-hidden />
                          </span>
                        ) : (
                          <span className="size-6 shrink-0" aria-hidden />
                        )}
                      </button>
                    )
                  })
                )}
              </div>
            </ScrollArea>
          </div>

          <DialogFooter className="mx-0 mb-0 mt-1 flex-row items-center justify-end gap-2 border-t border-border/60 bg-muted/15 px-5 py-4 sm:flex-row">
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm" className="min-w-22 shadow-none">
                取消
              </Button>
            </DialogClose>
            <Button
              type="button"
              size="sm"
              className="min-w-22 shadow-sm"
              disabled={pickerConfirmDisabled}
              onClick={() => void confirmStrategyPick()}
            >
              {strategySwitchBusy ? "保存中…" : "确认切换"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
