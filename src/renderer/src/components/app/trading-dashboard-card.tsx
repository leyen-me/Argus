import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"

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

export function TradingDashboardCard() {
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

  const setBaselineFromCurrent = useCallback(async () => {
    const eq = snap?.equityUsdt
    if (eq == null || !Number.isFinite(eq)) return
    try {
      await window.argus?.saveConfig?.({ dashboardBaselineEquityUsdt: eq })
      void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [snap?.equityUsdt, load])

  const clearBaseline = useCallback(async () => {
    try {
      await window.argus?.saveConfig?.({ dashboardBaselineEquityUsdt: null })
      void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [load])

  const setAgentStatsSinceNow = useCallback(async () => {
    try {
      await window.argus?.saveConfig?.({ dashboardAgentToolStatsSince: new Date().toISOString() })
      void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [load])

  const clearAgentStatsSince = useCallback(async () => {
    try {
      await window.argus?.saveConfig?.({ dashboardAgentToolStatsSince: null })
      void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [load])

  const skipped = snap?.skipped === true
  const series = Array.isArray(snap?.equitySeries) ? snap!.equitySeries! : []
  const positions = Array.isArray(snap?.positions) ? snap!.positions! : []
  const at = snap?.agentToolStats
  const statsSince = snap?.dashboardAgentToolStatsSince
  const showLive = !skipped && snap?.ok === true

  return (
    <div className="shrink-0 border-b border-border/60 px-3 pt-3 pb-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            仪表盘
          </span>
          {snap?.simulated === true ? (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              模拟盘
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-[11px] shadow-none"
            disabled={loading || snap?.equityUsdt == null}
            title="将当前账户权益（adjEq）存为初始资金，用于计算总盈亏"
            onClick={() => void setBaselineFromCurrent()}
          >
            设为初始资金
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[11px] text-muted-foreground shadow-none"
            disabled={loading}
            onClick={() => void clearBaseline()}
          >
            清除基准
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-[11px] shadow-none"
            disabled={loading}
            title="仅统计此时间点之后的 Agent 回合（换策略时可重置，不含手动单）"
            onClick={() => void setAgentStatsSinceNow()}
          >
            Agent 统计起点
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[11px] text-muted-foreground shadow-none"
            disabled={loading}
            onClick={() => void clearAgentStatsSince()}
          >
            清除统计起点
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 px-2.5 text-[11px] shadow-none"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? "刷新中…" : "刷新"}
          </Button>
        </div>
      </div>

      {err ? <p className="mt-2 text-[11px] text-destructive">{err}</p> : null}

      {skipped ? (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          请在配置中心启用「OKX 永续」并填写 API，即可查看资金与持仓。本地仍会保留已采样的资金曲线；下方 Agent 统计不依赖 OKX。
        </p>
      ) : null}

      {at ? (
        <div className="mt-2 space-y-1.5 rounded-md border border-border/70 bg-muted/15 px-2.5 py-2 text-[11px]">
          <div className="font-medium text-foreground">Agent 工具结果（仅本项目）</div>
          <p className="m-0 text-[10px] leading-relaxed text-muted-foreground">
            来自本机 SQLite 中各次收盘 Agent 的{" "}
            <code className="rounded bg-muted px-0.5">open_position</code> /{" "}
            <code className="rounded bg-muted px-0.5">close_position</code>{" "}
            返回值，不包含您在 OKX 其他端的手动单，也<strong>不是</strong>按盈亏定义的胜率。
          </p>
          <div className="text-[10px] text-muted-foreground">
            {statsSince
              ? `统计范围：自 ${statsSince.replace("T", " ").slice(0, 19)} UTC 起`
              : "统计范围：全部历史回合"}
            {" · "}
            含工具 trace 的回合 {at.sessionsWithTrace} 个
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div>
              <div className="text-muted-foreground">开仓 · 成功</div>
              <div className="font-medium tabular-nums">{at.openOk}</div>
            </div>
            <div>
              <div className="text-muted-foreground">开仓 · 失败</div>
              <div className="font-medium tabular-nums">{at.openFail}</div>
            </div>
            <div>
              <div className="text-muted-foreground">平仓 · 成功</div>
              <div className="font-medium tabular-nums">{at.closeOk}</div>
            </div>
            <div>
              <div className="text-muted-foreground">平仓 · 失败</div>
              <div className="font-medium tabular-nums">{at.closeFail}</div>
            </div>
          </div>
        </div>
      ) : null}

      {showLive ? (
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px] sm:grid-cols-3">
            <div>
              <div className="text-muted-foreground">总盈亏（相对基准）</div>
              <div
                className={`font-medium tabular-nums ${
                  snap.pnlVsBaselineUsdt != null && snap.pnlVsBaselineUsdt >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : snap.pnlVsBaselineUsdt != null
                      ? "text-red-600 dark:text-red-400"
                      : "text-foreground"
                }`}
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
              <div className="text-[10px] text-muted-foreground">imr 或 权益−可用</div>
            </div>
          </div>

          <div>
            <div className="mb-1 text-[10px] font-medium text-muted-foreground">
              持仓（{positions.length}）
            </div>
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
          </div>
        </div>
      ) : null}

      <div className="mt-2">
        <div className="mb-1 text-[10px] font-medium text-muted-foreground">资金曲线（本地采样）</div>
        <EquitySparkline series={series} />
      </div>
    </div>
  )
}
