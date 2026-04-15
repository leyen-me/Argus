/**
 * OpenAI 兼容 Chat Completions，供长桥推送与加密（Binance WS）共用。
 * 默认不调用：需 ARGUS_ENABLE_LLM=1 且配置 OPENAI_API_KEY。
 */
function isLlmEnabled() {
  return process.env.ARGUS_ENABLE_LLM === "1" && !!process.env.OPENAI_API_KEY;
}

/**
 * @param {string} userText K 线文字说明（textForLlm）
 * @param {{
 *   imageBase64?: string | null,
 *   mimeType?: string,
 *   baseUrl?: string,
 *   model?: string,
 * }} [options] 截图多模态；baseUrl/model 优先来自应用配置，未配置时可用环境变量 OPENAI_BASE_URL / OPENAI_MODEL
 */
async function callOpenAIChat(userText, options = {}) {
  if (!isLlmEnabled()) {
    return { ok: false, text: "LLM 未启用。" };
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      text: "未设置 OPENAI_API_KEY。请在启动环境中配置后重启应用。",
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

module.exports = { callOpenAIChat, buildUserPrompt, isLlmEnabled };
