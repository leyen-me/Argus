export function LlmChartPreviewModal() {
  return (
    <div
      className="modal-backdrop llm-chart-preview-backdrop"
      id="llm-chart-preview-modal"
      hidden
      aria-modal="true"
      role="dialog"
      aria-label="图表截图预览"
    >
      <div className="llm-chart-preview-dialog">
        <button
          type="button"
          className="modal-close llm-chart-preview-close"
          id="btn-llm-chart-preview-close"
          aria-label="关闭"
        >
          ×
        </button>
        <img className="llm-chart-preview-img" id="llm-chart-preview-img" alt="" />
      </div>
    </div>
  );
}
