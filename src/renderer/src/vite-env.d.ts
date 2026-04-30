/// <reference types="vite/client" />

declare global {
  interface Window {
    argus?: import("./argus-bridge").ArgusBridge;
    argusLastBarClose?: unknown;
    argusLastChartImage?: unknown;
  }
}

export {};
