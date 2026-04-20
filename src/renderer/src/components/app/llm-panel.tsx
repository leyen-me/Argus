export function LlmPanel() {
  return (
    <section className="panel panel-llm" aria-label="LLM 分析">
      <div className="panel-header">
        <span className="panel-label">LLM 分析</span>
        <div className="panel-header-actions">
          <span
            className="panel-badge panel-badge--usage"
            id="llm-context-usage"
            title="启用 LLM 后，每次收盘请求会显示估算输入占比。默认按 200K 上下文窗口；可用环境变量 ARGUS_CONTEXT_WINDOW_TOKENS 覆盖。含图时为粗估。"
          >
            —
          </span>
          <span className="panel-badge panel-badge--status" id="llm-status" title="">
            就绪
          </span>
        </div>
      </div>
      <div
        className="llm-trade-state-bar"
        id="llm-trade-state-bar"
        role="status"
        aria-live="polite"
        title="由应用维护的交易状态；未启用 OKX 永续下单时仅为纪律模拟。"
      >
        <span className="llm-trade-state-label">状态机</span>
        <span className="llm-trade-state-text" id="llm-trade-state-text">
          —
        </span>
      </div>
      <div
        className="okx-position-bar"
        id="okx-position-bar"
        hidden
        role="status"
        aria-live="polite"
        title="来自 OKX GET /api/v5/account/positions（当前图表对应永续）；模拟盘请在模拟交易环境内查看。"
      >
        <span className="okx-position-label">OKX 持仓</span>
        <div className="okx-position-body-wrap">
          <span className="okx-position-text" id="okx-position-text">
            —
          </span>
        </div>
        <button type="button" className="okx-position-refresh" id="okx-position-refresh" title="重新查询">
          刷新
        </button>
      </div>
      <div className="llm-body">
        <div
          className="llm-current-system"
          id="llm-current-system"
          aria-label="当前图表品种对应的系统提示词"
        />
        <div
          className="llm-chat-history"
          id="llm-chat-history"
          hidden
          aria-label="各次 K 线收盘与 LLM 回复"
        />
      </div>
    </section>
  );
}
