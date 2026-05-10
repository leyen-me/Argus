export interface MarketBarClosePayload {
  llm?: {
    analysisText?: string | null;
    cardSummary?: string | null;
    toolTrace?: unknown[];
    reasoningText?: string;
    streaming?: boolean;
    error?: string | null;
    skippedReason?: string | null;
    enabled?: boolean;
  };
  exchangeContext?: unknown;
  barCloseId?: string;
  conversationKey?: string;
  chartImage?: { dataUrl?: string | null };
  chartCaptureError?: unknown;
  [key: string]: unknown;
}

export type ChartCaptureRequestPayload = {
  requestId?: string;
  tvSymbol?: string;
  targetRole?: "interactive" | "headless_capture";
  marketTimeframes?: string[];
};

export type MarketStatusPayload = {
  text?: string;
};

export type LlmStreamDeltaPayload = {
  barCloseId: string;
  full?: string | null;
  reasoningFull?: string | null;
  toolFull?: string | null;
};

export type LlmStreamEndPayload = {
  barCloseId: string;
  analysisText?: string | null;
  cardSummary?: string | null;
  reasoningText?: string | null;
  toolTrace?: unknown[];
  conversationKey?: string;
  exchangeContext?: unknown;
};

export type LlmStreamErrorPayload = {
  barCloseId: string;
  message?: string | null;
  toolTrace?: unknown[];
};

export type OkxSwapStatusPayload = {
  ok?: boolean;
  message?: string;
  tvSymbol?: string;
  position?: Record<string, unknown>;
  simulated?: boolean;
};
