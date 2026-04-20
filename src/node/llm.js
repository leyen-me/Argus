/**
 * OpenAI 兼容 Chat Completions（官方 `openai` Node SDK + 任意兼容端点），供 OKX WS K 线收盘分析共用。
 * 启用条件：在配置中填写 openaiApiKey，或设置环境变量 OPENAI_API_KEY（配置优先）。
 */
const { OpenAI, APIError, APIUserAbortError } = require("openai");
const { loadSystemPromptsFromDisk } = require("./app-config");
function resolveOpenAiApiKey(cfg) {
  const fromCfg = cfg && typeof cfg.openaiApiKey === "string" ? cfg.openaiApiKey.trim() : "";
  if (fromCfg) return fromCfg;
  return (process.env.OPENAI_API_KEY || "").trim();
}

/** @param {object} [cfg] loadAppConfig() 结果 */
function isLlmEnabled(cfg) {
  return !!resolveOpenAiApiKey(cfg);
}

/**
 * @param {object | null | undefined} cfg loadAppConfig() 结果（须含 systemPromptCrypto，来自库表 prompt_strategies）
 */
function resolveSystemPrompt(cfg) {
  const p = cfg || loadSystemPromptsFromDisk();
  return p.systemPromptCrypto;
}

/** 与界面默认展示的「上下文窗口」一致（可用环境变量 ARGUS_CONTEXT_WINDOW_TOKENS 覆盖） */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

const DEFAULT_LLM_TIMEOUT_MS = 300_000;

/** @param {object | null | undefined} cfg */
function llmRequestTimeoutMs(cfg) {
  let ms = Number(cfg?.llmRequestTimeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) ms = DEFAULT_LLM_TIMEOUT_MS;
  return Math.floor(ms);
}

/** @param {object | null | undefined} cfg */
function llmAbortSignal(cfg) {
  const ms = llmRequestTimeoutMs(cfg);
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ms);
  return ac.signal;
}

/** OpenRouter 专用 `reasoning`；其余兼容端点（如通义 DashScope）用 `enable_thinking`，见 tests/dashscope-generation-demo.test.js */
function isOpenRouterBaseUrl(baseURL) {
  return String(baseURL || "").toLowerCase().includes("openrouter.ai");
}

/** 阿里云通义兼容模式根 URL（用于显式开关 enable_thinking） */
function isDashScopeBaseUrl(baseURL) {
  return String(baseURL || "").toLowerCase().includes("dashscope.aliyuncs.com");
}

/** @param {unknown} e
 * @param {object | null | undefined} cfg */
function mapLlmSdkError(e, cfg) {
  const timeoutMsg =
    "LLM 请求超时（可在应用设置里改 llmRequestTimeoutMs，单位毫秒）";
  if (e instanceof APIUserAbortError) {
    return { ok: false, text: timeoutMsg };
  }
  if (e && typeof e === "object" && (e.name === "AbortError" || e.code === "ABORT_ERR")) {
    return { ok: false, text: timeoutMsg };
  }
  if (e instanceof APIError) {
    return { ok: false, text: `LLM 请求错误：${e.message}` };
  }
  const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
  return { ok: false, text: `LLM 请求失败：${msg}` };
}

/**
 * 粗估文本 tokens（偏中文场景，略偏保守以免低估）。
 * @param {string} s
 */
function estimateTextTokens(s) {
  const t = String(s || "");
  if (!t) return 0;
  return Math.ceil(t.length / 3);
}

/**
 *  vision 输入无法本地精确计 token，按 base64 体积给一个量级估计（与 OpenAI 按块计费不同，仅用于占比参考）。
 * @param {string} b64
 */
function estimateImageTokensFromBase64(b64) {
  if (!b64 || typeof b64 !== "string") return 0;
  const len = b64.trim().length;
  if (len < 80) return 0;
  const approxBytes = Math.floor((len * 3) / 4);
  const raw = 300 + Math.floor(approxBytes / 800);
  return Math.min(12000, Math.max(400, raw));
}

/**
 * @param {unknown} content message.content：string 或 multimodal 数组
 */
function estimateContentTokens(content) {
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") n += estimateTextTokens(part.text);
    if (part.type === "image_url" && part.image_url && typeof part.image_url.url === "string") {
      const url = part.image_url.url;
      const idx = url.indexOf("base64,");
      const b64 = idx >= 0 ? url.slice(idx + 7) : "";
      n += estimateImageTokensFromBase64(b64);
    }
  }
  return n;
}

/**
 * 估算本次请求 messages 的 prompt tokens（含 system / 历史 / 本轮；不含 API 返回的 completion）。
 * @param {Array<{ role?: string, content?: unknown }>} messages
 */
function estimatePromptTokensFromMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) {
    if (!m) continue;
    total += 4;
    total += estimateContentTokens(m.content);
  }
  return total;
}

/**
 * 将多模态 user 消息压成纯文本（去掉 image_url 等），供历史轮或非最后一轮使用。
 * @param {{ role: string, content: unknown }} m
 */
function userMessageToTextOnly(m) {
  const c = m.content;
  if (typeof c === "string") return m;
  if (!Array.isArray(c)) return m;
  const texts = c
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text);
  const text = texts.join("\n").trim();
  return { role: "user", content: text.length ? text : "（历史轮附图已从 API 请求中省略，仅保留文字。）" };
}

/**
 * 确保仅**最后一则** user 消息可携带图片；更早的 user 若含多模态则剥掉图片，避免重复传图。
 * @param {Array<{ role?: string, content?: unknown }>} messages
 */
function keepOnlyLastUserImageInMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return messages;
  return messages.map((m, i) => {
    if (!m || m.role !== "user") return m;
    if (i === lastUserIdx) return m;
    return userMessageToTextOnly(m);
  });
}

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
  const baseURL = baseRaw.replace(/\/+$/, "");

  const body = {
    model,
    temperature: 0.3,
    stream: !!stream,
    messages,
  };
  if (cfg && cfg.llmReasoningEnabled === true) {
    if (isOpenRouterBaseUrl(baseURL)) {
      body.reasoning = { enabled: true };
    } else {
      body.enable_thinking = true;
    }
  } else if (isDashScopeBaseUrl(baseURL)) {
    /** 关闭界面「深度思考」时向通义显式关思考；否则部分模型仍可能走推理通道。 */
    body.enable_thinking = false;
  }

  return { baseURL, body };
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
  const cfg = options.appConfig;
  const systemContent = cfg ? resolveSystemPrompt(cfg) : "";
  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];
  return buildChatCompletionRequestFromMessages(messages, options, stream);
}

/**
 * OpenAI 兼容流式 `delta.content`：多为 string，少数网关会发多段数组（与 Chat Completions 非流式 message.content 形态一致）。
 * @param {unknown} content
 */
function deltaContentToString(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let s = "";
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = /** @type {{ type?: string, text?: string }} */ (part);
      if (p.type === "text" && typeof p.text === "string") s += p.text;
    }
    return s;
  }
  return "";
}

/**
 * 非流式 `message.content`：string 或 parts 数组。
 * @param {unknown} content
 */
function messageContentToString(content) {
  return deltaContentToString(content);
}

/**
 * 从流式 chunk 的 delta 中取出**本 chunk** 的推理片段（不跨 chunk 累加）。
 * 同一 chunk 内 OpenRouter 常同时带 `reasoning` 与 `reasoning_details` 的等价文本，只取一种以免「好的好的」式重复。
 * @param {Record<string, unknown>} delta
 */
function appendReasoningFromDelta(delta) {
  if (!delta || typeof delta !== "object") return "";
  const details = delta.reasoning_details;
  if (Array.isArray(details) && details.length > 0) {
    let s = "";
    for (const d of details) {
      if (!d || typeof d !== "object") continue;
      const t = d.type;
      if (t === "reasoning.text" && typeof d.text === "string") s += d.text;
      else if (t === "reasoning.summary" && typeof d.summary === "string") s += d.summary;
    }
    if (s) return s;
  }
  const r = delta.reasoning ?? delta.reasoning_content;
  if (typeof r === "string" && r) return r;
  return "";
}

/**
 * 合并推理流：有的网关按**增量**发片段，有的按**当前全文**（新文以旧文为前缀）发；二者混用会叠字。
 * @param {string} prev
 * @param {string} piece
 */
function mergeReasoningChunk(prev, piece) {
  const p = String(piece || "");
  if (!p) return prev;
  const base = String(prev || "");
  if (!base) return p;
  if (p.startsWith(base) && p.length >= base.length) return p;
  return base + p;
}

/**
 * 流式：完整 messages（含多轮历史）
 * @param {(ev:
 *   | { type: 'delta', piece: string, full: string, reasoningFull: string }
 *   | { type: 'done', full: string, reasoningFull: string }
 * ) => void} onEvent
 */
async function streamOpenAIChat(messages, options, onEvent) {
  const cfg = options.appConfig;
  if (!isLlmEnabled(cfg)) {
    return { ok: false, text: "LLM 未启用。" };
  }
  const built = buildChatCompletionRequestFromMessages(messages, options, true);
  if (built.error) {
    return { ok: false, text: built.error };
  }

  const apiKey = resolveOpenAiApiKey(cfg);
  const signal = llmAbortSignal(cfg);
  const client = new OpenAI({
    apiKey,
    baseURL: built.baseURL,
    timeout: llmRequestTimeoutMs(cfg),
    maxRetries: 0,
  });

  let fullText = "";
  let fullReasoning = "";
  const wantReasoning = !!(cfg && cfg.llmReasoningEnabled === true);

  try {
    const stream = await client.chat.completions.create(built.body, { signal });
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      const d =
        delta && typeof delta === "object" ? /** @type {Record<string, unknown>} */ (delta) : {};
      const contentPiece = deltaContentToString(d.content);

      if (wantReasoning) {
        const rawReasoning = appendReasoningFromDelta(d);
        if (contentPiece) fullText += contentPiece;
        if (rawReasoning) fullReasoning = mergeReasoningChunk(fullReasoning, rawReasoning);
        if (contentPiece || rawReasoning) {
          onEvent({
            type: "delta",
            piece: contentPiece,
            full: fullText,
            reasoningFull: fullReasoning,
          });
        }
      } else {
        /** 未开深度思考时：正文只认 delta.content，不把 reasoning 通道合并进助手气泡（避免满屏「思考腔」）。 */
        if (contentPiece) {
          fullText += contentPiece;
          onEvent({
            type: "delta",
            piece: contentPiece,
            full: fullText,
            reasoningFull: "",
          });
        }
      }
    }
  } catch (e) {
    return mapLlmSdkError(e, cfg);
  }

  const trimmed = fullText.trim();
  const reasoningTrimmed = fullReasoning.trim();
  onEvent({ type: "done", full: trimmed, reasoningFull: wantReasoning ? reasoningTrimmed : "" });
  if (!trimmed && !reasoningTrimmed) {
    return { ok: false, text: "LLM 返回为空。" };
  }
  return {
    ok: true,
    text: trimmed,
    reasoningText: wantReasoning ? reasoningTrimmed : "",
  };
}

/**
 * 非流式（备用）
 */
async function callOpenAIChat(userText, options = {}) {
  const cfg = options.appConfig;
  if (!isLlmEnabled(cfg)) {
    return { ok: false, text: "LLM 未启用。" };
  }
  const built = buildChatCompletionRequest(userText, options, false);
  if (built.error) {
    return { ok: false, text: built.error };
  }

  const apiKey = resolveOpenAiApiKey(cfg);
  const signal = llmAbortSignal(cfg);
  const client = new OpenAI({
    apiKey,
    baseURL: built.baseURL,
    timeout: llmRequestTimeoutMs(cfg),
    maxRetries: 0,
  });

  try {
    const completion = await client.chat.completions.create(built.body, { signal });
    const rawMsg = completion?.choices?.[0]?.message?.content;
    const text = messageContentToString(rawMsg).trim();
    if (!text) {
      return { ok: false, text: "LLM 返回为空。" };
    }
    return { ok: true, text };
  } catch (e) {
    return mapLlmSdkError(e, cfg);
  }
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
  resolveSystemPrompt,
  isLlmEnabled,
  resolveOpenAiApiKey,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  estimatePromptTokensFromMessages,
  keepOnlyLastUserImageInMessages,
};
