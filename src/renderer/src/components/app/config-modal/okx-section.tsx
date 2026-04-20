export function ConfigModalOkxSection() {
  return (
    <>
      <div className="config-section-title">OKX USDT 永续（状态机联动）</div>
      <p className="modal-hint modal-hint-llm">
        仅在 <code>OKX:*</code> 加密品种上生效：状态机从观望进入持仓、平仓进冷静期、或止损/止盈硬触发时，向
        OKX 下对应永续合约市价单。 合约代码由 <code>OKX:BTCUSDT</code> 映射为{" "}
        <code>BTC-USDT-SWAP</code>。默认使用账户 USDT 可用权益的 <strong>25%</strong>{" "}
        作为保证金，名义约 = 保证金 × 杠杆。 模拟盘请使用 OKX 模拟交易页的 API
        密钥，并保持「模拟交易」勾选；实盘请取消模拟并填写正式密钥。
        <strong>默认关闭下单</strong>，避免误操作。
      </p>
      <div className="config-interval-row config-checkbox-row">
        <label htmlFor="config-okx-swap-enabled" className="config-checkbox-label">
          启用 OKX 永续下单
        </label>
        <input type="checkbox" id="config-okx-swap-enabled" title="okxSwapTradingEnabled" />
      </div>
      <div className="config-interval-row config-checkbox-row">
        <label htmlFor="config-okx-simulated" className="config-checkbox-label">
          模拟交易（x-simulated-trading）
        </label>
        <input type="checkbox" id="config-okx-simulated" title="okxSimulated" />
      </div>
      <div className="config-interval-row">
        <label htmlFor="config-okx-api-key">API Key</label>
        <input
          type="password"
          id="config-okx-api-key"
          className="config-in config-openai-input"
          placeholder="OKX API Key"
          spellCheck={false}
          autoComplete="new-password"
        />
      </div>
      <div className="config-interval-row">
        <label htmlFor="config-okx-secret-key">Secret</label>
        <input
          type="password"
          id="config-okx-secret-key"
          className="config-in config-openai-input"
          placeholder="OKX Secret Key"
          spellCheck={false}
          autoComplete="new-password"
        />
      </div>
      <div className="config-interval-row">
        <label htmlFor="config-okx-passphrase">Passphrase</label>
        <input
          type="password"
          id="config-okx-passphrase"
          className="config-in config-openai-input"
          placeholder="创建 API 时设置的口令"
          spellCheck={false}
          autoComplete="new-password"
        />
      </div>
      <div className="config-interval-row">
        <label htmlFor="config-okx-leverage">杠杆倍数</label>
        <input
          type="number"
          id="config-okx-leverage"
          className="config-in config-openai-input"
          min={1}
          max={125}
          step={1}
          title="okxSwapLeverage"
        />
      </div>
      <div className="config-interval-row">
        <label htmlFor="config-okx-margin-fraction">保证金占权益比例</label>
        <input
          type="number"
          id="config-okx-margin-fraction"
          className="config-in config-openai-input"
          min={0.01}
          max={1}
          step={0.01}
          title="okxSwapMarginFraction，默认 0.25"
        />
      </div>
      <div className="config-interval-row">
        <label htmlFor="config-okx-td-mode">保证金模式</label>
        <select id="config-okx-td-mode" className="symbol-select config-interval-select" title="okxTdMode">
          <option value="isolated">逐仓 isolated（默认）</option>
          <option value="cross">全仓 cross</option>
        </select>
      </div>
    </>
  );
}
