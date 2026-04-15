const { contextBridge, ipcRenderer } = require("electron");

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
  setMarketContext: (tvSymbol) => ipcRenderer.invoke("market:set-context", tvSymbol),
  requestAnalysis: (payload) => ipcRenderer.invoke("llm-request-analysis", payload),
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  getConfigPath: () => ipcRenderer.invoke("config:path"),
});
