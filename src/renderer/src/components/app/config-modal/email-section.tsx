export function ConfigModalEmailSection() {
  return (
    <>
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
    </>
  );
}
