export function ConfigModalStrategySection() {
  return (
    <>
      <div className="config-section-title">系统提示词（策略）</div>
      <div className="config-interval-row">
        <label htmlFor="config-prompt-strategy">当前策略</label>
        <select
          id="config-prompt-strategy"
          className="symbol-select config-interval-select"
          title="每种策略对应 src/prompts 下的一个子文件夹"
        />
      </div>
      <p className="modal-hint modal-hint-llm">
        每种策略对应 <code>{`src/prompts/<策略文件夹>/system-crypto.txt`}</code>
        ；在下方选择要使用的策略，保存后写入用户目录 <code>config.json</code> 的
        <code>promptStrategy</code>。与行情一致：仅 <code>BINANCE:</code> / <code>OKX:</code> 或品种行{" "}
        <code>feed: crypto</code>。修改 txt 后保存配置或重新打开应用即可加载最新内容。
      </p>
      <div className="modal-actions">
        <button
          type="button"
          className="btn-secondary"
          id="btn-config-reset"
          title="将用户目录 config.json 恢复为 src/config.json 模板（或内置默认值），API Key 等将清空"
        >
          恢复默认
        </button>
        <button type="button" className="btn-secondary" id="btn-config-cancel">
          取消
        </button>
        <button type="button" className="btn-primary" id="btn-config-save">
          保存
        </button>
      </div>
    </>
  );
}
