const { contextBridge, ipcRenderer } = require("electron");

/**
 * 预留：后续 LLM 分析结果通过 IPC 从主进程推送到渲染进程
 */
contextBridge.exposeInMainWorld("argus", {
  onAnalysisUpdate: (callback) => {
    ipcRenderer.on("llm-analysis-update", (_event, payload) => {
      callback(payload);
    });
  },
  requestAnalysis: (payload) => ipcRenderer.invoke("llm-request-analysis", payload),
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  getConfigPath: () => ipcRenderer.invoke("config:path"),
});
