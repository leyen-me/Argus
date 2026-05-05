/**
 * OpenAI 兼容 Chat Completions（官方 `openai` Node SDK + 任意兼容端点），供 OKX WS K 线收盘分析共用。
 * 启用条件：在配置中填写 openaiApiKey，或设置环境变量 OPENAI_API_KEY（配置优先）。
 */
import { OpenAI, APIError, APIUserAbortError } from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import { loadSystemPromptsFromDisk } from "./app-config.js";
import {
  filterMultiTimeframeSpecsByMarketSelection,
  orderStrategyIndicatorsForPrompt,
  STRATEGY_INDICATOR_ORDER,
  type StrategyDecisionIntervalTv,
  type StrategyIndicatorId,
} from "../shared/strategy-fields.js";

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

#### 输出格式（强制）

- 每次回复的第一行必须是：\`DECISION: hold\`、\`DECISION: open\`、\`DECISION: close\`、\`DECISION: amend\` 之一。
- \`hold\`：只允许分析，不允许调用任何交易工具。
- \`open\`：只允许调用 \`open_position\`。
- \`close\`：只允许调用 \`close_position\`。
- \`amend\`：只允许调用 \`cancel_order\`、\`amend_order\`、\`amend_tp_sl\`。
- 当 \`DECISION\` 不是 \`hold\` 时，不要输出参数 JSON 示例，不要只写交易计划，必须直接发起对应的工具调用。
- 如果正文里的 \`DECISION\` 与工具调用不一致，系统会直接拦截，不执行下单/平仓/改单。
`;

const TRADING_DECISION_ALLOWED_TOOLS = Object.freeze({
  hold: new Set(),
  open: new Set(["open_position"]),
  close: new Set(["close_position"]),
  amend: new Set(["cancel_order", "amend_order", "amend_tp_sl"]),
});

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
function resolveSystemPrompt(cfg?: { systemPromptCrypto?: string } | null) {
  const p = cfg ?? loadSystemPromptsFromDisk();
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
function composeSystemPrompt(
  strategyBody: string,
  fragments: ReadonlyArray<string | undefined | null> = [],
) {
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
function mapLlmSdkError(e, _cfg) {
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
            `以下按周期从小到大顺序提供（先小周期、后大周期）：${orderedLabels} 图表截图。`,
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

  const body: Record<string, unknown> & {
    model: string;
    temperature: number;
    stream: boolean;
    messages: unknown;
  } = {
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
 * 从 assistant 正文里提取结构化交易决策。
 * 优先识别：
 * 1. `DECISION: hold|open|close|amend`
 * 2. JSON 里的 `"decision": "hold|open|close|amend"`
 * @param {unknown} content
 * @returns {"hold" | "open" | "close" | "amend" | null}
 */
function extractTradingDecision(content) {
  const text = messageContentToString(content).trim();
  if (!text) return null;
  const lineMatch = text.match(/(?:^|\n)\s*decision\s*[:：=]\s*(hold|open|close|amend)\b/i);
  if (lineMatch) return /** @type {"hold" | "open" | "close" | "amend"} */ (lineMatch[1].toLowerCase());
  const jsonMatch = text.match(/"decision"\s*:\s*"(hold|open|close|amend)"/i);
  if (jsonMatch) return /** @type {"hold" | "open" | "close" | "amend"} */ (jsonMatch[1].toLowerCase());
  return null;
}

/**
 * @param {unknown} tc
 * @returns {{ id: string, name: string, args: object }}
 */
function parseToolCall(tc) {
  const id = tc?.id != null ? String(tc.id) : "";
  const name = tc?.function?.name || "";
  let args = {};
  try {
    args = JSON.parse(tc?.function?.arguments || "{}");
  } catch {
    args = {};
  }
  return { id, name: String(name), args };
}

/**
 * @param {unknown} content
 * @param {unknown[]} toolCalls
 */
function validateTradingDecisionToolCalls(content, toolCalls) {
  const decision = extractTradingDecision(content);
  const parsedCalls = Array.isArray(toolCalls) ? toolCalls.map(parseToolCall) : [];
  if (parsedCalls.length === 0) {
    return { ok: true, decision, parsedCalls };
  }
  if (!decision) {
    return {
      ok: false,
      decision: null,
      parsedCalls,
      message: "检测到交易工具调用，但 assistant 正文缺少结构化 `DECISION: hold|open|close|amend`。",
    };
  }
  const allowed = TRADING_DECISION_ALLOWED_TOOLS[decision];
  const disallowed = parsedCalls.map((x) => x.name).filter((name) => !allowed.has(name));
  if (decision === "hold") {
    return {
      ok: false,
      decision,
      parsedCalls,
      message: "DECISION=hold 时不允许调用任何交易工具，本次操作已被系统拦截。",
    };
  }
  if (disallowed.length > 0) {
    return {
      ok: false,
      decision,
      parsedCalls,
      message: `DECISION=${decision} 仅允许调用 ${Array.from(allowed).join(" / ")}，实际却调用了 ${disallowed.join(" / ")}，本次操作已被系统拦截。`,
    };
  }
  return { ok: true, decision, parsedCalls };
}

/**
 * @param {string} assistantText
 * @param {string} blockMessage
 */
function appendDecisionGuardMessage(assistantText, blockMessage) {
  const base = String(assistantText || "").trim();
  const note = `系统风控拦截：${blockMessage}`;
  return [base, note].filter(Boolean).join("\n\n").trim();
}

/**
 * @param {"open" | "close" | "amend"} decision
 */
function buildDecisionToolRetryPrompt(decision) {
  const allowed = Array.from(TRADING_DECISION_ALLOWED_TOOLS[decision] || []).join(" / ");
  return [
    `你刚刚给出了 DECISION=${decision}，但没有真正发起工具调用。`,
    `现在不要重复分析，不要输出 JSON 代码块，不要复述交易计划。`,
    `请立刻且只调用允许的工具：${allowed}。`,
    `如果你认为不该交易，请改为新的 assistant 回复，并把第一行明确改成 DECISION: hold，且不要调用任何工具。`,
  ].join("\n");
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
    const stream = await client.chat.completions.create(
      built.body as unknown as ChatCompletionCreateParamsStreaming,
      { signal },
    );
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

/** 非流式（备用） */
async function callOpenAIChat(userText: string, options: Record<string, unknown> = {}) {
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
    const completion = await client.chat.completions.create(
      built.body as unknown as ChatCompletionCreateParamsNonStreaming,
      { signal },
    );
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
async function runCardSummaryCompletion(
  messages: unknown,
  opts: {
    options: Record<string, unknown>;
    client: OpenAI;
    signal: AbortSignal;
    maxTokens: number;
  },
) {
  const { options, client, signal, maxTokens } = opts;
  const built = buildChatCompletionRequestFromMessages(messages, {
    ...options,
    llmReasoningForThisRequest: false,
  }, false);
  if (built.error) {
    return "";
  }
  const body: Record<string, unknown> = { ...built.body, temperature: 0.15, max_tokens: maxTokens };
  if (isOpenRouterBaseUrl(built.baseURL) && "reasoning" in body) {
    delete body.reasoning;
  }
  if (isAliyunCompatibleThinkingBaseUrl(built.baseURL)) {
    body.enable_thinking = false;
  }
  const completion = await client.chat.completions.create(
    body as unknown as ChatCompletionCreateParamsNonStreaming,
    { signal },
  );
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
  const chunks: string[] = [];
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
async function summarizeAgentAnalysisForCard(
  assistantFull: string,
  options: Record<string, unknown>,
  extras: { messagesOut?: ReadonlyArray<Record<string, unknown>> } = {},
) {
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
  } catch (_e) {
    return { ok: false };
  }
}

/** 拉取 K 线条数（供 EMA 预热，须覆盖 EMA200）；表内只展示最近 {@link RECENT_CANDLES_DISPLAY_COUNT} 根 */
const RECENT_CANDLES_FETCH_LIMIT = 250;
const RECENT_CANDLES_DISPLAY_COUNT = 30;
const EMA20_PERIOD = 20;
const EMA50_PERIOD = 50;
const EMA200_PERIOD = 200;
const BB_PERIOD = 20;
const BB_STD_MULT = 2;
const ATR_PERIOD = 14;
const RSI_PERIOD = 14;
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;
/** 与 TradingView 内置 SuperTrend 默认一致：ATR 周期 × 倍数 */
const SUPERTREND_ATR_PERIOD = 10;
const SUPERTREND_MULTIPLIER = 3;

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

/** 布林通道：中轨为收盘 SMA(period)，上下轨 ± mult × 总体标准差 */
function computeBollingerSeries(closes, period, mult) {
  const n = closes.length;
  const mid = /** @type {(number | null)[]} */ (Array(n).fill(null));
  const upper = /** @type {(number | null)[]} */ (Array(n).fill(null));
  const lower = /** @type {(number | null)[]} */ (Array(n).fill(null));
  if (!Number.isFinite(period) || period < 1) return { mid, upper, lower };
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    let sumsq = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const c = closes[j];
      if (!Number.isFinite(c)) {
        ok = false;
        break;
      }
      sum += c;
      sumsq += c * c;
    }
    if (!ok) continue;
    const mean = sum / period;
    const varPop = Math.max(0, sumsq / period - mean * mean);
    const std = Math.sqrt(varPop);
    mid[i] = mean;
    upper[i] = mean + mult * std;
    lower[i] = mean - mult * std;
  }
  return { mid, upper, lower };
}

/**
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 */
function computeTrueRangeSeries(highs, lows, closes) {
  const n = highs.length;
  const tr = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const h = highs[i];
    const l = lows[i];
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
    if (i === 0) tr[i] = h - l;
    else {
      const pc = closes[i - 1];
      if (!Number.isFinite(pc)) tr[i] = h - l;
      else tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
  }
  return tr;
}

/** Wilder ATR：首值为 TR 的 SMA，其后递推 */
function computeAtrWilderSeries(tr, period) {
  const n = tr.length;
  const out = /** @type {(number | null)[]} */ (Array(n).fill(null));
  if (n < period || !Number.isFinite(period) || period < 1) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let atr = sum / period;
  out[period - 1] = atr;
  for (let i = period; i < n; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

/** SuperTrend：公式见 https://www.tradingview.com/support/solutions/43000634738/ */
function computeSuperTrendSeries(highs, lows, closes, atrPeriod, multiplier) {
  const n = closes.length;
  const line = /** @type {(number | null)[]} */ (Array(n).fill(null));
  const up = /** @type {(boolean | null)[]} */ (Array(n).fill(null));
  if (!Number.isFinite(atrPeriod) || atrPeriod < 1 || !Number.isFinite(multiplier) || n === 0) {
    return { line, up };
  }
  const tr = computeTrueRangeSeries(highs, lows, closes);
  const atr = computeAtrWilderSeries(tr, atrPeriod);
  let prevUb: number | null = null;
  let prevLb: number | null = null;
  let prevSt: number | null = null;
  const near = (a: number | null, b: number | null) => {
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a - b) <= 1e-9 * (Math.abs(a) + Math.abs(b) + 1);
  };

  for (let i = 0; i < n; i++) {
    if (atr[i] == null || !Number.isFinite(atr[i])) continue;
    const hl2 = (highs[i] + lows[i]) / 2;
    const basicU = hl2 + multiplier * atr[i];
    const basicL = hl2 - multiplier * atr[i];
    let ub = basicU;
    let lb = basicL;
    if (prevUb != null && prevLb != null) {
      const prevClose = closes[i - 1];
      ub =
        basicU < prevUb || (Number.isFinite(prevClose) && prevClose > prevUb) ? basicU : prevUb;
      lb =
        basicL > prevLb || (Number.isFinite(prevClose) && prevClose < prevLb) ? basicL : prevLb;
    }
    let trendUp = false;
    if (prevSt == null) {
      trendUp = false;
    } else if (near(prevSt, prevUb)) {
      trendUp = Number.isFinite(closes[i]) && closes[i] > ub;
    } else {
      trendUp = !(Number.isFinite(closes[i]) && closes[i] < lb);
    }
    const st = trendUp ? lb : ub;
    line[i] = st;
    up[i] = trendUp;
    prevUb = ub;
    prevLb = lb;
    prevSt = st;
  }
  return { line, up };
}

/** RSI(Wilder)：首期为涨跌均值简单平均，其后递推平滑；输出 0–100 */
function computeRsiWilderSeries(closes, period) {
  const n = closes.length;
  const out = /** @type {(number | null)[]} */ (Array(n).fill(null));
  if (!Number.isFinite(period) || period < 1 || n < period + 1) return out;

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < n; i++) {
    const ch = closes[i] - closes[i - 1];
    gains.push(ch > 0 ? ch : 0);
    losses.push(ch < 0 ? -ch : 0);
  }

  let sumGain = 0;
  let sumLoss = 0;
  for (let j = 0; j < period; j++) {
    sumGain += gains[j];
    sumLoss += losses[j];
  }
  let avgGain = sumGain / period;
  let avgLoss = sumLoss / period;

  const rsiValue = (avgG, avgL) => {
    if (avgL === 0 && avgG === 0) return 50;
    if (avgL === 0) return 100;
    const rs = avgG / avgL;
    return 100 - 100 / (1 + rs);
  };

  out[period] = rsiValue(avgGain, avgLoss);

  for (let j = period; j < n - 1; j++) {
    avgGain = (avgGain * (period - 1) + gains[j]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[j]) / period;
    out[j + 1] = rsiValue(avgGain, avgLoss);
  }
  return out;
}

/** MACD 线 / Signal / 柱：与常见平台一致（DIF=EMA12−EMA26，Signal=EMA9(DIF)，Hist=DIF−Signal） */
function computeMacdTriple(closes) {
  const ema12 = computeEmaSeries(closes, MACD_FAST);
  const ema26 = computeEmaSeries(closes, MACD_SLOW);
  const n = closes.length;
  const macd = /** @type {(number | null)[]} */ (Array(n).fill(null));
  const signal = /** @type {(number | null)[]} */ (Array(n).fill(null));
  const hist = /** @type {(number | null)[]} */ (Array(n).fill(null));
  const firstMacd = MACD_SLOW - 1;
  for (let i = firstMacd; i < n; i++) {
    if (ema12[i] != null && ema26[i] != null) macd[i] = ema12[i] - ema26[i];
  }
  const tailLen = n - firstMacd;
  const macdTail = /** @type {number[]} */ (Array(tailLen));
  for (let j = 0; j < tailLen; j++) macdTail[j] = /** @type {number} */ (macd[firstMacd + j]);
  const sigTail = computeEmaSeries(macdTail, MACD_SIGNAL);
  for (let j = 0; j < sigTail.length; j++) {
    if (sigTail[j] != null) signal[firstMacd + j] = sigTail[j];
  }
  for (let i = 0; i < n; i++) {
    if (macd[i] != null && signal[i] != null) hist[i] = macd[i] - signal[i];
  }
  return { macd, signal, hist };
}

/**
 * @param {Array<{ open: string, high: string, low: string, close: string }>} rows
 */
function rowsToHlC(rows) {
  const highs = rows.map((r) => closeToNumber(r.high));
  const lows = rows.map((r) => closeToNumber(r.low));
  const closes = rows.map((r) => closeToNumber(r.close));
  return { highs, lows, closes };
}

/**
 * @param {readonly StrategyIndicatorId[]} orderedIds
 */
function indicatorColumnHeaders(orderedIds: readonly StrategyIndicatorId[]): string[] {
  const headers: string[] = [];
  for (const id of orderedIds) {
    if (id === "VOL") headers.push("Vol");
    if (id === "EM20") headers.push("E20");
    if (id === "EM50") headers.push("E50");
    if (id === "EM200") headers.push("E200");
    if (id === "BB") headers.push("BBM", "BBU", "BBL");
    if (id === "ATR") headers.push("ATR");
    if (id === "RSI14") headers.push("RSI");
    if (id === "MACD") headers.push("DIF", "SIG", "Hist");
    if (id === "SUPERTREND") headers.push("ST", "Dir");
  }
  return headers;
}

/**
 * @param {readonly StrategyIndicatorId[]} orderedIds
 */
function indicatorCellsForRow(
  orderedIds: readonly StrategyIndicatorId[],
  j: number,
  i: number,
  volumeRaw: unknown,
  sliceEmaById: Partial<Record<"EM20" | "EM50" | "EM200", (number | null)[]>>,
  bb: { mid: (number | null)[]; upper: (number | null)[]; lower: (number | null)[] },
  atrSeries: (number | null)[],
  rsiSeries: (number | null)[],
  macdTriple: { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] },
  stLine: (number | null)[],
  stUp: (boolean | null)[],
): string[] {
  const cells: string[] = [];
  for (const id of orderedIds) {
    if (id === "VOL") cells.push(formatPromptQtyAbbrev(volumeRaw));
    if (id === "EM20" || id === "EM50" || id === "EM200") {
      const slice = sliceEmaById[id];
      cells.push(formatPromptPriceCell(slice?.[j]));
    }
    if (id === "BB") {
      cells.push(
        formatPromptPriceCell(bb.mid[i]),
        formatPromptPriceCell(bb.upper[i]),
        formatPromptPriceCell(bb.lower[i]),
      );
    }
    if (id === "ATR") cells.push(formatPromptPriceCell(atrSeries[i]));
    if (id === "RSI14") cells.push(formatPromptRsiCell(rsiSeries[i]));
    if (id === "MACD") {
      cells.push(
        formatPromptMacdCell(macdTriple.macd[i]),
        formatPromptMacdCell(macdTriple.signal[i]),
        formatPromptMacdCell(macdTriple.hist[i]),
      );
    }
    if (id === "SUPERTREND") {
      cells.push(formatPromptPriceCell(stLine[i]), formatPromptSuperTrendDir(stUp[i]));
    }
  }
  return cells;
}
function closeToNumber(raw) {
  const x = typeof raw === "number" ? raw : parseFloat(String(raw).replace(/,/g, ""));
  return Number.isFinite(x) ? x : NaN;
}

/** 去掉 fixed 尾零；用于压缩 LLM 表格 token */
function stripFixedTrailingZeros(t: string): string {
  let s = t.replace(/\.?0+$/, "");
  if (s === "-0") s = "0";
  return s === "" ? "0" : s;
}

/** 价格量级 OHLC / EMA / 布林 / ATR：高价少小数，低价多小数 */
function formatPromptPriceCell(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  const ax = Math.abs(x);
  const decimals = ax >= 500 ? 1 : ax >= 50 ? 2 : 4;
  return stripFixedTrailingZeros(x.toFixed(decimals));
}

function formatPromptRsiCell(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return stripFixedTrailingZeros(x.toFixed(1));
}

function formatPromptMacdCell(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return stripFixedTrailingZeros(x.toFixed(2));
}

function formatPromptSuperTrendDir(up: boolean | null | undefined): string {
  if (up == null) return "—";
  return up ? "U" : "D";
}

/** 成交量等数量字段：K/M/B 缩写（prompt 中不再输出 Turnover） */
function formatPromptQtyAbbrev(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "—";
  const x =
    typeof raw === "number" ? raw : parseFloat(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(x)) return "—";
  const ax = Math.abs(x);
  if (ax >= 1e9) return `${stripFixedTrailingZeros((x / 1e9).toFixed(2))}B`;
  if (ax >= 1e6) return `${stripFixedTrailingZeros((x / 1e6).toFixed(2))}M`;
  if (ax >= 1e3) return `${stripFixedTrailingZeros((x / 1e3).toFixed(2))}K`;
  return stripFixedTrailingZeros(x.toFixed(2));
}

/** ISO → `MM-DD HH:mm`，省年份与秒 */
function compactPromptUtcFromIso(timeIso: string): string {
  const s = String(timeIso ?? "").trim();
  if (!s) return "—";
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2})/);
  if (m) return `${m[2]}-${m[3]} ${m[4]}`;
  return s.length > 16 ? s.slice(0, 16) : s;
}

/** 最近 K 线表：仅 OHLC（Vol/Turnover 不再默认附带） */
const PROMPT_RECENT_KLINE_BASE_HEADERS = ["UTC", "O", "H", "L", "C"] as const;

/** 触发 K 线表：标的 + 周期 + OHLC；Vol 仅当策略勾选 {@link StrategyIndicatorId} `VOL` */
function promptTriggerKlineHeaders(orderedIds: readonly StrategyIndicatorId[]): string[] {
  const h = ["标的", "周期", "UTC", "O", "H", "L", "C"];
  if (orderedIds.includes("VOL")) h.push("Vol");
  return h;
}

/** 与表头一致：仅解释当前表里真实出现的列（触发表无技术指标列）。 */
function promptTriggerKlineColumnGlossary(orderedIds: readonly StrategyIndicatorId[]): string {
  const parts = ["标的=合约代码", "周期=本根K线周期", "UTC=月-日 时:分(UTC)", "O/H/L/C=开/高/低/收"];
  if (orderedIds.includes("VOL")) parts.push("Vol=成交量(K/M/B为数量缩写)");
  return `列说明：${parts.join("；")}。`;
}

/** 最近 K 线表：OHLC + 勾选的指标列释义（MACD 柱用 Hist，避免与 High 缩写 H 冲突）。 */
function promptRecentKlineColumnGlossary(orderedIds: readonly StrategyIndicatorId[]): string {
  const parts = ["UTC=月-日 时:分(UTC)", "O/H/L/C=开/高/低/收"];
  const set = new Set(orderedIds);
  for (const id of STRATEGY_INDICATOR_ORDER) {
    if (!set.has(id)) continue;
    if (id === "VOL") parts.push("Vol=成交量(K/M/B为数量缩写)");
    else if (id === "EM20") parts.push("E20=EMA(20,收盘)");
    else if (id === "EM50") parts.push("E50=EMA(50,收盘)");
    else if (id === "EM200") parts.push("E200=EMA(200,收盘)");
    else if (id === "BB") parts.push("BBM/BBU/BBL=布林中轨/上轨/下轨(20周期,2σ)");
    else if (id === "ATR") parts.push("ATR=ATR(14,Wilder)");
    else if (id === "RSI14") parts.push("RSI=RSI(14,Wilder)");
    else if (id === "MACD") parts.push("DIF/SIG/Hist=MACD线/信号线/柱状图(12,26,9)");
    else if (id === "SUPERTREND") parts.push("ST/Dir=SuperTrend 线价与方向 U 多 D 空（ATR10×3）");
  }
  return `列说明：${parts.join("；")}。`;
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
 * @param {string} [heading]
 * @param {readonly StrategyIndicatorId[] | undefined} [strategyIndicators] 未传时默认仅 EMA20（兼容旧单周期 user）；不含 Vol/Turnover
 * @param {{ omitColumnGlossary?: boolean }} [opts] 为 true 时不输出列说明（多周期时在区块顶层统一写一份）
 */
function buildRecentCandlesMarkdownSection(
  recent,
  heading = "### 最近 K 线（OKX REST）",
  strategyIndicators,
  opts?: { omitColumnGlossary?: boolean },
) {
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

  const orderedIds = orderStrategyIndicatorsForPrompt(
    strategyIndicators === undefined ? ["EM20"] : strategyIndicators,
  );

  const { highs, lows, closes } = rowsToHlC(rows);
  const show = Math.min(RECENT_CANDLES_DISPLAY_COUNT, rows.length);
  const sliceStart = rows.length - show;
  const sliceRows = rows.slice(sliceStart);

  const sliceEmaById: Partial<Record<"EM20" | "EM50" | "EM200", (number | null)[]>> = {};
  if (orderedIds.includes("EM20")) {
    sliceEmaById.EM20 = computeEmaSeries(closes, EMA20_PERIOD).slice(sliceStart);
  }
  if (orderedIds.includes("EM50")) {
    sliceEmaById.EM50 = computeEmaSeries(closes, EMA50_PERIOD).slice(sliceStart);
  }
  if (orderedIds.includes("EM200")) {
    sliceEmaById.EM200 = computeEmaSeries(closes, EMA200_PERIOD).slice(sliceStart);
  }

  let bb: ReturnType<typeof computeBollingerSeries> | null = null;
  if (orderedIds.includes("BB")) {
    bb = computeBollingerSeries(closes, BB_PERIOD, BB_STD_MULT);
  }

  let atrSeries: (number | null)[] = [];
  if (orderedIds.includes("ATR")) {
    const tr = computeTrueRangeSeries(highs, lows, closes);
    atrSeries = computeAtrWilderSeries(tr, ATR_PERIOD);
  }

  let rsiSeries: (number | null)[] = [];
  if (orderedIds.includes("RSI14")) {
    rsiSeries = computeRsiWilderSeries(closes, RSI_PERIOD);
  }

  let macdTriple: { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] } = {
    macd: [] as (number | null)[],
    signal: [] as (number | null)[],
    hist: [] as (number | null)[],
  };
  if (orderedIds.includes("MACD")) {
    macdTriple = computeMacdTriple(closes);
  }

  let stLine: (number | null)[] = [];
  let stUp: (boolean | null)[] = [];
  if (orderedIds.includes("SUPERTREND")) {
    const st = computeSuperTrendSeries(highs, lows, closes, SUPERTREND_ATR_PERIOD, SUPERTREND_MULTIPLIER);
    stLine = st.line;
    stUp = st.up;
  }

  const baseHeaders = [...PROMPT_RECENT_KLINE_BASE_HEADERS];
  const indHeaders = indicatorColumnHeaders(orderedIds);
  const headers = [...baseHeaders, ...indHeaders];

  const bbSafe: {
    mid: (number | null)[];
    upper: (number | null)[];
    lower: (number | null)[];
  } = bb ?? { mid: [], upper: [], lower: [] };

  const tableRows = sliceRows.map((r, j) => {
    const i = sliceStart + j;
    const base = [
      compactPromptUtcFromIso(r.timeIso),
      formatPromptPriceCell(closeToNumber(r.open)),
      formatPromptPriceCell(closeToNumber(r.high)),
      formatPromptPriceCell(closeToNumber(r.low)),
      formatPromptPriceCell(closeToNumber(r.close)),
    ];
    const extra = indicatorCellsForRow(
      orderedIds,
      j,
      i,
      r.volume,
      sliceEmaById,
      bbSafe,
      atrSeries,
      rsiSeries,
      macdTriple,
      stLine,
      stUp,
    );
    return [...base, ...extra];
  });

  const metaShow = recent.instId && recent.bar ? `共 ${show} 根` : meta;

  const bodyLines = ["", `${title}${metaShow}`];
  if (opts?.omitColumnGlossary !== true) {
    bodyLines.push(promptRecentKlineColumnGlossary(orderedIds));
  }
  bodyLines.push(mdTable(headers, tableRows));

  return bodyLines.join("\n");
}

/**
 * @param {string} symbol
 * @param {string} periodKey
 * @param {object} candle
 * @param {Parameters<typeof buildRecentCandlesMarkdownSection>[0]} [recentCandles] OKX 最近 N 根（与 WS 同源 instId）
 * @param {readonly StrategyIndicatorId[] | undefined} [strategyIndicators] 未传时默认 EMA20；Vol 仅当勾选 `VOL`
 */
function buildUserPrompt(symbol, periodKey, candle, recentCandles, strategyIndicators) {
  const orderedIds = orderStrategyIndicatorsForPrompt(
    strategyIndicators === undefined ? ["EM20"] : strategyIndicators,
  );
  const row = [
    symbol,
    `${periodKey}（已收盘）`,
    compactPromptUtcFromIso(String(candle.timestamp ?? "")),
    formatPromptPriceCell(closeToNumber(candle.open)),
    formatPromptPriceCell(closeToNumber(candle.high)),
    formatPromptPriceCell(closeToNumber(candle.low)),
    formatPromptPriceCell(closeToNumber(candle.close)),
  ];
  if (orderedIds.includes("VOL")) {
    row.push(formatPromptQtyAbbrev(candle.volume));
  }
  const head = [
    "## K 线（已收盘）",
    "",
    promptTriggerKlineColumnGlossary(orderedIds),
    "",
    mdTable(promptTriggerKlineHeaders(orderedIds), [row]),
  ].join("\n");
  return head + buildRecentCandlesMarkdownSection(recentCandles, "### 最近 K 线（OKX REST）", strategyIndicators);
}

/** 与 shared 一致：小周期在上、大周期在下（filter 后也会再 sort） */
const MULTI_TIMEFRAME_PROMPT_SPECS = [
  { interval: "5", label: "5m（5 分钟，决策周期）" },
  { interval: "15", label: "15m（15 分钟）" },
  { interval: "60", label: "1H（1 小时）" },
  { interval: "1D", label: "1D（日线）" },
];

/**
 * @param {string} symbol
 * @param {string} periodKey
 * @param {object} candle
 * @param {Record<string, Parameters<typeof buildRecentCandlesMarkdownSection>[0]>} recentCandlesByInterval
 * @param {readonly StrategyDecisionIntervalTv[]} [marketTimeframes] 策略「市场数据」勾选；空或未传则四周期全开（与 shared 容错一致）
 * @param {readonly StrategyIndicatorId[]} [strategyIndicators] 策略「技术指标」勾选；空数组则仅 OHLC（无 Vol / 无 Turnover）
 */
function buildMultiTimeframeUserPrompt(symbol, periodKey, candle, recentCandlesByInterval, marketTimeframes, strategyIndicators) {
  const orderedIds = orderStrategyIndicatorsForPrompt(
    strategyIndicators === undefined ? ["EM20"] : strategyIndicators,
  );
  const triggerRow = [
    symbol,
    `${periodKey}`,
    compactPromptUtcFromIso(String(candle.timestamp ?? "")),
    formatPromptPriceCell(closeToNumber(candle.open)),
    formatPromptPriceCell(closeToNumber(candle.high)),
    formatPromptPriceCell(closeToNumber(candle.low)),
    formatPromptPriceCell(closeToNumber(candle.close)),
  ];
  if (orderedIds.includes("VOL")) {
    triggerRow.push(formatPromptQtyAbbrev(candle.volume));
  }
  const tfList = Array.isArray(marketTimeframes) ? marketTimeframes : [];
  const specs = filterMultiTimeframeSpecsByMarketSelection(MULTI_TIMEFRAME_PROMPT_SPECS, tfList);
  const sections = specs
    .map((spec) =>
      buildRecentCandlesMarkdownSection(
        recentCandlesByInterval?.[spec.interval],
        `### ${spec.label} `,
        strategyIndicators,
        { omitColumnGlossary: true },
      ),
    )
    .filter(Boolean);
  const klineHead = [
    "## 本次触发的决策 K 线",
    "",
    promptTriggerKlineColumnGlossary(orderedIds),
    "",
    mdTable(promptTriggerKlineHeaders(orderedIds), [triggerRow]),
  ];
  if (!sections.length) {
    return klineHead.join("\n");
  }
  return [...klineHead, "", "## 市场数据多周期上下文", "", promptRecentKlineColumnGlossary(orderedIds), "", ...sections].join("\n");
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

  const thread = [...messages];
  const toolTrace: Array<{ name: string; args: Record<string, unknown>; result: unknown }> = [];
  let reasoningAcc = "";
  const wantReasoning = !!(cfg && cfg.llmReasoningEnabled === true);

  try {
    for (let step = 1; step <= maxSteps; step++) {
      const built = buildChatCompletionRequestFromMessages(thread, options, false);
      if (built.error) {
        return { ok: false, text: built.error, toolTrace, messagesOut: thread, reasoningText: reasoningAcc.trim() };
      }
      const completion = await client.chat.completions.create(
        { ...built.body, tools, tool_choice: "auto" } as unknown as ChatCompletionCreateParamsNonStreaming,
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
      const assistantText = messageContentToString(msg.content).trim();
      const assistantDecision = extractTradingDecision(msg.content);

      const tcs = msg.tool_calls;
      if (!Array.isArray(tcs) || tcs.length === 0) {
        if (assistantDecision && assistantDecision !== "hold") {
          onStep?.({ step, assistantPreview: assistantText, reasoningPreview: reasoningAcc.trim() });
          thread.push({
            role: "user",
            content: buildDecisionToolRetryPrompt(assistantDecision),
          });
          continue;
        }
        onStep?.({ step, assistantPreview: assistantText, reasoningPreview: reasoningAcc.trim() });
        return {
          ok: true,
          text: assistantText,
          reasoningText: reasoningAcc.trim(),
          toolTrace,
          messagesOut: thread,
        };
      }

      const decisionGuard = validateTradingDecisionToolCalls(msg.content, tcs);
      if (!decisionGuard.ok) {
        const blockedText = appendDecisionGuardMessage(assistantText, decisionGuard.message);
        onStep?.({
          step,
          toolCalls: tcs,
          assistantPreview: blockedText,
          reasoningPreview: reasoningAcc.trim(),
        });
        for (const parsed of decisionGuard.parsedCalls) {
          toolTrace.push({
            name: parsed.name,
            args: parsed.args,
            result: {
              ok: false,
              blocked: true,
              decision: decisionGuard.decision,
              message: decisionGuard.message,
            },
          });
        }
        return {
          ok: true,
          text: blockedText,
          reasoningText: reasoningAcc.trim(),
          toolTrace,
          messagesOut: thread,
        };
      }

      onStep?.({
        step,
        toolCalls: tcs,
        assistantPreview: assistantText,
        reasoningPreview: reasoningAcc.trim(),
      });

      for (const parsed of decisionGuard.parsedCalls) {
        const name = parsed.name;
        const args = parsed.args;
        const result = await executeTool(String(name), args, {
          step,
          assistantPreview: assistantText,
        });
        toolTrace.push({ name: String(name), args, result });
        thread.push({
          role: "tool",
          tool_call_id: parsed.id || null,
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

export {
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
  EMA50_PERIOD,
  EMA200_PERIOD,
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
