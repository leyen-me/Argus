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

const SYSTEM_PROMPT =
  "你是资深市场分析助手。用户会进行**多轮对话**：每轮提供一根**已收盘确认**的 K 线数据，必要时附带当前图表截图。" +
  "请结合**此前对话中你已给出的判断**，与本轮新数据衔接分析，用简体中文作答：短期趋势、关键价位与观察点、风险提醒。" +
  "单轮回复仍宜简洁（约 200 字内），勿输出 Markdown 代码块。";

/**
 * 本轮发给 API 的 user 内容（含多模态）；历史轮仅存纯文本，见 llm-context。
 */
function buildMultimodalUserContent(userText, imageBase64, mimeType) {
  const image = imageBase64 && String(imageBase64).trim();
  const mt = mimeType || "image/png";
  if (image) {
    return [
      {
        type: "text",
        text:
          userText +
          "\n\n（附图：当前 TradingView 图表截图，请结合上文 OHLC 与成交量一并分析。）",
      },
      {
        type: "image_url",
        image_url: { url: `data:${mt};base64,${image}` },
      },
    ];
  }
  return userText;
}

/**
 * 写入持久化历史的用户文本（与本轮 user 中文字部分一致，便于模型下次读到同一语义）。
 */
function buildUserTextForHistory(userText, hasImage) {
  if (!hasImage) return userText;
  return (
    userText +
    "\n\n（附图：当前 TradingView 图表截图，已与本条一并提交模型；更早轮次在历史中仅保存文字。）"
  );
}

/**
 * @param {Array<{ role: string, content: unknown }>} messages 须已含 system + 可选历史 + 本轮 user
 * @param {{ appConfig: object, baseUrl?: string, model?: string }} options
 * @param {boolean} stream
 */
function buildChatCompletionRequestFromMessages(messages, options, stream) {
  const cfg = options.appConfig;
  const apiKey = resolveOpenAiApiKey(cfg);
  if (!apiKey) {
    return { error: "未配置 API Key：请在配置中心填写，或设置环境变量 OPENAI_API_KEY。" };
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

  const body = {
    model,
    temperature: 0.3,
    stream: !!stream,
    messages,
  };

  return {
    url,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body,
  };
}

/**
 * @deprecated 单轮；内部仍拼成 messages
 */
function buildChatCompletionRequest(userText, options, stream) {
  const userContent = buildMultimodalUserContent(
    userText,
    options.imageBase64,
    options.mimeType,
  );
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
  return buildChatCompletionRequestFromMessages(messages, options, stream);
}

/**
 * 流式：完整 messages（含多轮历史）
 * @param {(ev: { type: 'delta', piece: string, full: string } | { type: 'done', full: string }) => void} onEvent
 */
async function streamOpenAIChat(messages, options, onEvent) {
  const cfg = options.appConfig;
  if (!isLlmEnabled(cfg)) {
    return { ok: false, text: "LLM 未启用。" };
  }
  const req = buildChatCompletionRequestFromMessages(messages, options, true);
  if (req.error) {
    return { ok: false, text: req.error };
  }

  const res = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify(req.body),
  });

  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    const errMsg = json?.error?.message || res.statusText || "请求失败";
    return { ok: false, text: `LLM 请求错误：${errMsg}` };
  }

  if (!res.body) {
    return { ok: false, text: "LLM 响应无正文（流式）。" };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let fullText = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, nl).replace(/\r$/, "");
        carry = carry.slice(nl + 1);
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === "[DONE]") continue;
        let json;
        try {
          json = JSON.parse(dataStr);
        } catch {
          continue;
        }
        const piece = json.choices?.[0]?.delta?.content ?? "";
        if (piece) {
          fullText += piece;
          onEvent({ type: "delta", piece, full: fullText });
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }

  const trimmed = fullText.trim();
  onEvent({ type: "done", full: trimmed });
  if (!trimmed) {
    return { ok: false, text: "LLM 返回为空。" };
  }
  return { ok: true, text: trimmed };
}

/**
 * 非流式（备用）
 */
async function callOpenAIChat(userText, options = {}) {
  const cfg = options.appConfig;
  if (!isLlmEnabled(cfg)) {
    return { ok: false, text: "LLM 未启用。" };
  }
  const req = buildChatCompletionRequest(userText, options, false);
  if (req.error) {
    return { ok: false, text: req.error };
  }

  const res = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify(req.body),
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

module.exports = {
  callOpenAIChat,
  streamOpenAIChat,
  buildUserPrompt,
  buildMultimodalUserContent,
  buildUserTextForHistory,
  buildChatCompletionRequestFromMessages,
  SYSTEM_PROMPT,
  isLlmEnabled,
  resolveOpenAiApiKey,
};
