import { ChartSymbolSelect } from "@/components/chart-symbol-select";

export function ChartPanel() {
  return (
    <section className="panel panel-chart" aria-label="TradingView 图表">
      <div className="panel-header">
        <span className="panel-label">行情</span>
        <ChartSymbolSelect />
      </div>
      <div className="chart-wrap">
        <div id="tradingview_chart" className="tradingview-chart" />
      </div>
    </section>
  );
}
