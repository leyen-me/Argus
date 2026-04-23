import { ChartSymbolSelect } from "@/components/chart-symbol-select"
import { FishModeOverlay } from "@/components/app/fish-mode-overlay"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

const MULTI_TIMEFRAME_CARDS = [
  { interval: "1D", label: "日线", containerId: "tradingview_chart_1d" },
  { interval: "1H", label: "1 小时", containerId: "tradingview_chart_1h" },
  { interval: "15m", label: "15 分钟", containerId: "tradingview_chart_15m" },
  { interval: "5m", label: "5 分钟", containerId: "tradingview_chart_5m", isPrimary: true },
]

export function ChartPanel() {
  return (
    <Card className="min-h-0 min-w-0 flex-[1.75] gap-0 rounded-none border-0 border-r border-border py-0 shadow-none ring-0">
      <CardHeader className="flex h-10 shrink-0 flex-row items-center justify-between gap-0 border-b border-border px-3 py-0">
        <div className="flex min-w-0 items-center gap-2">
          <CardTitle className="text-xs leading-none font-semibold tracking-wider text-muted-foreground uppercase">
            行情
          </CardTitle>
          <span className="chart-agent-cycle-badge" title="Agent 固定以 5 分钟 K 线收盘触发决策">
            决策周期 5m
          </span>
        </div>
        <div className="flex min-w-0 shrink items-center gap-1.5">
          <ChartSymbolSelect />
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col p-0">
        <div className="chart-wrap">
          <div className="chart-grid">
            {MULTI_TIMEFRAME_CARDS.map((card) => (
              <section
                key={card.containerId}
                className={`chart-grid-card${card.isPrimary ? " chart-grid-card--primary" : ""}`}
              >
                <header className="chart-grid-card-head">
                  <span className="chart-grid-card-interval">{card.interval}</span>
                  <span className="chart-grid-card-label">{card.label}</span>
                </header>
                <div id={card.containerId} className="tradingview-chart" />
              </section>
            ))}
          </div>
          <FishModeOverlay />
        </div>
      </CardContent>
    </Card>
  )
}
