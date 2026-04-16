/**
 * 阿里云通义（DashScope）— 使用官方推荐的 OpenAI Node SDK + 兼容模式端点。
 *
 * 你遇到的 `url error, please check url` 来自 npm 包 `dashscope-sdk-nodejs`：
 * 该库把代码打成单文件后仍用 `__filename` 推导 task 路径，`getTaskGroupAndTask` 按 `.` 分割路径，
 * 会把 `dashscope-sdk-nodejs.cjs.js` 误解析成错误的服务路径，从而请求到无效 URL。
 * 因此这里改用阿里云文档中的兼容模式（与现有 llm.js 的 Chat Completions 形态一致）。
 *
 * 前置：
 *   export DASHSCOPE_API_KEY="sk-..."
 *
 * 可选：
 *   DASHSCOPE_MODEL          默认 qwen-plus
 *   DASHSCOPE_COMPAT_BASE_URL  默认北京地域兼容端点；新加坡等国际域见阿里云文档
 *   DASHSCOPE_ENABLE_THINKING  设为 0 / false 可关闭深度思考（默认开启，需模型支持，如 qwen3-max 等）
 *
 * 运行：
 *   pnpm run test:dashscope
 *
 * 本示例为流式输出（stream: true）：同时打印「思考」与「正文」（与 llm.js 中 reasoning 解析方式一致）。
 */

const assert = require("node:assert");
const OpenAI = require("openai");

const DEFAULT_BASE =
  process.env.DASHSCOPE_COMPAT_BASE_URL ||
  "https://dashscope.aliyuncs.com/compatible-mode/v1";

const MODEL = process.env.DASHSCOPE_MODEL || "qwen3.5-plus";

const enableThinking = false

/**
 * 与 llm.js 的 appendReasoningFromDelta 一致：兼容 reasoning_details / reasoning / reasoning_content。
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

async function demoChatCompletionStream() {
  const apiKey = (process.env.DASHSCOPE_API_KEY || "").trim();
  assert.ok(apiKey, "请设置环境变量 DASHSCOPE_API_KEY");

  const client = new OpenAI({
    apiKey,
    baseURL: DEFAULT_BASE,
  });

  /** @type {Record<string, unknown>} */
  const req = {
    model: MODEL,
    temperature: 0.3,
    stream: true,
    messages: [
      { role: "system", content: "你是简洁助手，用一两句话回答。" },
      { role: "user", content: "用一句话说明什么是 K 线。" },
    ],
  };
  if (enableThinking) {
    req.extra_body={"enable_thinking": enableThinking}
  }

  const stream = await client.chat.completions.create(req);

  console.log("[dashscope-demo] baseURL:", DEFAULT_BASE);
  console.log("[dashscope-demo] model:", MODEL);
  console.log("[dashscope-demo] enable_thinking:", enableThinking);

  let headerThinking = false;
  let headerReply = false;
  let full = "";
  let fullReasoning = "";

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    const d =
      delta && typeof delta === "object" ? /** @type {Record<string, unknown>} */ (delta) : {};

    const reasoningPiece = appendReasoningFromDelta(d);
    if (reasoningPiece) {
      fullReasoning = mergeReasoningChunk(fullReasoning, reasoningPiece);
      if (!headerThinking) {
        process.stdout.write("[dashscope-demo] thinking (stream):\n");
        headerThinking = true;
      }
      process.stdout.write(reasoningPiece);
    }

    const piece = typeof d.content === "string" ? d.content : "";
    if (piece) {
      full += piece;
      if (!headerReply) {
        if (headerThinking) process.stdout.write("\n");
        process.stdout.write("[dashscope-demo] reply (stream):\n");
        headerReply = true;
      }
      process.stdout.write(piece);
    }
  }

  process.stdout.write("\n");
  assert.ok(
    full.trim().length > 0 || fullReasoning.trim().length > 0,
    "模型返回为空，请检查模型是否支持思考、模型名与地域端点",
  );
}

demoChatCompletionStream().catch((err) => {
  console.error("[dashscope-demo] failed:", err.message || err);
  process.exitCode = 1;
});
