/**
 * OpenAI 兼容 Chat Completions，供长桥推送与加密（Binance WS）共用。
 */
async function callOpenAIChat(userContent) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      text: "未设置 OPENAI_API_KEY。请在启动环境中配置后重启应用。",
    };
  }
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const url = `${base}/chat/completions`;
  const body = {
    model,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          "你是资深市场分析助手。根据用户给出的单根 K 线（已收盘确认）数据，用简体中文给出简洁分析：" +
          "短期趋势判断、关键观察点、风险提醒。控制在 200 字以内，勿输出 Markdown 代码块。",
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

module.exports = { callOpenAIChat, buildUserPrompt };
