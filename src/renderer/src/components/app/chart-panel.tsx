import { useCallback, useState } from "react";
import { ChartSymbolSelect } from "@/components/chart-symbol-select";
import { FishModeOverlay } from "@/components/app/fish-mode-overlay";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Camera, EyeOff, Loader2 } from "lucide-react";

const MULTI_TIMEFRAME_CARDS = [
  { interval: "1D", label: "日线", containerId: "tradingview_chart_1d" },
  { interval: "1H", label: "1 小时", containerId: "tradingview_chart_1h" },
  { interval: "15m", label: "15 分钟", containerId: "tradingview_chart_15m" },
  { interval: "5m", label: "5 分钟", containerId: "tradingview_chart_5m", isPrimary: true },
];

export function ChartPanel() {
  const [testBusy, setTestBusy] = useState(false);
  const [testErr, setTestErr] = useState<string | null>(null);
  const [testPreviewUrl, setTestPreviewUrl] = useState<string | null>(null);

  const runTestCapture = useCallback(async () => {
    setTestErr(null);
    const sel = document.getElementById("symbol-select") as HTMLSelectElement | null;
    const tv = sel?.value?.trim() ?? "";
    setTestBusy(true);
    try {
      const api = window.argus;
      if (!api?.testChartCapture) {
        throw new Error("window.argus 未就绪，请确认后端已启动");
      }
      const pack = (await api.testChartCapture(tv || undefined)) as {
        dataUrl?: string;
        charts?: unknown[];
      };
      if (!pack?.dataUrl) throw new Error("服务端未返回图片 dataUrl");
      setTestPreviewUrl(pack.dataUrl);
    } catch (e) {
      setTestErr(e instanceof Error ? e.message : String(e));
    } finally {
      setTestBusy(false);
    }
  }, []);

  return (
    <>
      <Card className="min-h-0 min-w-0 flex-[1.75] gap-0 rounded-none border-0 border-r border-border py-0 shadow-none ring-0">
        <CardHeader className="flex h-10 shrink-0 flex-row items-center justify-between gap-0 border-b border-border px-3 py-0">
          <div className="flex min-w-0 items-center gap-2">
            <CardTitle className="text-xs leading-none font-semibold tracking-wider text-muted-foreground uppercase">
              行情
            </CardTitle>
          </div>
          <div className="flex min-w-0 shrink flex-wrap items-center justify-end gap-1.5">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px] font-semibold shadow-none"
              id="btn-test-chart-capture"
              title="立即走一遍收盘同款截图链路（WebSocket），无需等 K 线收盘"
              disabled={testBusy}
              onClick={() => void runTestCapture()}
            >
              {testBusy ? (
                <Loader2 className="size-3.5 animate-spin opacity-80" aria-hidden />
              ) : (
                <Camera className="size-3.5 opacity-80" aria-hidden />
              )}
              测试截图
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs font-semibold shadow-none"
              id="btn-fish-mode"
              title="遮盖图表与侧栏内容，离开座位时可用。按 ESC 退出。"
              aria-pressed="false"
            >
              <EyeOff className="size-3.5 opacity-80" aria-hidden />
              <span id="btn-fish-mode-label">隐私遮挡</span>
            </Button>
            <ChartSymbolSelect />
          </div>
        </CardHeader>
        {testErr ? (
          <div className="border-b border-border bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
            {testErr}
          </div>
        ) : null}
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

      <Dialog open={Boolean(testPreviewUrl)} onOpenChange={(open) => !open && setTestPreviewUrl(null)}>
        <DialogContent className="max-h-[90vh] max-w-[min(920px,96vw)] gap-3 overflow-hidden p-4">
          <DialogHeader>
            <DialogTitle className="text-sm">截图测试结果（四周期拼图）</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/30 p-2">
            {testPreviewUrl ? (
              <img
                src={testPreviewUrl}
                alt="TradingView 测试截图"
                className="mx-auto max-h-[min(72vh,720px)] w-auto max-w-full object-contain"
              />
            ) : null}
          </div>
          <DialogFooter className="gap-2 sm:justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => setTestPreviewUrl(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
