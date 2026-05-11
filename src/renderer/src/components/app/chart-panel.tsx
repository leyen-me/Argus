import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { ChartSymbolSelect } from "@/components/chart-symbol-select";
import { FishModeOverlay } from "@/components/app/fish-mode-overlay";
import { Button } from "@/components/ui/button";
import { PromptStrategySelect } from "@/components/prompt-strategy-select";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { AppDialogBody, AppDialogContent, AppDialogHeader, PanelHeader } from "@/components/app/ui-shell";
import { Camera, EyeOff, Loader2, PanelRightClose, PanelRightOpen } from "lucide-react";
import { ARGUS_APP_CONFIG_CHANGED } from "@/lib/argus-config-modal-events";
import { ARGUS_PROMPT_STRATEGIES_CHANGED } from "@/lib/argus-strategy-modal-events";
import {
  intervalsForTradingViewChartGrid,
  normalizeStrategyDecisionIntervalTv,
  type StrategyDecisionIntervalTv,
} from "@shared/strategy-fields";

export type ChartPanelProps = {
  rightPanelCollapsed?: boolean;
  onToggleRightPanel?: () => void;
};

/** 与 argus-renderer.js 中 `initLocalChartTestListener` 事件名保持一致 */
const ARGUS_TEST_CAPTURE_LOCAL = "argus:test-chart-capture-local";
const ARGUS_TEST_CAPTURE_RESULT = "argus:test-chart-capture-result";

const CHART_CARD_UI: Record<
  StrategyDecisionIntervalTv,
  { interval: string; label: string; containerId: string }
> = {
  "1D": { interval: "1D", label: "日线", containerId: "tradingview_chart_1d" },
  "240": { interval: "4H", label: "4 小时", containerId: "tradingview_chart_4h" },
  "60": { interval: "1H", label: "1 小时", containerId: "tradingview_chart_1h" },
  "15": { interval: "15m", label: "15 分钟", containerId: "tradingview_chart_15m" },
  "5": { interval: "5m", label: "5 分钟", containerId: "tradingview_chart_5m" },
};

function chartGridStyle(count: number): CSSProperties {
  if (count <= 1) {
    return { gridTemplateColumns: "minmax(0, 1fr)", gridTemplateRows: "minmax(0, 1fr)" };
  }
  if (count === 2) {
    return {
      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
      gridTemplateRows: "minmax(0, 1fr)",
    };
  }
  if (count === 3) {
    return {
      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
      gridTemplateRows: "minmax(0, 1fr)",
    };
  }
  return {
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gridTemplateRows: "repeat(2, minmax(0, 1fr))",
  };
}

async function syncChartLayoutFromApi(): Promise<{
  layoutDesc: StrategyDecisionIntervalTv[];
  decisionTv: StrategyDecisionIntervalTv;
} | null> {
  try {
    const api = typeof window !== "undefined" ? window.argus : undefined;
    if (!api?.getConfig) return null;
    const cfg = await api.getConfig();
    if (!cfg || typeof cfg !== "object") return null;
    const c = cfg as {
      promptStrategyMarketTimeframes?: unknown;
      promptStrategyDecisionIntervalTv?: unknown;
    };
    const layoutDesc = intervalsForTradingViewChartGrid(c.promptStrategyMarketTimeframes);
    const decisionTv = normalizeStrategyDecisionIntervalTv(c.promptStrategyDecisionIntervalTv ?? "5");
    return { layoutDesc, decisionTv };
  } catch {
    return null;
  }
}

export function ChartPanel({
  rightPanelCollapsed = false,
  onToggleRightPanel,
}: ChartPanelProps = {}) {
  const [chartLayoutIntervals, setChartLayoutIntervals] = useState<StrategyDecisionIntervalTv[]>(() =>
    intervalsForTradingViewChartGrid(undefined),
  );
  const [decisionIv, setDecisionIv] = useState<StrategyDecisionIntervalTv>(() =>
    normalizeStrategyDecisionIntervalTv("5"),
  );
  const [testBusy, setTestBusy] = useState(false);
  const [testErr, setTestErr] = useState<string | null>(null);
  const [testPreviewUrl, setTestPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function pull() {
      const row = await syncChartLayoutFromApi();
      if (cancelled || !row) return;
      setChartLayoutIntervals(row.layoutDesc);
      setDecisionIv(row.decisionTv);
    }
    void pull();
    const onReload = () => {
      void pull();
    };
    window.addEventListener(ARGUS_APP_CONFIG_CHANGED, onReload);
    window.addEventListener(ARGUS_PROMPT_STRATEGIES_CHANGED, onReload);
    return () => {
      cancelled = true;
      window.removeEventListener(ARGUS_APP_CONFIG_CHANGED, onReload);
      window.removeEventListener(ARGUS_PROMPT_STRATEGIES_CHANGED, onReload);
    };
  }, []);

  const runTestCapture = useCallback(() => {
    setTestErr(null);
    setTestBusy(true);

    let settled = false;
    const failSafe = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener(ARGUS_TEST_CAPTURE_RESULT, onResult);
      setTestBusy(false);
      setTestErr("截图超时：请确认多图 TradingView 已加载完成后再试");
    }, 90_000);

    const onResult = (ev: Event) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(failSafe);
      window.removeEventListener(ARGUS_TEST_CAPTURE_RESULT, onResult);
      const ce = ev as CustomEvent<{ ok?: boolean; dataUrl?: string; error?: string }>;
      const d = ce.detail;
      setTestBusy(false);
      if (d?.ok && d.dataUrl) setTestPreviewUrl(d.dataUrl);
      else setTestErr(d?.error || "截图失败");
    };

    window.addEventListener(ARGUS_TEST_CAPTURE_RESULT, onResult);
    window.dispatchEvent(new Event(ARGUS_TEST_CAPTURE_LOCAL));
  }, []);

  const gridStyle = chartGridStyle(chartLayoutIntervals.length || 1);

  return (
    <>
      <Card
        className={cn(
          "min-h-0 min-w-0 gap-0 rounded-none border-0 py-0 shadow-none ring-0",
          rightPanelCollapsed ? "flex-1 border-r-0" : "flex-[1.78]",
        )}
      >
        <PanelHeader
          eyebrow="market grid"
          title={
            <div className="titlebar-title">
              <PromptStrategySelect
                className="justify-start"
                triggerClassName="max-w-[180px] justify-start"
              />
            </div>
          }
          actions={
            <>
            {/* 去掉 className 里的 `hidden` 可再次显示「测试截图」 */}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="hidden h-7 gap-1 px-2 text-[11px] font-semibold shadow-none"
              id="btn-test-chart-capture"
              title="仅在本页用 TradingView 拼图截图，不调后端；不影响当前品种、不整页刷新图表"
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
            {onToggleRightPanel ? (
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="shrink-0 border-border/80 shadow-none"
                id="btn-toggle-right-panel"
                title={rightPanelCollapsed ? "展开右侧 Argus 面板" : "收起右侧 Argus 面板"}
                aria-label={rightPanelCollapsed ? "展开右侧 Argus 面板" : "收起右侧 Argus 面板"}
                aria-expanded={!rightPanelCollapsed}
                onClick={onToggleRightPanel}
              >
                {rightPanelCollapsed ? (
                  <PanelRightOpen className="size-3.5 opacity-80" aria-hidden />
                ) : (
                  <PanelRightClose className="size-3.5 opacity-80" aria-hidden />
                )}
              </Button>
            ) : null}
            </>
          }
        />
        {testErr ? (
          <div className="border-b border-border bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
            {testErr}
          </div>
        ) : null}
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <div className="chart-wrap">
            <div className="chart-grid min-h-0 flex-1" style={gridStyle}>
              {chartLayoutIntervals.map((iv) => {
                const card = CHART_CARD_UI[iv];
                const isPrimary = iv === decisionIv;
                return (
                  <section
                    key={card.containerId}
                    className={`chart-grid-card${isPrimary ? " chart-grid-card--primary" : ""}`}
                  >
                    <header className="chart-grid-card-head">
                      <span className="chart-grid-card-interval">{card.interval}</span>
                      <span className="chart-grid-card-label">{card.label}</span>
                    </header>
                    <div id={card.containerId} className="tradingview-chart" />
                  </section>
                );
              })}
            </div>
            <FishModeOverlay />
          </div>
        </CardContent>
      </Card>

      <Dialog open={Boolean(testPreviewUrl)} onOpenChange={(open) => !open && setTestPreviewUrl(null)}>
        <AppDialogContent className="max-h-[90vh] w-[min(920px,96vw)] sm:max-w-[920px]">
          <AppDialogHeader title="截图测试结果" eyebrow="chart capture" closeId="btn-chart-capture-preview-close" />
          <AppDialogBody className="p-4">
          <div className="min-h-0 flex-1 overflow-auto border border-border bg-muted/30 p-2">
            {testPreviewUrl ? (
              <img
                src={testPreviewUrl}
                alt="TradingView 测试截图"
                className="mx-auto max-h-[min(72vh,720px)] w-auto max-w-full object-contain"
              />
            ) : null}
          </div>
          </AppDialogBody>
          <DialogFooter className="gap-2 sm:justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => setTestPreviewUrl(null)}>
              关闭
            </Button>
          </DialogFooter>
        </AppDialogContent>
      </Dialog>
    </>
  );
}
