/**
 * OpenAI 兼容 Chat Completions，供长桥推送与加密（Binance WS）共用。
 * 启用条件：ARGUS_ENABLE_LLM=1，且 API Key 来自配置 openaiApiKey 或环境变量 OPENAI_API_KEY（配置优先）。
 */
function resolveOpenAiApiKey(cfg) {
  const fromCfg = cfg && typeof cfg.openaiApiKey === "string" ? cfg.openaiApiKey.trim() : "";
  if (fromCfg) return fromCfg;
  return (process.env.OPENAI_API_KEY || "").trim();
}

/** @param {object} [cfg] loadAppConfig() 结果 */
function isLlmEnabled(cfg) {
  return process.env.ARGUS_ENABLE_LLM === "1" && !!resolveOpenAiApiKey(cfg);
}

/**
 * @param {string} userText K 线文字说明（textForLlm）
 * @param {{
 *   appConfig: object,
 *   imageBase64?: string | null,
 *   mimeType?: string,
 *   baseUrl?: string,
 *   model?: string,
 * }} options appConfig 为 loadAppConfig()，用于解析 API Key 与开关
 */
async function callOpenAIChat(userText, options = {}) {
  const cfg = options.appConfig;
  if (!isLlmEnabled(cfg)) {
    return { ok: false, text: "LLM 未启用。" };
  }
  const apiKey = resolveOpenAiApiKey(cfg);
  if (!apiKey) {
    return {
      ok: false,
      text: "未配置 API Key：请在配置中心填写，或设置环境变量 OPENAI_API_KEY。",
    };
  }
  const model =
    (options.model && String(options.model).trim()) ||
    process.env.OPENAI_MODEL ||
    "gpt-4o-mini";
  const baseRaw =
    (options.baseUrl && String(options.baseUrl).trim()) ||
    process.env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1";
  const base = baseRaw.replace(/\/+$/, "");
  const url = `${base}/chat/completions`;

  const imageBase64 = options.imageBase64 && String(options.imageBase64).trim();
  const mimeType = options.mimeType || "image/png";
  const userContent =
    imageBase64
      ? [
          {
            type: "text",
            text:
              userText +
              "\n\n（附图：当前 TradingView 图表截图，请结合上文 OHLC 与成交量一并分析。）",
          },
          {
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${imageBase64}` },
          },
        ]
      : userText;

  const body = {
    model,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          "你是资深市场分析助手。根据用户给出的单根 K 线（已收盘确认）数据，用简体中文给出简洁分析：" +
          "短期趋势判断、关键观察点、风险提醒。若有图表截图，请结合价位与形态简述。控制在 200 字以内，勿输出 Markdown 代码块。",
      },
      { role: "user", content: userContent },
    ],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg = json?.error?.message || res.statusText || "请求失败";
    return { ok: false, text: `LLM 请求错误：${errMsg}` };
  }
  const text = json?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    return { ok: false, text: "LLM 返回为空。" };
  }
  return { ok: true, text };
}

function buildUserPrompt(symbol, periodKey, candle) {
  return [
    `标的：${symbol}`,
    `周期：${periodKey}（该 K 线已收盘确认）`,
    `时间：${candle.timestamp}`,
    `开 ${candle.open}  高 ${candle.high}  低 ${candle.low}  收 ${candle.close}`,
    `成交量：${candle.volume}`,
    candle.turnover != null ? `成交额：${candle.turnover}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

module.exports = { callOpenAIChat, buildUserPrompt, isLlmEnabled, resolveOpenAiApiKey };
