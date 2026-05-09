/**
 * K 线收盘截图：请求「已连接 WebSocket 的浏览器页」用 TradingView Widget 截图并回传（等同原 Electron IPC）。
 */
import crypto from "node:crypto";
import { publish } from "./runtime-bus.js";
const pending = new Map();
const captureClients = new Map();
const roleWaiters = new Map();
let captureQueueTail = Promise.resolve();
function normalizeCaptureClientRole(raw) {
    return raw === "headless_capture" ? "headless_capture" : "interactive";
}
function notifyRoleWaiters(role) {
    const waiters = roleWaiters.get(role);
    if (!waiters || waiters.size === 0)
        return;
    roleWaiters.delete(role);
    for (const resolve of waiters) {
        resolve();
    }
}
function registerCaptureClient(clientId, roleRaw) {
    const role = normalizeCaptureClientRole(roleRaw);
    captureClients.set(clientId, {
        clientId,
        role,
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
    });
    notifyRoleWaiters(role);
    return role;
}
function unregisterCaptureClient(clientId) {
    captureClients.delete(clientId);
}
function hasCaptureClient(role) {
    if (!role)
        return captureClients.size > 0;
    for (const client of captureClients.values()) {
        if (client.role === role)
            return true;
    }
    return false;
}
function captureClientSnapshot() {
    return {
        total: captureClients.size,
        headlessConnected: hasCaptureClient("headless_capture"),
        interactiveConnected: hasCaptureClient("interactive"),
    };
}
function waitForCaptureClientRole(role, timeoutMs = 15_000) {
    if (hasCaptureClient(role))
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const set = roleWaiters.get(role);
            set?.delete(onReady);
            reject(new Error(role === "headless_capture" ? "无头截图客户端未连接" : "截图客户端未连接"));
        }, timeoutMs);
        const onReady = () => {
            clearTimeout(timer);
            const set = roleWaiters.get(role);
            set?.delete(onReady);
            resolve();
        };
        const set = roleWaiters.get(role) ?? new Set();
        set.add(onReady);
        roleWaiters.set(role, set);
    });
}
function resolveTargetRole(preferredRole, allowRoleFallback) {
    if (preferredRole && hasCaptureClient(preferredRole))
        return preferredRole;
    if (!allowRoleFallback)
        return undefined;
    if (hasCaptureClient("headless_capture"))
        return "headless_capture";
    if (hasCaptureClient("interactive"))
        return "interactive";
    return undefined;
}
function queueCaptureTask(task) {
    const run = captureQueueTail.catch(() => undefined).then(task);
    captureQueueTail = run.then(() => undefined, () => undefined);
    return run;
}
function noClientError(preferredRole, allowRoleFallback = true) {
    if (preferredRole === "headless_capture" && !allowRoleFallback) {
        return new Error("无头截图客户端未连接或尚未就绪");
    }
    return new Error("截图客户端未连接：请等待内置无头截图页就绪，或在本机浏览器打开 Argus 页面并保持 WebSocket 已连接。");
}
function timeoutMessage(targetRole) {
    if (targetRole === "headless_capture") {
        return "截图超时：内置无头截图页未在时限内返回结果。";
    }
    return "截图超时：请在本机浏览器打开 Argus 页面并保持标签页在前台（WebSocket 已连接），收盘时会调用 TradingView 截图。";
}
/**
 * @param {string} tvSymbol
 * @param {number} [timeoutMs]
 * @param {string[] | undefined} [marketTimeframes] 策略「市场数据」勾选的周期（如 `['5','60']`）；未传则截全部分时图
 * @param {RequestChartCaptureOptions} [options]
 */
function requestChartCaptureFromBrowser(tvSymbol, timeoutMs = 22000, marketTimeframes, options = {}) {
    return queueCaptureTask(async () => {
        const preferredRole = options.preferredRole;
        const allowRoleFallback = options.allowRoleFallback !== false;
        const targetRole = resolveTargetRole(preferredRole, allowRoleFallback);
        if (!targetRole && !hasCaptureClient()) {
            throw noClientError(preferredRole, allowRoleFallback);
        }
        if (!targetRole && preferredRole && !allowRoleFallback) {
            throw noClientError(preferredRole, allowRoleFallback);
        }
        const requestId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!pending.has(requestId))
                    return;
                pending.delete(requestId);
                reject(new Error(timeoutMessage(targetRole)));
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
                targetRole,
                tvSymbol: typeof tvSymbol === "string" ? tvSymbol : String(tvSymbol || ""),
                marketTimeframes: Array.isArray(marketTimeframes) ? marketTimeframes : undefined,
            });
        });
    });
}
/**
 * WebSocket 客户端上报截图结果（与 Electron preload send("chart-capture-result") 对齐）。
 * @param {Record<string, unknown>} raw
 */
function ingestChartCaptureResult(raw) {
    if (!raw || typeof raw !== "object")
        return;
    const requestId = raw.requestId;
    if (typeof requestId !== "string" || !requestId)
        return;
    const entry = pending.get(requestId);
    if (!entry)
        return;
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
export { registerCaptureClient, unregisterCaptureClient, waitForCaptureClientRole, captureClientSnapshot, requestChartCaptureFromBrowser, ingestChartCaptureResult, };
//# sourceMappingURL=chart-capture-browser-bridge.js.map