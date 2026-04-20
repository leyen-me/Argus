import { ConfigHelpTooltip } from "./config-help-tooltip";

export function ConfigModalIntro() {
  return (
    <div className="flex items-start gap-2 pb-2">
      <p className="m-0 flex-1 text-sm leading-snug text-muted-foreground">
        编辑本机 SQLite 中的应用设置：交易品种、K 线周期、LLM 与交易所等。数据库路径见下方。
      </p>
      <ConfigHelpTooltip className="mt-0.5">
        <div className="space-y-2">
          <p className="m-0">
            展示名称可自定义；<strong>TradingView 代码</strong>须与{" "}
            <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
              TradingView
            </a>{" "}
            一致（如 <code>BINANCE:BTCUSDT</code>、<code>OKX:BTCUSDT</code>）。
          </p>
          <p className="m-0">
            仅支持 <code>BINANCE:</code> 或 <code>OKX:</code> 前缀（交易所 WebSocket 订阅 K 线）。
            <strong>interval</strong> 与图表周期、WS 一致。
          </p>
          <p className="m-0">
            首次启动会用代码中的默认种子写入本地库；保存即写回 SQLite。
          </p>
        </div>
      </ConfigHelpTooltip>
    </div>
  );
}
