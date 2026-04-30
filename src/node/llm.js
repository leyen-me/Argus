/**
 * OpenAI 兼容 Chat Completions（官方 `openai` Node SDK + 任意兼容端点），供 OKX WS K 线收盘分析共用。
 * 启用条件：在配置中填写 openaiApiKey，或设置环境变量 OPENAI_API_KEY（配置优先）。
 */
const { OpenAI, APIError, APIUserAbortError } = require("openai");
const { loadSystemPromptsFromDisk } = require("./app-config");

/** 交易 Agent：`resolveTradingAgentSystemPrompt` 在策略正文后附加；与用户策略库解耦。 */
const TRADING_AGENT_TOOLS_POLICY_BLOCK = `
#### 工具介绍

- open_position：开仓
- close_position：平仓
- cancel_order：撤销普通订单（不是止盈止损等算法单）
- amend_order：修改普通订单
- amend_tp_sl：修改止盈止损等算法单

#### 限价单与市价单

- 由于是 LLM Agent 交易，下单会有延迟，延迟会导致滑点、成交价格与预期不符。所以如果思考决策要开仓的话，请尽量使用限价单开仓。
- 除非用户明确要求使用市价单下单或者行情已经很明朗，再不上车就来不及了的情况，可以使用市价单开仓。
- 市价单通常用来平仓
- 完全平仓后止盈止损等算法单会自动撤销，所以不需要手动撤销算法单。

#### 交易频率

- 请观察最近动作和最近仓位历史，默认情况下，请合理的控制交易频率，不要过于频繁的进行交易。除非用户明确要求
- 交易频率是指每轮思考中，调用工具的次数。例如频繁开仓、频繁的调整止盈止损等，都属于过于频繁的交易。
- 不要在说观望的时候调用工具。
`;

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

/** 程序在策略正文后追加的工具与执行段落。 */
function buildTradingAgentStaticToolsAppend() {
  return `---\n\n### 工具与执行\n${TRADING_AGENT_TOOLS_POLICY_BLOCK.trimEnd()}`;
}

/**
 * K 线收盘交易 Agent：用户策略正文 + 程序固定的工具与执行说明。
 * @param {object | null | undefined} cfg
 */
function resolveTradingAgentSystemPrompt(cfg) {
  return composeSystemPrompt(String(resolveSystemPrompt(cfg) ?? ""), [buildTradingAgentStaticToolsAppend()]);
}

/**
 * 将任意多段文案拼成单一 system 正文（首尾 trim，段落间双换行）。
 * @param {string} strategyBody
 * @param {ReadonlyArray<string | undefined | null>} fragments
 */
function composeSystemPrompt(strategyBody, fragments = []) {
  const base = typeof strategyBody === "string" ? strategyBody.trimEnd() : "";
  const rest = fragments
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
  if (!rest) return base;
  if (!base) return rest;
  return `${base}\n\n${rest}`.trimEnd();
}

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

/** OpenRouter 专用 `reasoning`；阿里云 OpenAI 兼容链（DashScope、`*.maas.aliyuncs.com` 等）用 `enable_thinking`。 */
function isOpenRouterBaseUrl(baseURL) {
  return String(baseURL || "").toLowerCase().includes("openrouter.ai");
}

/**
 * 阿里云 OpenAI 兼容推理网关：需在请求体显式开关 `enable_thinking`。
 * - 经典：https://dashscope.aliyuncs.com/compatible-mode/v1
 * - Model Studio / MaaS（含各地域）：如 `*.cn-*.maas.aliyuncs.com/compatible-mode/v1`
 */
function isAliyunCompatibleThinkingBaseUrl(baseURL) {
  const u = String(baseURL || "").toLowerCase();
  return u.includes("dashscope.aliyuncs.com") || u.includes("maas.aliyuncs.com");
}

/**
 * 线程里是否已经有过 assistant / tool。**首次**发问模型前通常仅有 system(+可选)+user；
 * 一旦出现其一，后续 HTTP（工具回填后的续写、多轮聊天的后续轮次）均不再挂载深度思考。
 * @param {ReadonlyArray<{ role?: string }>} messages
 */
function threadAlreadyHasAssistantOrTool(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((m) => m && (m.role === "assistant" || m.role === "tool"));
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
 * 本轮发给 API 的 user 内容（含多模态）。K 线收盘 Agent 为单轮 system+user，历史不落盘到 LLM messages；持久化见 `agent_sessions` / `agent_session_messages`。
 */
function buildMultimodalUserContent(userText, imageBase64, mimeType) {
  if (Array.isArray(imageBase64)) {
    const images = imageBase64
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        base64:
          item.base64 != null && String(item.base64).trim() !== "" ? String(item.base64).trim() : "",
        mimeType:
          item.mimeType != null && String(item.mimeType).trim() !== ""
            ? String(item.mimeType).trim()
            : "image/png",
        label: item.label != null && String(item.label).trim() !== "" ? String(item.label).trim() : "",
      }))
      .filter((item) => item.base64);
    if (images.length > 0) {
      const orderedLabels = images
        .map((item, index) => item.label || `图 ${index + 1}`)
        .join("、");
      return [
        {
          type: "text",
          text:
            userText +
            `\n\n` +
            `### 附图` +
            `\n\n` +
            `以下按顺序提供 ${orderedLabels} 图表截图。`,
        },
        ...images.map((item) => ({
          type: "image_url",
          image_url: { url: `data:${item.mimeType};base64,${item.base64}` },
        })),
      ];
    }
  }
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
 * @param {{ appConfig: object, baseUrl?: string, model?: string, llmReasoningForThisRequest?: boolean }} options llmReasoningForThisRequest 为 false（如卡片摘要）时强制不附加深度思考；否则按线程是否已有 assistant/tool 判定。
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
  const allowReasoningThisHttp =
    options?.llmReasoningForThisRequest !== false &&
    !threadAlreadyHasAssistantOrTool(messages);
  if (cfg && cfg.llmReasoningEnabled === true && allowReasoningThisHttp) {
    if (isOpenRouterBaseUrl(baseURL)) {
      body.reasoning = { enabled: true };
    } else {
      body.enable_thinking = true;
    }
  } else if (isAliyunCompatibleThinkingBaseUrl(baseURL)) {
    /** 关闭界面「深度思考」时向通义/MaaS 显式关思考；否则部分模型仍可能走推理通道。续写/tool 回填后的请求也需显式关。 */
    body.enable_thinking = false;
  } else if (
    cfg &&
    cfg.llmReasoningEnabled === true &&
    !allowReasoningThisHttp &&
    !isOpenRouterBaseUrl(baseURL)
  ) {
    /** 首轮用过 enable_thinking 的非 OpenRouter 网关：后续 completion 也需显式关闭，勿依赖网关默认。 */
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
 * 非流式 Chat Completions 的 `choices[0].message` 上可能携带的推理文本（与流式 delta 字段对齐；各兼容网关字段略有差异）。
 * @param {unknown} message
 * @returns {string}
 */
function messageAssistantReasoningToString(message) {
  if (!message || typeof message !== "object") return "";
  const m = /** @type {Record<string, unknown>} */ (message);
  const fromSameShape = appendReasoningFromDelta(m);
  if (fromSameShape) return fromSameShape.trim();
  const r = m.reasoning;
  if (typeof r === "string" && r.trim()) return r.trim();
  if (r && typeof r === "object") {
    const o = /** @type {Record<string, unknown>} */ (r);
    if (typeof o.text === "string" && o.text.trim()) return o.text.trim();
    if (typeof o.content === "string" && o.content.trim()) return o.content.trim();
    try {
      return JSON.stringify(o);
    } catch {
      return "";
    }
  }
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

/** 与 renderer 中 `splitLegacyAssistantAndToolText` 一致：去掉老格式里拼接的工具轨迹。 */
function stripToolSectionFromAssistantRaw(raw) {
  const t = typeof raw === "string" ? raw : "";
  const marker = "\n---\n工具轨迹：\n";
  const idx = t.indexOf(marker);
  if (idx < 0) return t.trim();
  return t.slice(0, idx).trim();
}

const CARD_SUMMARY_MAX_INPUT_CHARS = 12_000;
/** 单条 tool 消息写入摘要上下文的正文上限（避免 JSON 撑爆总预算） */
const CARD_SUMMARY_MAX_TOOL_SNIPPET_CHARS = 900;
/** 最终展示：超过则二次 LLM 压缩，仍超则硬截断（与提示中的字数一致；与 bar-close 最近操作摘要对齐） */
const CARD_SUMMARY_MAX_OUT_CHARS = 110;
const CARD_SUMMARY_FIRST_MAX_TOKENS = 200;
const CARD_SUMMARY_TIGHTEN_MAX_TOKENS = 130;
const SUMMARY_LLM_MAX_MS = 60_000;

/**
 * 卡片摘要用的 chat.completions 调用：低温度、小 max_tokens、关思考。
 * @param {Array<{ role: string, content: string }>} messages
 * @param {object} param1
 * @param {{ appConfig: object, baseUrl?: string, model?: string }} param1.options
 * @param {import("openai").OpenAI} param1.client
 * @param {AbortSignal} param1.signal
 * @param {number} param1.maxTokens
 */
async function runCardSummaryCompletion(messages, { options, client, signal, maxTokens } = {}) {
  const built = buildChatCompletionRequestFromMessages(messages, {
    ...options,
    llmReasoningForThisRequest: false,
  }, false);
  if (built.error) {
    return "";
  }
  const body = { ...built.body, temperature: 0.15, max_tokens: maxTokens };
  if (isOpenRouterBaseUrl(built.baseURL) && "reasoning" in body) {
    delete body.reasoning;
  }
  if (isAliyunCompatibleThinkingBaseUrl(built.baseURL)) {
    body.enable_thinking = false;
  }
  const completion = await client.chat.completions.create(/** @type {any} */ (body), { signal });
  const rawMsg = completion?.choices?.[0]?.message?.content;
  return messageContentToString(rawMsg).trim();
}

function normalizeOneLineCardText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/^["'「]+|["'」]+$/g, "")
    .trim();
}

/**
 * 从 `runTradingAgentTurn` 的 `messagesOut` 拼卡片摘要用的纯文本：跳过 system/user（过长），
 * 按时间保留每步 assistant 正文与 tool 返回摘编，避免仅最后一轮有内容时丢失前几步推理。
 * @param {ReadonlyArray<{ role?: string, content?: unknown, tool_calls?: unknown }> | null | undefined} messagesOut
 * @returns {string}
 */
function buildCardSummarySourceFromAgentThread(messagesOut) {
  if (!Array.isArray(messagesOut) || messagesOut.length === 0) return "";
  const chunks = [];
  let asstStep = 0;
  for (const m of messagesOut) {
    if (!m || typeof m.role !== "string") continue;
    if (m.role === "system" || m.role === "user") continue;
    if (m.role === "assistant") {
      asstStep += 1;
      const text = messageContentToString(m.content).trim();
      const tcs = m.tool_calls;
      const names =
        Array.isArray(tcs) && tcs.length > 0
          ? tcs
              .map((tc) => (tc && tc.function && tc.function.name ? String(tc.function.name) : ""))
              .filter(Boolean)
              .join(", ")
          : "";
      let block = text;
      if (names) {
        block = block ? `${block}\n\n（本步调用工具：${names}）` : `（本步调用工具：${names}）`;
      }
      if (block) {
        chunks.push(`【助手第 ${asstStep} 步】\n${block}`);
      }
    } else if (m.role === "tool") {
      let raw = "";
      try {
        const c = m.content;
        raw = typeof c === "string" ? c : JSON.stringify(c ?? null);
      } catch {
        raw = String(m.content ?? "");
      }
      const clip =
        raw.length > CARD_SUMMARY_MAX_TOOL_SNIPPET_CHARS
          ? `${raw.slice(0, CARD_SUMMARY_MAX_TOOL_SNIPPET_CHARS)}…`
          : raw;
      chunks.push(`【工具返回】\n${clip}`);
    }
  }
  return chunks.join("\n\n---\n\n");
}

/**
 * 若首轮仍偏长，再让模型收束到 CARD_SUMMARY_MAX_OUT_CHARS 以内（失败则后面硬截断）。
 * @param {string} longLine
 * @param {{ appConfig: object, baseUrl?: string, model?: string }} options
 * @param {import("openai").OpenAI} client
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 */
async function compressCardLineForTightLimit(longLine, options, client, signal) {
  const line = normalizeOneLineCardText(longLine);
  if (!line) return "";
  if (line.length <= CARD_SUMMARY_MAX_OUT_CHARS) return line;
  const system = [
    "你是交易日志编辑。用户会给你一句偏长的「K 线收盘结论 + 简要依据」。",
    `请**只输出一句**更短的中文，总长度**不得超过 ${CARD_SUMMARY_MAX_OUT_CHARS} 个字符**（汉字/数字/英文/标点都计入），`,
    "尽量保留：操作结论 + 一条最核心的依据（可删次要修饰），不要列表、换行、引号、前缀说明。",
  ].join("");
  const user = `请压缩为一句（≤${CARD_SUMMARY_MAX_OUT_CHARS} 字），保留操作与主因：\n\n${line}`;
  try {
    const t = await runCardSummaryCompletion(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { options, client, signal, maxTokens: CARD_SUMMARY_TIGHTEN_MAX_TOKENS },
    );
    const out = normalizeOneLineCardText(t);
    const hard = (s) =>
      s.length > CARD_SUMMARY_MAX_OUT_CHARS ? s.slice(0, CARD_SUMMARY_MAX_OUT_CHARS - 1) + "…" : s;
    if (!out) return hard(line);
    return hard(out);
  } catch {
    return line.length > CARD_SUMMARY_MAX_OUT_CHARS
      ? line.slice(0, CARD_SUMMARY_MAX_OUT_CHARS - 1) + "…"
      : line;
  }
}

/**
 * 主 Agent 成功后再调一次小模型/同模型，生成列表卡片可见的一句中文摘要（结论/操作 + 简要依据；可二次压缩；失败不阻断主流程）。
 * @param {string} assistantFull 最后一轮助手正文；当未提供 `extras.messagesOut` 时作为唯一输入
 * @param {{ appConfig: object, baseUrl?: string, model?: string }} options
 * @param {{ messagesOut?: ReadonlyArray<{ role?: string, content?: unknown, tool_calls?: unknown }> }} [extras] 若提供 `runTradingAgentTurn` 的完整 thread，则摘要基于多步助手+工具摘编，而非仅最后一轮
 * @returns {Promise<{ ok: boolean, text?: string }>}
 */
async function summarizeAgentAnalysisForCard(assistantFull, options, extras = {}) {
  const cfg = options.appConfig;
  if (!isLlmEnabled(cfg)) {
    return { ok: false };
  }
  let bodyText = "";
  const fromThread = buildCardSummarySourceFromAgentThread(extras?.messagesOut);
  if (fromThread) {
    bodyText = stripToolSectionFromAssistantRaw(fromThread);
  } else {
    bodyText = stripToolSectionFromAssistantRaw(assistantFull);
  }
  if (!bodyText) {
    return { ok: false };
  }
  const cut =
    bodyText.length > CARD_SUMMARY_MAX_INPUT_CHARS
      ? `${bodyText.slice(0, CARD_SUMMARY_MAX_INPUT_CHARS)}\n\n…（后文已省略）`
      : bodyText;
  const system = [
    "你是交易日志编辑。用户会给你一根 K 线收盘的 Agent **多轮**分析摘录（按时间含各步助手说明与工具返回摘要，可能仅最后一步有长文）。请综合**全程**提炼，不要只看最后一段。",
    "请**只输出一句**中文「卡片外显」摘要，用全角分号「；」分成两段：前半**结论/操作**（多、空、观望、开平、加减仓、调整止盈止损等择要）；后半**一句内最简依据**（为何如此：关键位/结构/信号/风险等，忌空洞套话）。无操作时写观望或未动及主因。",
    `**整句总长度必须不超过 ${CARD_SUMMARY_MAX_OUT_CHARS} 个字符**（含标点、数字）；禁止第二句与换行、列表、Markdown、引号；仅用一条连续语句（可含一个分号）。`,
  ].join("");
  const user = `以下是本轮分析，请直接输出**一句**摘要（操作；依据）：\n\n${cut}`;
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(SUMMARY_LLM_MAX_MS)
      : llmAbortSignal(cfg);
  const initBuilt = buildChatCompletionRequestFromMessages(
    [{ role: "user", content: "x" }],
    { ...options, llmReasoningForThisRequest: false },
    false,
  );
  if (initBuilt.error) {
    return { ok: false };
  }
  const client = new OpenAI({
    apiKey: resolveOpenAiApiKey(cfg),
    baseURL: initBuilt.baseURL,
    timeout: Math.min(SUMMARY_LLM_MAX_MS + 5_000, llmRequestTimeoutMs(cfg)),
    maxRetries: 0,
  });
  try {
    const first = await runCardSummaryCompletion(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { options, client, signal, maxTokens: CARD_SUMMARY_FIRST_MAX_TOKENS },
    );
    let oneLine = normalizeOneLineCardText(first);
    if (!oneLine) {
      return { ok: false };
    }
    if (oneLine.length > CARD_SUMMARY_MAX_OUT_CHARS) {
      oneLine = await compressCardLineForTightLimit(oneLine, options, client, signal);
    }
    if (!oneLine) {
      return { ok: false };
    }
    if (oneLine.length > CARD_SUMMARY_MAX_OUT_CHARS) {
      oneLine = oneLine.slice(0, CARD_SUMMARY_MAX_OUT_CHARS - 1) + "…";
    }
    return { ok: true, text: oneLine };
  } catch (e) {
    return { ok: false };
  }
}

/** 拉取 K 线条数（供 EMA 预热）；表内只展示最近 {@link RECENT_CANDLES_DISPLAY_COUNT} 根 */
const RECENT_CANDLES_FETCH_LIMIT = 100;
const RECENT_CANDLES_DISPLAY_COUNT = 30;
const EMA20_PERIOD = 20;

/**
 * 收盘价 EMA：第 `period` 根起有效，首值为前 `period` 根收盘 SMA，之后标准 EMA（α=2/(period+1)）。
 * @param {number[]} closes
 * @param {number} period
 * @returns {(number | null)[]}
 */
function computeEmaSeries(closes, period) {
  const n = closes.length;
  const out = /** @type {(number | null)[]} */ (Array(n).fill(null));
  if (!Number.isFinite(period) || period < 1 || n < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) {
    const c = closes[i];
    if (!Number.isFinite(c)) return out;
    sum += c;
  }
  let ema = sum / period;
  out[period - 1] = ema;
  const alpha = 2 / (period + 1);
  for (let i = period; i < n; i++) {
    const c = closes[i];
    if (!Number.isFinite(c)) continue;
    ema = alpha * c + (1 - alpha) * ema;
    out[i] = ema;
  }
  return out;
}

/** @param {string | number} raw */
function closeToNumber(raw) {
  const x = typeof raw === "number" ? raw : parseFloat(String(raw).replace(/,/g, ""));
  return Number.isFinite(x) ? x : NaN;
}

/** @param {number | null | undefined} x */
function formatPromptNumber(x) {
  if (x == null || !Number.isFinite(x)) return "—";
  const t = x.toFixed(12).replace(/\.?0+$/, "");
  return t === "" ? "0" : t;
}

/** Markdown 表格单元格：转义 `|`，压缩换行，空值显示为 — */
function mdCell(v) {
  if (v === undefined || v === null || v === "") return "—";
  const s = String(v).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  return s.length > 280 ? `${s.slice(0, 277)}…` : s;
}

/** @param {string[]} headers */
function mdTable(headers, rows) {
  const head = "| " + headers.map((h) => String(h).replace(/\|/g, "\\|")).join(" | ") + " |";
  const sep = "| " + headers.map(() => "---").join(" | ") + " |";
  const body = rows.map((r) => "| " + r.map((c) => mdCell(c)).join(" | ") + " |").join("\n");
  return body ? `${head}\n${sep}\n${body}` : `${head}\n${sep}`;
}

/**
 * @param {{ ok: boolean, error?: string, rows?: Array<{ timeIso: string, open: string, high: string, low: string, close: string, volume: string, turnover: string | null }>, instId?: string | null, bar?: string } | null | undefined} recent
 */
function buildRecentCandlesMarkdownSection(recent, heading = "### 最近 K 线（OKX REST）") {
  if (!recent) return "";
  const title = heading;
  if (!recent.ok) {
    const err = mdCell(recent.error || "未知错误");
    return ["", title, "", `（拉取失败：${err}。请依赖上图与上方「已收盘」一根。）`].join("\n");
  }
  const meta =
    recent.instId && recent.bar
      ? `共 30 根`
      : "";
  const rows = Array.isArray(recent.rows) ? recent.rows : [];
  if (!rows.length) {
    return ["", `${title}${meta}`, "", "（无数据行）"].join("\n");
  }
  const closes = rows.map((r) => closeToNumber(r.close));
  const ema20 = computeEmaSeries(closes, EMA20_PERIOD);
  const show = Math.min(RECENT_CANDLES_DISPLAY_COUNT, rows.length);
  const sliceStart = rows.length - show;
  const sliceRows = rows.slice(sliceStart);
  const sliceEma = ema20.slice(sliceStart);
  const tableRows = sliceRows.map((r, j) => [
    r.timeIso.replace("T", " ").slice(0, 19),
    r.open,
    r.high,
    r.low,
    r.close,
    r.volume,
    r.turnover != null && r.turnover !== "" ? r.turnover : "—",
    formatPromptNumber(sliceEma[j]),
  ]);
  return [
    "",
    `${title}${meta}`,
    "",
    mdTable(
      ["Time (UTC)", "Open", "High", "Low", "Close", "Volume", "QuoteVol", "EMA20"],
      tableRows,
    ),
  ].join("\n");
}

/**
 * @param {object} candle
 * @param {Parameters<typeof buildRecentCandlesMarkdownSection>[0]} [recentCandles] OKX 最近 N 根（与 WS 同源 instId）
 */
function buildUserPrompt(symbol, periodKey, candle, recentCandles) {
  const row = [
    symbol,
    `${periodKey}（已收盘）`,
    candle.timestamp,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
    candle.turnover != null ? candle.turnover : "—",
  ];
  const head = [
    "## K 线（已收盘）",
    "",
    mdTable(
      ["标的", "周期", "时间", "Open", "High", "Low", "Close", "Volume", "Turnover"],
      [row],
    ),
  ].join("\n");
  return head + buildRecentCandlesMarkdownSection(recentCandles);
}

const MULTI_TIMEFRAME_PROMPT_SPECS = [
  { interval: "1D", label: "1D（日线）" },
  { interval: "60", label: "1H（1 小时）" },
  { interval: "15", label: "15m（15 分钟）" },
  { interval: "5", label: "5m（5 分钟，决策周期）" },
];

/**
 * @param {string} symbol
 * @param {string} periodKey
 * @param {object} candle
 * @param {Record<string, Parameters<typeof buildRecentCandlesMarkdownSection>[0]>} recentCandlesByInterval
 */
function buildMultiTimeframeUserPrompt(symbol, periodKey, candle, recentCandlesByInterval) {
  const triggerRow = [
    symbol,
    `${periodKey}`,
    candle.timestamp,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
    candle.turnover != null ? candle.turnover : "—",
  ];
  const sections = MULTI_TIMEFRAME_PROMPT_SPECS.map((spec) =>
    buildRecentCandlesMarkdownSection(
      recentCandlesByInterval?.[spec.interval],
      `### ${spec.label} `,
    ),
  ).filter(Boolean);
  return [
    "## 最新推送的 K 线",
    "",
    mdTable(
      ["标的", "周期", "时间", "Open", "High", "Low", "Close", "Volume", "Turnover"],
      [triggerRow],
    ),
    "",
    "## 多周期上下文",
    "",
    ...sections,
  ].join("\n");
}

/**
 * 非流式多轮工具调用（Chat Completions tools），兼容 OpenAI 及多数 OpenAI 兼容网关。
 *
 * 深度思考：由 {@link buildChatCompletionRequestFromMessages} 统一决定——仅在**本条线程里尚未出现 assistant/tool**
 * 的首次 completion 挂载（第一次把「齐备的 system+user」交给模型）；一旦模型产出 assistant 或执行过工具，
 * 续写回合不再挂载，与「一轮分析取结论，之后只执行工具或收束」一致。
 *
 * @param {Array<{ role: string, content?: unknown, tool_calls?: unknown, tool_call_id?: string }>} messages
 * @param {{ appConfig: object, baseUrl?: string, model?: string }} options
 * @param {{
 *   tools: unknown[],
 *   executeTool: (name: string, args: object) => Promise<object>,
 *   maxSteps?: number,
 *   onStep?: (ev: { step: number, toolCalls?: unknown[], assistantPreview?: string, reasoningPreview?: string }) => void,
 * }} agentOpts
 */
async function runTradingAgentTurn(messages, options, agentOpts) {
  const cfg = options.appConfig;
  if (!isLlmEnabled(cfg)) {
    return { ok: false, text: "LLM 未启用。", toolTrace: [], messagesOut: messages, reasoningText: "" };
  }
  const apiKey = resolveOpenAiApiKey(cfg);
  const signal = llmAbortSignal(cfg);
  const probe = buildChatCompletionRequestFromMessages(messages, options, false);
  if (probe.error) {
    return { ok: false, text: probe.error, toolTrace: [], messagesOut: messages, reasoningText: "" };
  }

  const tools = agentOpts.tools;
  const executeTool = agentOpts.executeTool;
  const maxSteps = Math.min(16, Math.max(1, Number(agentOpts.maxSteps) || 8));
  const onStep = typeof agentOpts.onStep === "function" ? agentOpts.onStep : null;

  const client = new OpenAI({
    apiKey,
    baseURL: probe.baseURL,
    timeout: llmRequestTimeoutMs(cfg),
    maxRetries: 0,
  });

  let thread = [...messages];
  const toolTrace = [];
  let reasoningAcc = "";
  const wantReasoning = !!(cfg && cfg.llmReasoningEnabled === true);

  try {
    for (let step = 1; step <= maxSteps; step++) {
      const built = buildChatCompletionRequestFromMessages(thread, options, false);
      if (built.error) {
        return { ok: false, text: built.error, toolTrace, messagesOut: thread, reasoningText: reasoningAcc.trim() };
      }
      const completion = await client.chat.completions.create(
        { ...built.body, tools, tool_choice: "auto" },
        { signal },
      );
      const choice = completion?.choices?.[0];
      const msg = choice?.message;
      if (!msg) {
        return { ok: false, text: "LLM 无有效 message。", toolTrace, messagesOut: thread, reasoningText: reasoningAcc.trim() };
      }
      if (wantReasoning) {
        const rs = messageAssistantReasoningToString(msg);
        if (rs) reasoningAcc = mergeReasoningChunk(reasoningAcc, rs);
      }
      thread.push(msg);

      const tcs = msg.tool_calls;
      if (!Array.isArray(tcs) || tcs.length === 0) {
        const finalText = messageContentToString(msg.content).trim();
        onStep?.({ step, assistantPreview: finalText, reasoningPreview: reasoningAcc.trim() });
        return {
          ok: true,
          text: finalText,
          reasoningText: reasoningAcc.trim(),
          toolTrace,
          messagesOut: thread,
        };
      }

      onStep?.({
        step,
        toolCalls: tcs,
        assistantPreview: messageContentToString(msg.content).trim(),
        reasoningPreview: reasoningAcc.trim(),
      });

      for (const tc of tcs) {
        const name = tc?.function?.name || "";
        let args = {};
        try {
          args = JSON.parse(tc.function?.arguments || "{}");
        } catch {
          args = {};
        }
        const result = await executeTool(String(name), args, {
          step,
          assistantPreview: messageContentToString(msg.content).trim(),
        });
        toolTrace.push({ name: String(name), args, result });
        thread.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result ?? {}),
        });
      }
    }
    return {
      ok: false,
      text: `工具调用超过 ${maxSteps} 步上限。`,
      toolTrace,
      messagesOut: thread,
      reasoningText: reasoningAcc.trim(),
    };
  } catch (e) {
    const err = mapLlmSdkError(e, cfg);
    return { ok: false, text: err.text, toolTrace, messagesOut: thread, reasoningText: reasoningAcc.trim() };
  }
}

module.exports = {
  callOpenAIChat,
  streamOpenAIChat,
  summarizeAgentAnalysisForCard,
  buildCardSummarySourceFromAgentThread,
  runTradingAgentTurn,
  buildUserPrompt,
  buildMultiTimeframeUserPrompt,
  computeEmaSeries,
  RECENT_CANDLES_FETCH_LIMIT,
  RECENT_CANDLES_DISPLAY_COUNT,
  EMA20_PERIOD,
  mdCell,
  mdTable,
  buildMultimodalUserContent,
  buildUserTextForHistory,
  buildChatCompletionRequestFromMessages,
  resolveSystemPrompt,
  resolveTradingAgentSystemPrompt,
  composeSystemPrompt,
  buildTradingAgentStaticToolsAppend,
  isLlmEnabled,
  resolveOpenAiApiKey,
  keepOnlyLastUserImageInMessages,
};
