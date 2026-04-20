export function ConfigModalLlmSection() {
  return (
    <>
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
    </>
  );
}
