import { useEffect, useState } from "react";
import { ChartPanel } from "@/components/app/chart-panel";
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

export default function App() {
  /** `null`：尚未收到配置同步；`0`：已同步且无策略；`>0`：已有策略 */
  const [strategyOptionCount, setStrategyOptionCount] = useState<number | null>(null);

  useEffect(() => {
    void initArgusApp();
  }, []);

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
              <ChartPanel />
              <LlmPanel />
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
