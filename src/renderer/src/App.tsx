import { useEffect } from "react";
import { initArgusApp } from "./argus-renderer";

export default function App() {
  useEffect(() => {
    void initArgusApp();
  }, []);

  return (
    <>
      <div className="app">
        <header className="titlebar">
          <span className="titlebar-traffic-guard" aria-hidden="true" />
          <span className="titlebar-title">Argus</span>
          <div className="titlebar-actions">
            <button
              type="button"
              className="titlebar-config"
              id="btn-fish-mode"
              title="按 ESC 退出"
              aria-pressed="false"
            >
              摸鱼模式
            </button>
            <button type="button" className="titlebar-config" id="btn-open-devtools" title="开发者工具">
              控制台
            </button>
            <button type="button" className="titlebar-config" id="btn-open-config" title="配置中心">
              配置
            </button>
          </div>
        </header>
        <main className="main">
          <section className="panel panel-chart" aria-label="TradingView 图表">
            <div className="panel-header">
              <span className="panel-label">行情</span>
              <select id="symbol-select" className="symbol-select" title="交易对" />
            </div>
            <div className="chart-wrap">
              <div id="tradingview_chart" className="tradingview-chart" />
            </div>
          </section>
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
        </main>
      </div>

      <div
        className="modal-backdrop"
        id="config-modal"
        hidden
        aria-modal="true"
        role="dialog"
        aria-labelledby="config-modal-title"
      >
        <div className="modal">
          <div className="modal-header">
            <h2 className="modal-title" id="config-modal-title">
              配置中心
            </h2>
            <button type="button" className="modal-close" id="btn-config-close" aria-label="关闭">
              ×
            </button>
          </div>
          <p className="modal-desc">
            配置行情下拉列表中的品种。展示名称可自定义；<strong>TradingView 代码</strong>需与
            <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
              TradingView
            </a>
            中一致（如 <code>BINANCE:BTCUSDT</code>、<code>OKX:BTCUSDT</code>）。本应用<strong>仅</strong>支持{" "}
            <code>BINANCE:</code> 或 <code>OKX:</code> 前缀的加密品种（交易所 WS 订阅 K 线）。
            <strong>interval</strong> 与图表周期、WS K 线周期一致。应用只使用<strong>一份</strong>配置文件{" "}
            <code>config.json</code>（路径见下），首次启动会从安装目录旁模板生成；保存配置即写回该文件。
          </p>
          <p className="modal-path" id="config-file-path" />
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
          <div className="config-section-title">LLM（OpenAI 兼容接口）</div>
          <p className="modal-hint modal-hint-llm">
            API Key 保存在本机用户目录配置文件；未填写时使用环境变量 <code>OPENAI_API_KEY</code>
            （配置优先）。填写后即可启用分析。
          </p>
          <div className="config-interval-row">
            <label htmlFor="config-openai-api-key">API Key</label>
            <input
              type="password"
              id="config-openai-api-key"
              className="config-in config-openai-input"
              placeholder="sk-… 或兼容服务的密钥"
              spellCheck={false}
              autoComplete="new-password"
            />
          </div>
          <div className="config-interval-row">
            <label htmlFor="config-openai-base-url">API 根 URL</label>
            <input
              type="text"
              id="config-openai-base-url"
              className="config-in config-openai-input"
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="config-interval-row">
            <label htmlFor="config-openai-model">模型 model</label>
            <input
              type="text"
              id="config-openai-model"
              className="config-in config-openai-input"
              placeholder="gpt-4o-mini"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="config-interval-row config-checkbox-row">
            <label htmlFor="config-llm-reasoning" className="config-checkbox-label">
              深度思考 reasoning
            </label>
            <input
              type="checkbox"
              id="config-llm-reasoning"
              title="OpenRouter 发 reasoning.enabled；通义等发 enable_thinking，并流式展示思考；默认关闭"
            />
          </div>
          <p className="modal-hint modal-hint-llm modal-hint-after-reasoning">
            <a href="https://openrouter.ai/docs" target="_blank" rel="noreferrer">
              OpenRouter
            </a>
            使用 <code>{`reasoning: { "enabled": true }`}</code>；其它兼容端点（如阿里云通义）使用
            <code>enable_thinking: true</code>。仅部分模型支持；不支持时可能被忽略或报错。
          </p>
          <div className="config-section-title">仓位变化邮件（QQ 邮箱 SMTP）</div>
          <p className="modal-hint modal-hint-llm">
            当模拟仓位<strong>开仓、平仓</strong>或<strong>触发止损/止盈</strong>时发送邮件。需在
            <a
              href="https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/authorizationCode"
              target="_blank"
              rel="noreferrer"
            >
              QQ 邮箱
            </a>
            开启 SMTP，并使用<strong>授权码</strong>作为密码（非 QQ 登录密码）。也可用环境变量
            <code>ARGUS_SMTP_USER</code>、<code>ARGUS_SMTP_PASS</code>；收件人可用{" "}
            <code>ARGUS_NOTIFY_EMAIL_TO</code>。
          </p>
          <div className="config-interval-row config-checkbox-row">
            <label htmlFor="config-trade-notify-email" className="config-checkbox-label">
              启用仓位邮件
            </label>
            <input
              type="checkbox"
              id="config-trade-notify-email"
              title="写入 config.json 的 tradeNotifyEmailEnabled"
            />
          </div>
          <div className="config-interval-row">
            <label htmlFor="config-smtp-user">发件 QQ 邮箱</label>
            <input
              type="text"
              id="config-smtp-user"
              className="config-in config-openai-input"
              placeholder="123456789@qq.com"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="config-interval-row">
            <label htmlFor="config-smtp-pass">SMTP 授权码</label>
            <input
              type="password"
              id="config-smtp-pass"
              className="config-in config-openai-input"
              placeholder="在 QQ 邮箱设置中生成"
              spellCheck={false}
              autoComplete="new-password"
            />
          </div>
          <div className="config-interval-row">
            <label htmlFor="config-notify-email-to">收件人（可选）</label>
            <input
              type="text"
              id="config-notify-email-to"
              className="config-in config-openai-input"
              placeholder="默认同发件邮箱"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
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
          <div className="config-section-title">系统提示词（策略）</div>
          <div className="config-interval-row">
            <label htmlFor="config-prompt-strategy">当前策略</label>
            <select
              id="config-prompt-strategy"
              className="symbol-select config-interval-select"
              title="每种策略对应 prompts 下的一个子文件夹"
            />
          </div>
          <p className="modal-hint modal-hint-llm">
            每种策略对应应用目录 <code>{`prompts/<策略文件夹>/system-crypto.txt`}</code>
            ；在下方选择要使用的策略，保存后写入 <code>config.json</code> 的
            <code>promptStrategy</code>。与行情一致：仅 <code>BINANCE:</code> / <code>OKX:</code> 或品种行{" "}
            <code>feed: crypto</code>。修改 txt 后保存配置或重新打开应用即可加载最新内容。
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="btn-secondary"
              id="btn-config-reset"
              title="将用户目录 config.json 恢复为安装目录模板（或内置默认值），API Key 等将清空"
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
        </div>
      </div>

      <div
        className="fish-mode-overlay"
        id="fish-mode-overlay"
        hidden
        aria-hidden="true"
        role="dialog"
        aria-modal="true"
        aria-label="按 ESC 退出"
      >
        <p className="fish-mode-hint">按 ESC 退出</p>
      </div>

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
    </>
  );
}
