export function ConfigModalSymbolsAndInterval() {
  return (
    <div className="space-y-3 pt-1">
      <div className="config-table-head">
        <span>展示名称</span>
        <span>TradingView 代码</span>
        <span className="config-col-actions" />
      </div>
      <div className="config-rows" id="config-rows" />
      <button type="button" className="btn-add-row" id="btn-config-add">
        + 添加品种
      </button>
    </div>
  );
}
