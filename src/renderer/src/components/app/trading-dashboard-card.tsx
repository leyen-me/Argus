import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { AlertCircle, PencilLine, Pause, Play } from "lucide-react"

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

type DashboardConfig = {
  promptStrategy?: string
  defaultSymbol?: string
  symbols?: SymbolOption[]
  dashboardStrategyRanges?: Record<
    string,
    {
      baselineEquityUsdt?: number | null
      statsSince?: string | null
    }
  >
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

function buildNextStrategyRanges(
  config: DashboardConfig | null,
  updater: (
    current: Record<
      string,
      {
        baselineEquityUsdt?: number | null
        statsSince?: string | null
      }
    >,
    strategyId: string,
  ) => Record<
    string,
    {
      baselineEquityUsdt?: number | null
      statsSince?: string | null
    }
  >,
) {
  const strategyId = resolveStrategyId(config)
  const current = config?.dashboardStrategyRanges && typeof config.dashboardStrategyRanges === "object"
    ? { ...config.dashboardStrategyRanges }
    : {}
  return updater(current, strategyId)
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
  strategyRunning,
  loading,
  disabled,
  statusText,
  onToggle,
  strategyEditDisabled,
  strategyEditBusy,
  strategyEditTitle,
  onStrategyEditClick,
}: {
  strategyName: string
  symbolLabel: string
  simulated: boolean
  strategyRunning: boolean
  loading: boolean
  disabled: boolean
  statusText: string
  onToggle: () => void
  strategyEditDisabled: boolean
  strategyEditBusy: boolean
  strategyEditTitle: string
  onStrategyEditClick: () => void
}) {
  return (
    <Card className="gap-0 py-0 shadow-none ring-border/60">
      <CardContent className="flex h-full flex-col px-6 py-5">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-nowrap items-center gap-1">
              <p className="m-0 min-w-0 flex-1 truncate text-[2rem] font-semibold leading-none tracking-tight text-foreground">
                {strategyName}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-10 shrink-0 text-muted-foreground hover:text-foreground"
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
  strategyRunning: _strategyRunning,
}: {
  snap: DashboardPayload | null
  strategyRunning: boolean
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

function EquityCurveChart({ series, strategyRunning }: { series: EquityPoint[]; strategyRunning: boolean }) {
  const w = 1000
  const h = 300
  const padX = 24
  const padY = 20

  if (!series.length) {
    return (
      <div className="flex h-full w-full min-h-[220px] flex-1 items-center justify-center rounded-2xl border border-dashed border-border/60 bg-muted/20 text-center text-sm text-muted-foreground">
        {strategyRunning ? "当前策略暂无净值采样数据" : "启动当前策略后开始绘制净值曲线"}
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
  const lineD = buildSmoothLinePath(points)
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

        <path
          d={lineD}
          fill="none"
          stroke="var(--chart-2)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          opacity="0.98"
        />
      </svg>
    </div>
  )
}

function EquityCurveCard({ series, strategyRunning }: { series: EquityPoint[]; strategyRunning: boolean }) {
  return (
    <Card className="min-h-0 gap-0 bg-transparent py-0 shadow-none ring-border/60">
      <CardContent className="flex min-h-0 flex-1 flex-col px-5 py-5">
        <EquityCurveChart series={series} strategyRunning={strategyRunning} />
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

  const startStrategyRange = useCallback(async () => {
    const eq = snap?.equityUsdt
    if (eq == null || !Number.isFinite(eq)) {
      setErr("需要当前权益以设为初始资金，请确认已连接 OKX 并刷新。")
      return
    }
    try {
      setErr(null)
      const statsSince = new Date().toISOString()
      const dashboardStrategyRanges = buildNextStrategyRanges(config, (current, strategyId) => ({
        ...current,
        [strategyId]: {
          baselineEquityUsdt: eq,
          statsSince,
        },
      }))
      await window.argus?.saveConfig?.({ dashboardStrategyRanges })
      window.dispatchEvent(new CustomEvent(ARGUS_APP_CONFIG_CHANGED))
      void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [config, load, snap?.equityUsdt])

  const endStrategyRange = useCallback(async () => {
    try {
      setErr(null)
      const dashboardStrategyRanges = buildNextStrategyRanges(config, (current, strategyId) => {
        const next = { ...current }
        delete next[strategyId]
        return next
      })
      await window.argus?.saveConfig?.({ dashboardStrategyRanges })
      window.dispatchEvent(new CustomEvent(ARGUS_APP_CONFIG_CHANGED))
      void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [config, load])

  const onPromptStrategyChange = useCallback(
    async (nextId: string): Promise<boolean> => {
      const cur = resolveStrategyId(config)
      if (nextId === cur || !window.argus?.saveConfig) return false
      const baselinePresent =
        snap?.baselineEquityUsdt != null && Number.isFinite(Number(snap.baselineEquityUsdt))
      const sincePresent =
        typeof snap?.dashboardAgentToolStatsSince === "string" &&
        snap.dashboardAgentToolStatsSince.trim().length > 0
      if (baselinePresent && sincePresent) {
        setErr("请先暂停统计后再切换策略。")
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
    [config, load, snap?.baselineEquityUsdt, snap?.dashboardAgentToolStatsSince],
  )

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
  const strategyEditAccessible = !strategyRunning && !loading && strategyRowsForSelect.length > 0
  const strategyEditTitle = strategyRunning
    ? "统计进行中，请先点「暂停」后再切换策略"
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
    if (strategyRunning) setStrategyPickerOpen(false)
  }, [strategyRunning])

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
          strategyRunning={strategyRunning}
          loading={loading}
          disabled={loading || (!strategyRunning && !canStartStrategy)}
          statusText={statusText}
          onToggle={() => void (strategyRunning ? endStrategyRange() : startStrategyRange())}
          strategyEditDisabled={!strategyEditAccessible}
          strategyEditBusy={strategySwitchBusy}
          strategyEditTitle={strategyEditTitle}
          onStrategyEditClick={() => setStrategyPickerOpen(true)}
        />

        <AccountOverviewCard snap={snap} strategyRunning={strategyRunning} />

        <EquityCurveCard series={series} strategyRunning={strategyRunning} />
      </div>

      <Dialog open={strategyPickerOpen} onOpenChange={setStrategyPickerOpen}>
        <DialogContent showCloseButton className="gap-4 sm:max-w-md">
          <DialogHeader className="text-left">
            <DialogTitle className="text-base font-semibold">切换策略</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              在列表中点选目标策略，再点击「确认切换」。主题色背景与边框表示当前正在使用的策略；光圈表示你当前选中项。
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-[min(320px,calc(100vh-12rem))] pr-4">
            <div className="flex flex-col gap-2 pb-1">
              {strategyRowsForSelect.length === 0 ? (
                <p className="m-0 text-sm text-muted-foreground">暂无策略条目，请先在策略中心创建。</p>
              ) : (
                strategyRowsForSelect.map((row) => {
                  const isCurrent = row.id === currentPromptId
                  const isPicked = pickerChoiceId !== null && row.id === pickerChoiceId
                  return (
                    <button
                      key={row.id}
                      type="button"
                      className={cn(
                        "flex w-full min-h-11 rounded-lg border border-transparent px-3 py-3 text-left text-sm shadow-none transition-colors",
                        "outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                        "hover:bg-accent/80",
                        "disabled:pointer-events-none disabled:opacity-50",
                        isCurrent &&
                          "border-primary/35 border-l-[3px] border-l-primary bg-primary/12 hover:bg-primary/16 dark:bg-primary/18 dark:hover:bg-primary/22",
                        !isCurrent && "bg-muted/30 hover:bg-muted/55",
                        isPicked && "ring-2 ring-primary/40 ring-offset-2 ring-offset-background",
                      )}
                      disabled={strategySwitchBusy}
                      onClick={() => setPickerChoiceId(row.id)}
                    >
                      <span className="wrap-break-word font-semibold text-foreground">
                        {formatPromptStrategyDisplayLabel(row.id, row.label)}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          </ScrollArea>

          <DialogFooter className="-mx-4 -mb-4 flex-col gap-2 border-border/80 sm:flex-row sm:justify-end">
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm">
                取消
              </Button>
            </DialogClose>
            <Button
              type="button"
              size="sm"
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
