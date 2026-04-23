export function LlmSessionDetailModal() {
  return (
    <div
      className="modal-backdrop llm-session-detail-backdrop"
      id="llm-session-detail-modal"
      hidden
      aria-modal="true"
      role="dialog"
      aria-labelledby="llm-session-detail-title"
    >
      <div className="llm-session-detail-dialog">
        <div className="llm-session-detail-header">
          <h2 className="llm-session-detail-title" id="llm-session-detail-title">
            Agent 会话明细
          </h2>
          <button
            type="button"
            className="modal-close llm-session-detail-close"
            id="btn-llm-session-detail-close"
            aria-label="关闭"
          >
            ×
          </button>
        </div>
        <p className="llm-session-detail-subtitle" id="llm-session-detail-subtitle" hidden />
        <div className="llm-session-detail-loading" id="llm-session-detail-loading" hidden>
          加载中…
        </div>
        <div className="llm-session-detail-error" id="llm-session-detail-error" hidden />
        <div
          className="llm-session-detail-body"
          id="llm-session-detail-body"
          role="list"
          aria-label="多轮消息"
        />
      </div>
    </div>
  );
}
