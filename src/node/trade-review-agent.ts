/**
 * 只读交易复盘 Agent：不挂载任何交易工具，只基于压缩上下文给出归因和改进建议。
 */
import { callOpenAIChat, isLlmEnabled } from "./llm.js";

const REVIEW_SYSTEM_PROMPT = [
  "你是交易复盘教练，只负责复盘已经结束的交易，禁止给出新的开仓/平仓指令。",
  "你会看到开仓理由、止盈止损计划、持仓过程压缩时间线和退出信息。",
  "判断“市场错”还是“自己错”时，必须以入场时的原始假设为基准：如果市场走法仍在原计划概率范围内但执行偏离，归为自己/执行问题；如果计划合理且失效点被触发，归为市场验证失败或正常亏损。",
  "请给出可执行建议，不要泛泛而谈。",
].join("\n");

function extractAttribution(text: string) {
  const lower = text.toLowerCase();
  if (/数据不足|证据不足/.test(text)) return "data_insufficient";
  if (/风控问题|仓位|止损过大|止损过小/.test(text)) return "risk_issue";
  if (/执行问题|没有遵守|偏离计划|纪律/.test(text)) return "execution_issue";
  if (/自己错|判断错误|入场错误|假设错误/.test(text)) return "self_error";
  if (/市场错|正常亏损|假设被否定|市场验证失败/.test(text) || lower.includes("market")) return "market_error";
  return null;
}

function extractLessons(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, "").replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean);
  const start = lines.findIndex((line) => /改进|清单|下次|建议/.test(line));
  const pool = start >= 0 ? lines.slice(start + 1) : lines;
  return pool
    .filter((line) => line.length >= 6 && !/^#+\s*/.test(line))
    .slice(0, 8);
}

async function runTradeReviewAgent(
  prompt: string,
  options: { appConfig: Record<string, unknown>; baseUrl?: string; model?: string },
) {
  const cfg = options.appConfig;
  if (!isLlmEnabled(cfg)) {
    return { ok: false, text: "LLM 未启用，无法生成交易复盘。" };
  }
  const reviewCfg = {
    ...cfg,
    systemPromptCrypto: REVIEW_SYSTEM_PROMPT,
    llmReasoningEnabled: false,
  };
  const result = await callOpenAIChat(prompt, {
    ...options,
    appConfig: reviewCfg,
    llmReasoningForThisRequest: false,
  });
  if (!result.ok) return result;
  const text = String(result.text || "").trim();
  return {
    ok: true,
    text,
    attribution: extractAttribution(text),
    lessons: extractLessons(text),
  };
}

export { runTradeReviewAgent, extractAttribution, extractLessons };
