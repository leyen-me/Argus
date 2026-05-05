import { useEffect, useState } from "react";
import { ChartPanel } from "@/components/app/chart-panel";
import { cn } from "@/lib/utils";
import { ConfigModal } from "@/components/app/config-modal";
import { DashboardModal } from "@/components/app/dashboard-modal";
import { StrategyCenterModal } from "@/components/app/strategy-center-modal";
import { LlmChartPreviewModal } from "@/components/app/llm-chart-preview-modal";
import { LlmSessionDetailModal } from "@/components/app/llm-session-detail-modal";
import { LlmPanel } from "@/components/app/llm-panel";
import { StrategiesEmptyState } from "@/components/app/strategies-empty-state";
import { TitleBar } from "@/components/app/title-bar";
import { ARGUS_PROMPT_STRATEGY_SYNC } from "@/components/prompt-strategy-select";
import { initArgusApp } from "./argus-renderer";

const RIGHT_PANEL_COLLAPSED_KEY = "argus.ui.rightPanelCollapsed";

function readStoredRightPanelCollapsed(): boolean {
  try {
    const v = window.localStorage.getItem(RIGHT_PANEL_COLLAPSED_KEY);
    if (v === "1" || v === "true") return true;
    if (v === "0" || v === "false") return false;
  } catch {
    /* private mode / quota */
  }
  return false;
}

export default function App() {
  /** `null`：尚未收到配置同步；`0`：已同步且无策略；`>0`：已有策略 */
  const [strategyOptionCount, setStrategyOptionCount] = useState<number | null>(null);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(readStoredRightPanelCollapsed);

  useEffect(() => {
    void initArgusApp();
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(RIGHT_PANEL_COLLAPSED_KEY, rightPanelCollapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [rightPanelCollapsed]);

  useEffect(() => {
    const onSync = (e: Event) => {
      const detail = (e as CustomEvent<{ options?: unknown[] }>).detail;
      const n = Array.isArray(detail?.options) ? detail.options.length : 0;
      setStrategyOptionCount(n);
    };
    window.addEventListener(ARGUS_PROMPT_STRATEGY_SYNC, onSync);
    return () => window.removeEventListener(ARGUS_PROMPT_STRATEGY_SYNC, onSync);
  }, []);

  const showStrategiesEmpty = strategyOptionCount === 0;

  return (
    <>
      <div className="app">
        <TitleBar />
        <main className="main">
          {showStrategiesEmpty ? (
            <StrategiesEmptyState />
          ) : (
            <>
              <ChartPanel
                rightPanelCollapsed={rightPanelCollapsed}
                onToggleRightPanel={() => setRightPanelCollapsed((v) => !v)}
              />
              <div
                className={cn(
                  "flex min-h-0 min-w-0 transition-[flex-basis,flex-grow,max-width,opacity] duration-200 ease-out",
                  rightPanelCollapsed
                    ? "pointer-events-none max-w-0 flex-[0_0_0] overflow-hidden opacity-0"
                    : "flex-[0.75]",
                )}
                aria-hidden={rightPanelCollapsed}
                inert={rightPanelCollapsed ? true : undefined}
              >
                <LlmPanel />
              </div>
            </>
          )}
        </main>
      </div>

      <ConfigModal />
      <DashboardModal />
      <StrategyCenterModal />
      <LlmSessionDetailModal />
      <LlmChartPreviewModal />
    </>
  );
}
