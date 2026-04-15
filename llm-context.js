/**
 * 多轮对话上下文：按「TradingView 品种 + K 线周期」分桶，仅存文本（历史轮不重传截图，避免体积与重复）。
 * API 侧在 bar-close 中另经 keepOnlyLastUserImageInMessages 保证仅最后一轮 user 可带图。
 */
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

/** 每个品种+周期保留的「用户+助手」对数（仅文本），约 8 轮 = 16 条 message */
const MAX_PAIRS = 8;

function storePath() {
  return path.join(app.getPath("userData"), "argus-llm-conversations.json");
}

/** @type {Record<string, Array<{ role: 'user' | 'assistant', content: string }>> | null} */
let cache = null;

function loadStore() {
  if (cache) return cache;
  cache = {};
  const p = storePath();
  if (!fs.existsSync(p)) return cache;
  try {
    const raw = fs.readFileSync(p, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      cache = data;
    }
  } catch {
    cache = {};
  }
  return cache;
}

function saveStore() {
  const p = storePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify(cache || {}, null, 2)}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} tvSymbol 如 BINANCE:BTCUSDT
 * @param {string} interval 如 5、60、D
 */
function conversationKey(tvSymbol, interval) {
  return `${String(tvSymbol).trim()}|${String(interval).trim()}`;
}

/**
 * 取该桶内已完成的 user/assistant 文本消息（不含本轮）。
 * @param {string} key
 * @returns {Array<{ role: 'user' | 'assistant', content: string }>}
 */
function getHistoryMessages(key) {
  const s = loadStore();
  const list = s[key];
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content }));
}

/**
 * 本轮成功收到助手全文后追加；自动裁剪最旧若干对。
 * @param {string} key
 * @param {string} userPlain 写入历史的用户侧文本（与发给 API 的文本部分一致，可注明是否含图）
 * @param {string} assistantText
 */
function appendSuccessfulTurn(key, userPlain, assistantText) {
  const s = loadStore();
  if (!s[key]) s[key] = [];
  const u = String(userPlain || "").trim();
  const a = String(assistantText || "").trim();
  if (!u || !a) return;
  s[key].push({ role: "user", content: u });
  s[key].push({ role: "assistant", content: a });
  const maxLen = MAX_PAIRS * 2;
  while (s[key].length > maxLen) {
    s[key].shift();
    if (s[key].length) s[key].shift();
  }
  saveStore();
}

/**
 * 清空某个品种+周期的对话（例如换逻辑时可调用）。
 * @param {string} key
 */
function clearConversation(key) {
  const s = loadStore();
  delete s[key];
  saveStore();
}

module.exports = {
  conversationKey,
  getHistoryMessages,
  appendSuccessfulTurn,
  clearConversation,
  MAX_PAIRS,
};
