export function ConfigModalSymbolsAndInterval() {
  return (
    <>
      <div className="config-table-head">
        <span>展示名称</span>
        <span>TradingView 代码</span>
        <span className="config-col-actions" />
      </div>
      <div className="config-rows" id="config-rows" />
      <button type="button" className="btn-add-row" id="btn-config-add">
        + 添加品种
      </button>
      <div className="config-default-row">
        <label htmlFor="config-default-symbol">默认打开</label>
        <select id="config-default-symbol" className="symbol-select config-default-select" />
      </div>
      <div className="config-interval-row">
        <label htmlFor="config-interval">K 线周期 interval</label>
        <select
          id="config-interval"
          className="symbol-select config-interval-select"
          title="与 TradingView、Binance/OKX WS 共用"
        >
          <option value="1">1 分钟</option>
          <option value="3">3 分钟</option>
          <option value="5">5 分钟</option>
          <option value="15">15 分钟</option>
          <option value="30">30 分钟</option>
          <option value="60">1 小时</option>
          <option value="120">2 小时</option>
          <option value="240">4 小时</option>
          <option value="D">日线</option>
        </select>
      </div>
    </>
  );
}
