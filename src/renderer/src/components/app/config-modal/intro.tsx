export function ConfigModalIntro() {
  return (
    <>
      <p className="modal-desc">
        配置行情下拉列表中的品种。展示名称可自定义；<strong>TradingView 代码</strong>需与
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          TradingView
        </a>
        中一致（如 <code>BINANCE:BTCUSDT</code>、<code>OKX:BTCUSDT</code>）。本应用<strong>仅</strong>支持{" "}
        <code>BINANCE:</code> 或 <code>OKX:</code> 前缀的加密品种（交易所 WS 订阅 K 线）。
        <strong>interval</strong> 与图表周期、WS K 线周期一致。应用只使用<strong>一份</strong>配置文件{" "}
        <code>config.json</code>（路径见下），首次启动会从内置模板 <code>src/config.json</code> 生成用户目录配置；保存配置即写回用户目录该文件。
      </p>
      <p className="modal-path" id="config-file-path" />
    </>
  );
}
