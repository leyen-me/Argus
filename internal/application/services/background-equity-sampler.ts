import {
  BACKGROUND_EQUITY_SAMPLE_INTERVAL_MS,
  sampleDashboardEquityOnce,
} from "../../../src/node/dashboard-service.js";
import { loadAppConfig } from "../../../src/node/app-config.js";
import type { Logger } from "../../infrastructure/logging/logger.js";

let dashboardEquitySamplerTimer: ReturnType<typeof setInterval> | null = null;
let dashboardEquitySamplerInFlight = false;

export async function runBackgroundEquitySample(logger?: Logger) {
  if (dashboardEquitySamplerInFlight) return;
  dashboardEquitySamplerInFlight = true;
  try {
    await sampleDashboardEquityOnce(await loadAppConfig());
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger?.warn("dashboard equity sample failed", { error: { message: msg } });
  } finally {
    dashboardEquitySamplerInFlight = false;
  }
}

export function startBackgroundEquitySampler(logger?: Logger) {
  stopBackgroundEquitySampler();
  void runBackgroundEquitySample(logger);
  dashboardEquitySamplerTimer = setInterval(() => {
    void runBackgroundEquitySample(logger);
  }, BACKGROUND_EQUITY_SAMPLE_INTERVAL_MS);
}

export function stopBackgroundEquitySampler() {
  if (!dashboardEquitySamplerTimer) return;
  clearInterval(dashboardEquitySamplerTimer);
  dashboardEquitySamplerTimer = null;
}
