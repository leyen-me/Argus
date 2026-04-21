import { useEffect } from "react";
import { ChartPanel } from "@/components/app/chart-panel";
import { ConfigModal } from "@/components/app/config-modal";
import { DashboardModal } from "@/components/app/dashboard-modal";
import { StrategyCenterModal } from "@/components/app/strategy-center-modal";
import { FishModeOverlay } from "@/components/app/fish-mode-overlay";
import { LlmChartPreviewModal } from "@/components/app/llm-chart-preview-modal";
import { LlmSessionDetailModal } from "@/components/app/llm-session-detail-modal";
import { LlmPanel } from "@/components/app/llm-panel";
import { TitleBar } from "@/components/app/title-bar";
import { initArgusApp } from "./argus-renderer";

export default function App() {
  useEffect(() => {
    void initArgusApp();
  }, []);

  return (
    <>
      <div className="app">
        <TitleBar />
        <main className="main">
          <ChartPanel />
          <LlmPanel />
        </main>
      </div>

      <ConfigModal />
      <DashboardModal />
      <StrategyCenterModal />
      <FishModeOverlay />
      <LlmChartPreviewModal />
      <LlmSessionDetailModal />
    </>
  );
}
