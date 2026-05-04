/** Web 模式：HTTP RPC + WebSocket，对齐 Electron preload 的 `window.argus` API */

/** 与 vite-env.d.ts 全局 `ArgusBarCloseLlmState` / `window.argusLastBarClose.llm` 对齐 */
interface MarketBarCloseLlmPayload {
  analysisText?: string | null;
  cardSummary?: string | null;
  toolTrace?: unknown[];
  reasoningText?: string;
  streaming?: boolean;
  error?: string | null;
  skippedReason?: string | null;
  enabled?: boolean;
}

/** `market-bar-close` 与服务端、全局 `ArgusLastBarClose`（见 vite-env.d.ts）对齐 */
export interface MarketBarClosePayload {
  llm?: MarketBarCloseLlmPayload;
  exchangeContext?: unknown;
  barCloseId?: string;
  conversationKey?: string;
  chartImage?: { dataUrl?: string | null };
  chartCaptureError?: unknown;
  [key: string]: unknown;
}

/** `request-chart-capture` WebSocket 推送 */
export type ChartCaptureRequestPayload = {
  requestId?: string;
  tvSymbol?: string;
  /** 策略「市场数据」勾选周期；缺省则截取全部多周期图 */
  marketTimeframes?: string[];
};

/** `market-status` 推送 */
export type MarketStatusPayload = {
  text?: string;
};

/** `llm-stream-delta` 推送 */
export type LlmStreamDeltaPayload = {
  barCloseId: string;
  full?: string | null;
  reasoningFull?: string | null;
  toolFull?: string | null;
};

/** `llm-stream-end` 推送 */
export type LlmStreamEndPayload = {
  barCloseId: string;
  analysisText?: string | null;
  cardSummary?: string | null;
  reasoningText?: string | null;
  toolTrace?: unknown[];
  conversationKey?: string;
  exchangeContext?: unknown;
};

/** `llm-stream-error` 推送 */
export type LlmStreamErrorPayload = {
  barCloseId: string;
  message?: string | null;
  toolTrace?: unknown[];
};

/** `okx-swap-status` 推送 */
export type OkxSwapStatusPayload = {
  ok?: boolean;
  message?: string;
  tvSymbol?: string;
  position?: Record<string, unknown>;
  simulated?: boolean;
};

export type ArgusBridge = {
  onMarketBarClose: (callback: (payload: MarketBarClosePayload) => void) => void;
  onChartCaptureRequest: (callback: (payload: ChartCaptureRequestPayload) => void) => void;
  submitChartCaptureResult: (result: unknown) => void;
  onMarketStatus: (callback: (payload: MarketStatusPayload) => void) => void;
  onLlmStreamDelta: (callback: (payload: LlmStreamDeltaPayload) => void) => void;
  onLlmStreamEnd: (callback: (payload: LlmStreamEndPayload) => void) => void;
  onLlmStreamError: (callback: (payload: LlmStreamErrorPayload) => void) => void;
  onOkxSwapStatus: (callback: (payload: OkxSwapStatusPayload) => void) => void;
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

const BACKEND_HINT =
  "请先启动 Argus Node 服务端（默认监听 8787）。推荐使用「pnpm dev」同时启动后端与 Vite；若只跑了前端，请在另一终端执行「pnpm run server:dev」。";

async function rpc(method: string, args: unknown[] = []) {
  let res: Response;
  try {
    res = await fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, args }),
    });
  } catch {
    throw new Error(`无法访问 /api/rpc（网络错误）。${BACKEND_HINT}`);
  }

  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(
      `后端返回空正文（HTTP ${res.status}）。${res.status === 502 || res.status === 504 ? BACKEND_HINT : "请确认服务端正常运行且未被防火墙拦截。"}`,
    );
  }

  let data: { ok?: boolean; error?: string; result?: unknown };
  try {
    data = JSON.parse(trimmed) as typeof data;
  } catch {
    const preview = trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed;
    throw new Error(
      `后端返回非 JSON（HTTP ${res.status}）。${BACKEND_HINT} 响应片段：${preview}`,
    );
  }

  if (!data.ok) throw new Error(data.error || "RPC failed");
  return data.result;
}

/** 后端未就绪时拉长间隔，减轻 Vite ws 代理刷屏 */
let wsReconnectDelayMs = 2500;

/** 当前 WebSocket（用于浏览器侧 TradingView 截图结果回传） */
let socketRef: WebSocket | null = null;

function connectWsLoop() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${proto}//${window.location.host}/ws`;
  const ws = new WebSocket(wsUrl);
  socketRef = ws;
  ws.onopen = () => {
    wsReconnectDelayMs = 2500;
  };
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
    if (socketRef === ws) socketRef = null;
    window.setTimeout(() => {
      wsReconnectDelayMs = Math.min(Math.round(wsReconnectDelayMs * 1.8), 30_000);
      connectWsLoop();
    }, wsReconnectDelayMs);
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
    onMarketBarClose: (cb) =>
      subscribeChannel("market-bar-close", (p) => cb(p as MarketBarClosePayload)),
    onChartCaptureRequest: (cb) =>
      subscribeChannel("request-chart-capture", (p) => cb(p as ChartCaptureRequestPayload)),
    submitChartCaptureResult: (result: unknown) => {
      const ws = socketRef;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn("[argus-bridge] WebSocket 未连接，无法回传截图（请保持 pnpm dev 后端在 8787 运行）");
        return;
      }
      const payload =
        result && typeof result === "object" && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : {};
      ws.send(JSON.stringify({ type: "chart-capture-result", ...payload }));
    },
    onMarketStatus: (cb) =>
      subscribeChannel("market-status", (p) => cb(p as MarketStatusPayload)),
    onLlmStreamDelta: (cb) =>
      subscribeChannel("llm-stream-delta", (p) => cb(p as LlmStreamDeltaPayload)),
    onLlmStreamEnd: (cb) =>
      subscribeChannel("llm-stream-end", (p) => cb(p as LlmStreamEndPayload)),
    onLlmStreamError: (cb) =>
      subscribeChannel("llm-stream-error", (p) => cb(p as LlmStreamErrorPayload)),
    onOkxSwapStatus: (cb) =>
      subscribeChannel("okx-swap-status", (p) => cb(p as OkxSwapStatusPayload)),

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
