import { ChartIntervalSelect } from "@/components/chart-interval-select"
import { ChartSymbolSelect } from "@/components/chart-symbol-select"
import { FishModeOverlay } from "@/components/app/fish-mode-overlay"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export function ChartPanel() {
  return (
    <Card className="min-h-0 min-w-0 flex-[1.75] gap-0 rounded-none border-0 border-r border-border py-0 shadow-none ring-0">
      <CardHeader className="flex h-10 shrink-0 flex-row items-center justify-between gap-0 border-b border-border px-3 py-0">
        <CardTitle className="text-xs leading-none font-semibold tracking-wider text-muted-foreground uppercase">
          行情
        </CardTitle>
        <div className="flex min-w-0 shrink items-center gap-1.5">
          <ChartIntervalSelect />
          <ChartSymbolSelect />
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col p-0">
        <div className="chart-wrap">
          <div id="tradingview_chart" className="tradingview-chart" />
          <FishModeOverlay />
        </div>
      </CardContent>
    </Card>
  )
}
