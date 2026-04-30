/** Web 模式：HTTP RPC + WebSocket，对齐 Electron preload 的 `window.argus` API */

export type ArgusBridge = {
  onMarketBarClose: (callback: (payload: unknown) => void) => void;
  onChartCaptureRequest: (callback: (payload: unknown) => void) => void;
  submitChartCaptureResult: (result: unknown) => void;
  onMarketStatus: (callback: (payload: unknown) => void) => void;
  onLlmStreamDelta: (callback: (payload: unknown) => void) => void;
  onLlmStreamEnd: (callback: (payload: unknown) => void) => void;
  onLlmStreamError: (callback: (payload: unknown) => void) => void;
  onOkxSwapStatus: (callback: (payload: unknown) => void) => void;
  setMarketContext: (tvSymbol: string) => Promise<unknown>;
  requestAnalysis: (payload: unknown) => Promise<unknown>;
  getConfig: () => Promise<unknown>;
  saveConfig: (config: unknown) => Promise<unknown>;
  resetConfig: () => Promise<unknown>;
  getConfigPath: () => Promise<unknown>;
  openDevTools: () => Promise<unknown>;
  getOkxSwapPosition: (tvSymbol: string) => Promise<unknown>;
  getDashboard: () => Promise<unknown>;
  listAgentBarTurnsPage: (args: unknown) => Promise<unknown>;
  getAgentBarTurnChart: (barCloseId: string) => Promise<unknown>;
  getAgentSessionMessages: (barCloseId: string) => Promise<unknown>;
  listPromptStrategiesMeta: () => Promise<unknown>;
  getPromptStrategy: (id: string) => Promise<unknown>;
  savePromptStrategy: (payload: unknown) => Promise<unknown>;
  deletePromptStrategy: (id: string) => Promise<unknown>;
};

const listeners = new Map<string, Set<(payload: unknown) => void>>();

function emitChannel(channel: string, payload: unknown) {
  const set = listeners.get(channel);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(payload);
    } catch (e) {
      console.error("[argus-bridge]", channel, e);
    }
  }
}

function subscribeChannel(channel: string, cb: (payload: unknown) => void) {
  if (!listeners.has(channel)) listeners.set(channel, new Set());
  listeners.get(channel)!.add(cb);
}

async function rpc(method: string, args: unknown[] = []) {
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args }),
  });
  const data = (await res.json()) as { ok?: boolean; error?: string; result?: unknown };
  if (!data.ok) throw new Error(data.error || "RPC failed");
  return data.result;
}

function connectWsLoop() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${proto}//${window.location.host}/ws`;
  const ws = new WebSocket(wsUrl);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as { channel?: string; payload?: unknown };
      if (msg && typeof msg.channel === "string") {
        emitChannel(msg.channel, msg.payload);
      }
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => {
    window.setTimeout(connectWsLoop, 2500);
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
}

/** 在主入口尽早调用，保证 `window.argus` 对 TradingView / React 可用 */
export function installArgusBridge() {
  connectWsLoop();

  const bridge: ArgusBridge = {
    onMarketBarClose: (cb) => subscribeChannel("market-bar-close", cb),
    onChartCaptureRequest: (cb) => subscribeChannel("request-chart-capture", cb),
    submitChartCaptureResult: () => {
      /* Web 模式下截图由服务端 Playwright 完成；保留 noop 兼容旧脚本 */
    },
    onMarketStatus: (cb) => subscribeChannel("market-status", cb),
    onLlmStreamDelta: (cb) => subscribeChannel("llm-stream-delta", cb),
    onLlmStreamEnd: (cb) => subscribeChannel("llm-stream-end", cb),
    onLlmStreamError: (cb) => subscribeChannel("llm-stream-error", cb),
    onOkxSwapStatus: (cb) => subscribeChannel("okx-swap-status", cb),

    setMarketContext: (tvSymbol) => rpc("market:set-context", [tvSymbol]),
    requestAnalysis: (payload) => rpc("llm-request-analysis", [payload]),
    getConfig: () => rpc("config:get", []),
    saveConfig: (config) => rpc("config:save", [config]),
    resetConfig: () => rpc("config:reset", []),
    getConfigPath: () => rpc("config:path", []),
    openDevTools: () => rpc("devtools:open", []),
    getOkxSwapPosition: (tvSymbol) => rpc("okx:swap-position", [tvSymbol]),
    getDashboard: () => rpc("dashboard:get", []),
    listAgentBarTurnsPage: (args) => rpc("agent-bar-turns:list-page", [args]),
    getAgentBarTurnChart: (barCloseId) => rpc("agent-bar-turns:get-chart", [barCloseId]),
    getAgentSessionMessages: (barCloseId) =>
      rpc("agent-bar-turns:get-session-messages", [barCloseId]),
    listPromptStrategiesMeta: () => rpc("prompt-strategies:list", []),
    getPromptStrategy: (id) => rpc("prompt-strategies:get", [id]),
    savePromptStrategy: (payload) => rpc("prompt-strategies:save", [payload]),
    deletePromptStrategy: (id) => rpc("prompt-strategies:delete", [id]),
  };

  window.argus = bridge;
}
