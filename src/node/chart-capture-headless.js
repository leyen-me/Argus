/**
 * 使用 Playwright 打开前端 `/capture` 页，调用页面内 TradingView 多周期截图逻辑。
 *
 * 环境变量：
 * - ARGUS_PUBLIC_URL：前端来源（开发时常用 http://127.0.0.1:5173）
 * - PORT：与本机静态站同源时可省略，默认回退 http://127.0.0.1:${PORT}
 */

/** @type {import("playwright").Browser | null} */
let browserSingleton = null;

function resolvePublicOrigin() {
  const explicit =
    (process.env.ARGUS_PUBLIC_URL && String(process.env.ARGUS_PUBLIC_URL).trim()) ||
    (process.env.ARGUS_CAPTURE_ORIGIN && String(process.env.ARGUS_CAPTURE_ORIGIN).trim());
  if (explicit) return explicit.replace(/\/$/, "");
  const port = process.env.PORT || "8787";
  return `http://127.0.0.1:${port}`;
}

async function getBrowser() {
  if (browserSingleton) return browserSingleton;
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    throw new Error(
      "未安装 playwright：请执行 npm install playwright 且 npx playwright install chromium",
    );
  }
  browserSingleton = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox", "--disable-setuid-sandbox"],
  });
  return browserSingleton;
}

/**
 * @returns {Promise<void>}
 */
async function closeBrowser() {
  if (!browserSingleton) return;
  try {
    await browserSingleton.close();
  } catch {
    /* ignore */
  }
  browserSingleton = null;
}

/**
 * @param {string} tvSymbol
 * @param {number} [timeoutMs]
 * @returns {Promise<{ mimeType: string, base64: string, dataUrl: string, charts: Array<{ interval: string, label?: string, mimeType: string, base64: string, dataUrl: string }> }>}
 */
async function captureChartsForSymbol(tvSymbol, timeoutMs = 120000) {
  const sym = String(tvSymbol || "").trim();
  if (!sym) throw new Error("tvSymbol 为空");

  const origin = resolvePublicOrigin();
  const url = `${origin}/capture?tvSymbol=${encodeURIComponent(sym)}`;

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1480, height: 920 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "load", timeout: timeoutMs });

    await page.waitForFunction(
      () => window.__ARGUS_CAPTURE_READY__ === true,
      null,
      { timeout: timeoutMs },
    );

    const evaluated = await page.evaluate(async () => {
      const fn = window.__ARGUS_RUN_CAPTURE__;
      if (typeof fn !== "function") {
        throw new Error("页面未暴露 __ARGUS_RUN_CAPTURE__");
      }
      return fn();
    });

    if (!evaluated || evaluated.ok !== true) {
      throw new Error(evaluated?.error || "截图返回非 ok");
    }

    return {
      mimeType: evaluated.mimeType || "image/png",
      base64: evaluated.base64 || "",
      dataUrl: evaluated.dataUrl || "",
      charts: Array.isArray(evaluated.charts)
        ? evaluated.charts
            .filter((item) => item && typeof item === "object")
            .map((item) => ({
              interval: String(item.interval || ""),
              label: item.label != null ? String(item.label) : "",
              mimeType: item.mimeType || "image/png",
              base64: item.base64 || "",
              dataUrl: item.dataUrl || "",
            }))
            .filter((item) => item.interval && item.base64 && item.dataUrl)
        : [],
    };
  } finally {
    await context.close().catch(() => {});
  }
}

module.exports = {
  captureChartsForSymbol,
  closeBrowser,
  resolvePublicOrigin,
};
