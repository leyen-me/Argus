import type {
  ChartCaptureRequestPayload,
  LlmStreamDeltaPayload,
  LlmStreamEndPayload,
  LlmStreamErrorPayload,
  MarketBarClosePayload,
  MarketStatusPayload,
  OkxSwapStatusPayload,
} from "./ws-payloads.js";

/**
 * Browser-facing API installed as `window.argus`.
 * Method names and argument order are backward-compatible public contract.
 */
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
