/**
 * K 线收盘截图：请求「已连接 WebSocket 的浏览器页」用 TradingView Widget 截图并回传（等同原 Electron IPC）。
 */
import crypto from "node:crypto";
import { publish } from "./runtime-bus.js";

/** @type {Map<string, { resolve: (v: unknown) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
const pending = new Map();

/**
 * @param {string} tvSymbol
 * @param {number} [timeoutMs]
 */
function requestChartCaptureFromBrowser(tvSymbol, timeoutMs = 22000) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(requestId)) return;
      pending.delete(requestId);
      reject(
        new Error(
          "截图超时：请在本机浏览器打开 Argus 页面并保持标签页在前台（WebSocket 已连接），收盘时会调用 TradingView 截图。",
        ),
      );
    }, timeoutMs);

    pending.set(requestId, {
      resolve: (pack) => {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve(pack);
      },
      reject: (err) => {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(err);
      },
      timer,
    });

    publish("request-chart-capture", {
      requestId,
      tvSymbol: typeof tvSymbol === "string" ? tvSymbol : String(tvSymbol || ""),
    });
  });
}

/**
 * WebSocket 客户端上报截图结果（与 Electron preload send("chart-capture-result") 对齐）。
 * @param {Record<string, unknown>} raw
 */
function ingestChartCaptureResult(raw) {
  if (!raw || typeof raw !== "object") return;
  const requestId = raw.requestId;
  if (typeof requestId !== "string" || !requestId) return;

  const entry = pending.get(requestId);
  if (!entry) return;

  clearTimeout(entry.timer);
  pending.delete(requestId);

  if (raw.ok === true) {
    const charts = Array.isArray(raw.charts)
      ? raw.charts
          .filter((item) => item && typeof item === "object")
          .map((item) => ({
            interval: String(/** @type {Record<string, unknown>} */ (item).interval || ""),
            label:
              /** @type {Record<string, unknown>} */ (item).label != null
                ? String(/** @type {Record<string, unknown>} */ (item).label)
                : "",
            mimeType: /** @type {Record<string, unknown>} */ (item).mimeType || "image/png",
            base64: String(/** @type {Record<string, unknown>} */ (item).base64 || ""),
            dataUrl: String(/** @type {Record<string, unknown>} */ (item).dataUrl || ""),
          }))
          .filter((item) => item.interval && item.base64 && item.dataUrl)
      : [];

    entry.resolve({
      mimeType: typeof raw.mimeType === "string" ? raw.mimeType : "image/png",
      base64: String(raw.base64 || ""),
      dataUrl: String(raw.dataUrl || ""),
      charts,
    });
    return;
  }

  entry.reject(new Error(typeof raw.error === "string" ? raw.error : "截图失败"));
}

export { requestChartCaptureFromBrowser, ingestChartCaptureResult };
