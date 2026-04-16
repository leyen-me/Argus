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
 *
 * 运行：
 *   pnpm run test:dashscope
 */

const assert = require("node:assert");
const OpenAI = require("openai");

const DEFAULT_BASE =
  process.env.DASHSCOPE_COMPAT_BASE_URL ||
  "https://dashscope.aliyuncs.com/compatible-mode/v1";

const MODEL = process.env.DASHSCOPE_MODEL || "qwen3.5-plus";

async function demoChatCompletion() {
  const apiKey = (process.env.DASHSCOPE_API_KEY || "").trim();
  assert.ok(apiKey, "请设置环境变量 DASHSCOPE_API_KEY");

  const client = new OpenAI({
    apiKey,
    baseURL: DEFAULT_BASE,
  });

  const completion = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.3,
    messages: [
      { role: "system", content: "你是简洁助手，用一两句话回答。" },
      { role: "user", content: "用一句话说明什么是 K 线。" },
    ],
  });

  const text = (completion.choices[0]?.message?.content || "").trim();
  assert.ok(text.length > 0, "模型返回为空，请检查模型名、地域端点与账号权限");

  console.log("[dashscope-demo] baseURL:", DEFAULT_BASE);
  console.log("[dashscope-demo] model:", MODEL);
  console.log("[dashscope-demo] reply:\n", text);
  if (completion.usage) {
    console.log("[dashscope-demo] usage:", JSON.stringify(completion.usage));
  }
}

demoChatCompletion().catch((err) => {
  console.error("[dashscope-demo] failed:", err.message || err);
  process.exitCode = 1;
});
