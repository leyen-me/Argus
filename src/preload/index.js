import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("argus", {
  onMarketBarClose: (callback) => {
    ipcRenderer.on("market-bar-close", (_event, payload) => {
      callback(payload);
    });
  },
  onChartCaptureRequest: (callback) => {
    ipcRenderer.on("request-chart-capture", (_event, payload) => {
      callback(payload);
    });
  },
  submitChartCaptureResult: (result) => ipcRenderer.send("chart-capture-result", result),
  onMarketStatus: (callback) => {
    ipcRenderer.on("market-status", (_event, payload) => {
      callback(payload);
    });
  },
  onLlmStreamDelta: (callback) => {
    ipcRenderer.on("llm-stream-delta", (_event, payload) => {
      callback(payload);
    });
  },
  onLlmStreamEnd: (callback) => {
    ipcRenderer.on("llm-stream-end", (_event, payload) => {
      callback(payload);
    });
  },
  onLlmStreamError: (callback) => {
    ipcRenderer.on("llm-stream-error", (_event, payload) => {
      callback(payload);
    });
  },
  onOkxSwapStatus: (callback) => {
    ipcRenderer.on("okx-swap-status", (_event, payload) => {
      callback(payload);
    });
  },
  setMarketContext: (tvSymbol) => ipcRenderer.invoke("market:set-context", tvSymbol),
  requestAnalysis: (payload) => ipcRenderer.invoke("llm-request-analysis", payload),
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  resetConfig: () => ipcRenderer.invoke("config:reset"),
  getConfigPath: () => ipcRenderer.invoke("config:path"),
  openDevTools: () => ipcRenderer.invoke("devtools:open"),
  getOkxSwapPosition: (tvSymbol) => ipcRenderer.invoke("okx:swap-position", tvSymbol),
  listAgentBarTurnsPage: (args) => ipcRenderer.invoke("agent-bar-turns:list-page", args),
  getAgentBarTurnChart: (barCloseId) => ipcRenderer.invoke("agent-bar-turns:get-chart", barCloseId),
  listPromptStrategiesMeta: () => ipcRenderer.invoke("prompt-strategies:list"),
  getPromptStrategy: (id) => ipcRenderer.invoke("prompt-strategies:get", id),
  savePromptStrategy: (payload) => ipcRenderer.invoke("prompt-strategies:save", payload),
  deletePromptStrategy: (id) => ipcRenderer.invoke("prompt-strategies:delete", id),
  importBundledPromptStrategies: () => ipcRenderer.invoke("prompt-strategies:import-bundled"),
});
