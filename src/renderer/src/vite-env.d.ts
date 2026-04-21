/// <reference types="vite/client" />

/** Preload `contextBridge.exposeInMainWorld("argus", …)`（按需扩展） */
interface ArgusPreloadApi {
  getConfig?: () => Promise<Record<string, unknown>>
  saveConfig?: (partial: Record<string, unknown>) => Promise<unknown>
}

declare global {
  interface Window {
    argus?: ArgusPreloadApi
  }
}

export {}
