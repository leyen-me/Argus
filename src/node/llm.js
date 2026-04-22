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
 * 本轮发给 API 的 user 内容（含多模态）。K 线收盘 Agent 为单轮 system+user，历史不落盘到 LLM messages；持久化见 agent_bar_turns 表。
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

/** 与 renderer 中 `splitLegacyAssistantAndToolText` 一致：去掉老格式里拼接的工具轨迹。 */
function stripToolSectionFromAssistantRaw(raw) {
  const t = typeof raw === "string" ? raw : "";
  const marker = "\n---\n工具轨迹：\n";
  const idx = t.indexOf(marker);
  if (idx < 0) return t.trim();
  return t.slice(0, idx).trim();
}

const CARD_SUMMARY_MAX_INPUT_CHARS = 12_000;
const SUMMARY_LLM_MAX_MS = 60_000;

/**
 * 主 Agent 成功后再调一次小模型/同模型，生成右侧「无成交」卡片的极短中文摘要（额外交费 + 约数十秒级延迟，失败不阻断主流程）。
 * @param {string} assistantFull
 * @param {{ appConfig: object, baseUrl?: string, model?: string }} options
 * @returns {Promise<{ ok: boolean, text?: string }>}
 */
async function summarizeAgentAnalysisForCard(assistantFull, options) {
  const cfg = options.appConfig;
  if (!isLlmEnabled(cfg)) {
    return { ok: false };
  }
  const bodyText = stripToolSectionFromAssistantRaw(assistantFull);
  if (!bodyText) {
    return { ok: false };
  }
  const cut =
    bodyText.length > CARD_SUMMARY_MAX_INPUT_CHARS
      ? `${bodyText.slice(0, CARD_SUMMARY_MAX_INPUT_CHARS)}\n\n…（后文已省略）`
      : bodyText;
  const system =
    "你是交易日志编辑。用户会给你一根 K 线收盘的 Agent 分析全文。请用**一两句**中文写「卡片外显摘要」：\n" +
    "仅结论与操作含义（多/空/观望/未下单等），不要列表、小标题、Markdown、引号。总字数 120 字以内。";
  const user = `以下为本轮分析内容，请直接输出摘要句子：\n\n${cut}`;
  const built = buildChatCompletionRequestFromMessages(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    options,
    false,
  );
  if (built.error) {
    return { ok: false };
  }
  const body = { ...built.body, temperature: 0.2, max_tokens: 256 };
  if (isOpenRouterBaseUrl(built.baseURL) && "reasoning" in body) {
    delete body.reasoning;
  }
  if (isDashScopeBaseUrl(built.baseURL)) {
    body.enable_thinking = false;
  }
  const apiKey = resolveOpenAiApiKey(cfg);
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(SUMMARY_LLM_MAX_MS)
      : llmAbortSignal(cfg);
  const client = new OpenAI({
    apiKey,
    baseURL: built.baseURL,
    timeout: Math.min(SUMMARY_LLM_MAX_MS + 5_000, llmRequestTimeoutMs(cfg)),
    maxRetries: 0,
  });
  try {
    const completion = await client.chat.completions.create(/** @type {any} */ (body), { signal });
    const rawMsg = completion?.choices?.[0]?.message?.content;
    const text = messageContentToString(rawMsg).trim();
    if (!text) {
      return { ok: false };
    }
    const oneLine = text.replace(/\s+/g, " ").replace(/^["'「]+|["'」]+$/g, "").trim();
    if (!oneLine) {
      return { ok: false };
    }
    return { ok: true, text: oneLine.length > 200 ? oneLine.slice(0, 197) + "…" : oneLine };
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
function buildRecentCandlesMarkdownSection(recent) {
  if (!recent) return "";
  const title = "### 最近 K 线（OKX REST）";
  if (!recent.ok) {
    const err = mdCell(recent.error || "未知错误");
    return ["", title, "", `（拉取失败：${err}。请依赖上图与上方「已收盘」一根。）`].join("\n");
  }
  const meta =
    recent.instId && recent.bar
      ? ` \`${recent.instId}\` · \`${recent.bar}\` · 共 ${recent.rows?.length ?? 0} 根（UTC，旧→新）`
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
  const emaNote = `表：最近 ${show} 根（旧→新）。\`EMA20\`：收盘 EMA(${EMA20_PERIOD})，第 1–${
    EMA20_PERIOD - 1
  } 根无该列；本轮拉取 ${rows.length} 根参与计算。`;
  return [
    "",
    `${title}${meta}`,
    "",
    emaNote,
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

/**
 * 非流式多轮工具调用（Chat Completions tools），兼容 OpenAI 及多数 OpenAI 兼容网关。
 * @param {Array<{ role: string, content?: unknown, tool_calls?: unknown, tool_call_id?: string }>} messages
 * @param {{ appConfig: object, baseUrl?: string, model?: string }} options
 * @param {{
 *   tools: unknown[],
 *   executeTool: (name: string, args: object) => Promise<object>,
 *   maxSteps?: number,
 *   onStep?: (ev: { step: number, toolCalls?: unknown[], assistantPreview?: string }) => void,
 * }} agentOpts
 */
async function runTradingAgentTurn(messages, options, agentOpts) {
  const cfg = options.appConfig;
  if (!isLlmEnabled(cfg)) {
    return { ok: false, text: "LLM 未启用。", toolTrace: [], messagesOut: messages };
  }
  const apiKey = resolveOpenAiApiKey(cfg);
  const signal = llmAbortSignal(cfg);
  const built = buildChatCompletionRequestFromMessages(messages, options, false);
  if (built.error) {
    return { ok: false, text: built.error, toolTrace: [], messagesOut: messages };
  }

  const tools = agentOpts.tools;
  const executeTool = agentOpts.executeTool;
  const maxSteps = Math.min(16, Math.max(1, Number(agentOpts.maxSteps) || 8));
  const onStep = typeof agentOpts.onStep === "function" ? agentOpts.onStep : null;

  const client = new OpenAI({
    apiKey,
    baseURL: built.baseURL,
    timeout: llmRequestTimeoutMs(cfg),
    maxRetries: 0,
  });

  const bodyBase = { ...built.body, tools, tool_choice: "auto" };
  let thread = [...messages];
  const toolTrace = [];

  try {
    for (let step = 1; step <= maxSteps; step++) {
      const completion = await client.chat.completions.create(
        { ...bodyBase, messages: thread },
        { signal },
      );
      const choice = completion?.choices?.[0];
      const msg = choice?.message;
      if (!msg) {
        return { ok: false, text: "LLM 无有效 message。", toolTrace, messagesOut: thread };
      }
      thread.push(msg);

      const tcs = msg.tool_calls;
      if (!Array.isArray(tcs) || tcs.length === 0) {
        const finalText = messageContentToString(msg.content).trim();
        onStep?.({ step, assistantPreview: finalText });
        return {
          ok: true,
          text: finalText,
          reasoningText: "",
          toolTrace,
          messagesOut: thread,
        };
      }

      onStep?.({ step, toolCalls: tcs, assistantPreview: messageContentToString(msg.content).trim() });

      for (const tc of tcs) {
        const name = tc?.function?.name || "";
        let args = {};
        try {
          args = JSON.parse(tc.function?.arguments || "{}");
        } catch {
          args = {};
        }
        const result = await executeTool(String(name), args);
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
    };
  } catch (e) {
    const err = mapLlmSdkError(e, cfg);
    return { ok: false, text: err.text, toolTrace, messagesOut: thread };
  }
}

module.exports = {
  callOpenAIChat,
  streamOpenAIChat,
  summarizeAgentAnalysisForCard,
  runTradingAgentTurn,
  buildUserPrompt,
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
  isLlmEnabled,
  resolveOpenAiApiKey,
  keepOnlyLastUserImageInMessages,
};
