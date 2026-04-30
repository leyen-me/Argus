/// <reference types="vite/client" />

declare global {
  interface Window {
    argus?: import("./argus-bridge").ArgusBridge;
    argusLastBarClose?: unknown;
    argusLastChartImage?: unknown;
    __ARGUS_CAPTURE_READY__?: boolean;
    __ARGUS_WAIT_CAPTURE_READY__?: (timeoutMs?: number) => Promise<void>;
    __ARGUS_RUN_CAPTURE__?: () => Promise<{
      ok: boolean;
      mimeType?: string;
      base64?: string;
      dataUrl?: string;
      charts?: unknown[];
      error?: string;
    }>;
  }
}

export {};
