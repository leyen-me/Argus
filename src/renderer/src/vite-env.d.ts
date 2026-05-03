/// <reference types="vite/client" />

declare global {
  /** 右侧助手卡片在流式结束/出错时回写的可变子状态 */
  interface ArgusBarCloseLlmState {
    analysisText?: string | null;
    cardSummary?: string | null;
    toolTrace?: unknown[];
    reasoningText?: string;
    streaming?: boolean;
    error?: string | null;
    skippedReason?: string | null;
    enabled?: boolean;
  }

  /** 与 `onMarketBarClose` 推送结构对齐的缓存（仅用于 UI 增量更新） */
  interface ArgusLastBarClose {
    llm?: ArgusBarCloseLlmState;
    exchangeContext?: unknown;
    barCloseId?: string;
    conversationKey?: string;
    chartImage?: { dataUrl?: string | null };
    chartCaptureError?: unknown;
    [key: string]: unknown;
  }

  interface OkxPositionFields {
    pos?: string | number | null;
    upl?: string | number | null;
    avgPx?: string | number | null;
    markPx?: string | number | null;
    lever?: string | number | null;
    instId?: string;
  }

  /** `getOkxSwapPosition` / 持仓推送摘要 */
  interface OkxSwapPositionSnapshot {
    skipped?: boolean;
    reason?: string;
    ok?: boolean;
    message?: string;
    simulated?: boolean;
    instId?: string;
    hasPosition?: boolean;
    posNum?: number;
    absContracts?: number;
    posSide?: string | null;
    fields?: OkxPositionFields;
    pending_orders?: unknown;
    pending_algo_orders?: unknown;
  }

  interface Window {
    argus?: import("./argus-bridge").ArgusBridge;
    argusLastBarClose?: ArgusLastBarClose | null;
    argusLastChartImage?: unknown;
  }
}

export {};
