/** 请求打开图表截图预览（沿用现有 DOM 版 LlmChartPreviewModal） */

export const ARGUS_LLM_CHART_PREVIEW_OPEN = "argus:llm-chart-preview-open" as const;

export type ArgusLlmChartPreviewOpenDetail = {
  dataUrl: string;
};
