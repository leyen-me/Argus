import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { loadAppConfig } from "./app-config.js";
import {
  requestChartCaptureFromBrowser,
  waitForCaptureClientRole,
} from "./chart-capture-browser-bridge.js";

const HEADLESS_CAPTURE_ROLE = "headless_capture" as const;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
const RESTART_DELAY_MS = 1_500;

type HeadlessCaptureStartOptions = {
  port: number;
};

let browserRef: Browser | null = null;
let contextRef: BrowserContext | null = null;
let pageRef: Page | null = null;
let startPromise: Promise<void> | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let closing = false;
let lastStartOptions: HeadlessCaptureStartOptions | null = null;

function envFlag(name: string, fallback: boolean): boolean {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  return !["0", "false", "off", "no"].includes(raw);
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}

function isHeadlessCaptureEnabled(): boolean {
  return envFlag("HEADLESS_CAPTURE_ENABLED", true);
}

function headlessCaptureStartupTimeoutMs(): number {
  return envInt("HEADLESS_CAPTURE_STARTUP_TIMEOUT_MS", DEFAULT_STARTUP_TIMEOUT_MS);
}

function headlessCaptureRequestTimeoutMs(): number {
  return envInt("HEADLESS_CAPTURE_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS);
}

function shouldDisableSandbox(): boolean {
  return envFlag("HEADLESS_CAPTURE_DISABLE_SANDBOX", false);
}

function resolveHeadlessCaptureUrl(port: number): string {
  const raw = String(process.env.HEADLESS_CAPTURE_URL || "").trim();
  if (raw) return raw;
  return `http://127.0.0.1:${port}/?argus_headless=1&argus_client_role=${HEADLESS_CAPTURE_ROLE}`;
}

function clearRefs() {
  browserRef = null;
  contextRef = null;
  pageRef = null;
}

function scheduleRestart(reason: string) {
  if (closing || restartTimer || startPromise || !lastStartOptions || !isHeadlessCaptureEnabled()) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    const options = lastStartOptions;
    if (!options) return;
    console.warn(`[Argus headless] ${reason}，准备重建无头截图页`);
    void startHeadlessCaptureService(options).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Argus headless] 重建失败：${msg}`);
    });
  }, RESTART_DELAY_MS);
}

async function teardownBrowser() {
  const browser = browserRef;
  const context = contextRef;
  const page = pageRef;
  clearRefs();
  try {
    await page?.close();
  } catch {
    /* ignore */
  }
  try {
    await context?.close();
  } catch {
    /* ignore */
  }
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
}

async function probeHeadlessCapture() {
  const cfg = await loadAppConfig();
  const tvSymbol = String(cfg.defaultSymbol || "").trim() || "OKX:BTCUSDT";
  await requestChartCaptureFromBrowser(
    tvSymbol,
    headlessCaptureRequestTimeoutMs(),
    cfg.promptStrategyMarketTimeframes,
    {
      preferredRole: HEADLESS_CAPTURE_ROLE,
      allowRoleFallback: false,
    },
  );
}

async function launchHeadlessCaptureBrowser(options: HeadlessCaptureStartOptions) {
  const timeoutMs = headlessCaptureStartupTimeoutMs();
  const launchArgs = ["--disable-dev-shm-usage"];
  if (shouldDisableSandbox()) {
    launchArgs.push("--no-sandbox");
  }

  const browser = await chromium.launch({
    headless: true,
    args: launchArgs,
  });
  const context = await browser.newContext({
    viewport: { width: 1720, height: 1200 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  browser.on("disconnected", () => {
    clearRefs();
    scheduleRestart("浏览器进程已断开");
  });
  page.on("close", () => {
    clearRefs();
    scheduleRestart("无头截图页已关闭");
  });
  page.on("crash", () => {
    clearRefs();
    scheduleRestart("无头截图页崩溃");
  });

  browserRef = browser;
  contextRef = context;
  pageRef = page;

  const url = resolveHeadlessCaptureUrl(options.port);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 15_000) }).catch(() => undefined);
  await page.waitForFunction(() => Boolean((globalThis as { argus?: unknown }).argus), undefined, {
    timeout: timeoutMs,
  });
  await waitForCaptureClientRole(HEADLESS_CAPTURE_ROLE, timeoutMs);
  await probeHeadlessCapture();
}

async function startHeadlessCaptureService(options: HeadlessCaptureStartOptions) {
  lastStartOptions = options;
  if (!isHeadlessCaptureEnabled()) return;
  if (startPromise) return startPromise;
  if (browserRef && pageRef && !pageRef.isClosed()) return;

  startPromise = (async () => {
    closing = false;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    await teardownBrowser();
    try {
      await launchHeadlessCaptureBrowser(options);
      console.info("[Argus headless] 无头截图页已就绪");
    } catch (error) {
      await teardownBrowser();
      throw error;
    } finally {
      startPromise = null;
    }
  })();
  return startPromise;
}

async function ensureHeadlessCaptureReady() {
  if (!isHeadlessCaptureEnabled()) return false;
  if (!browserRef || !pageRef || pageRef.isClosed()) {
    if (!lastStartOptions) return false;
    await startHeadlessCaptureService(lastStartOptions);
    return true;
  }
  try {
    await waitForCaptureClientRole(HEADLESS_CAPTURE_ROLE, 1_500);
    return true;
  } catch {
    if (!lastStartOptions) return false;
    await startHeadlessCaptureService(lastStartOptions);
    return true;
  }
}

function isHeadlessCaptureReady() {
  return !!browserRef && !!pageRef && !pageRef.isClosed();
}

async function closeHeadlessCaptureService() {
  closing = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  await teardownBrowser();
}

export {
  closeHeadlessCaptureService,
  ensureHeadlessCaptureReady,
  headlessCaptureRequestTimeoutMs,
  isHeadlessCaptureEnabled,
  isHeadlessCaptureReady,
  startHeadlessCaptureService,
};
