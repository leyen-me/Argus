const { app } = require("electron");
const fs = require("fs");
const path = require("path");

/**
 * 应用配置仅此一份：用户数据目录下的 `config.json`（与仓库内同名模板在首次启动时用于生成该文件）。
 * 旧版 `argus-config.json` 会在首次迁移到 `config.json` 后删除。
 */
const BUNDLED_CONFIG = path.join(__dirname, "config.json");
const LEGACY_USER_CONFIG_NAME = "argus-config.json";

const ALLOWED_INTERVAL = new Set(["1", "3", "5", "15", "30", "60", "120", "240", "D", "1D"]);

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

/** 币圈（BINANCE 等）：24h 连续交易 */
const DEFAULT_SYSTEM_PROMPT_CRYPTO =
  "你是资深加密市场分析助手。加密资产**7×24 小时连续交易**，无传统股市的固定「开盘/收盘」日界；每轮用户会提供一根**已收盘确认**的 K 线数据，必要时附带当前图表截图。" +
  "请结合**此前对话中你已给出的判断**，与本轮新数据衔接分析，用简体中文作答：短期趋势、关键价位与观察点、风险提醒。注意不同时区下各时段流动性可能差异较大。" +
  "单轮回复仍宜简洁（约 200 字内），勿输出 Markdown 代码块。";

/** 股票/长桥：强调常规交易时段（如美股美东 9:30 起）与盘前盘后差异 */
const DEFAULT_SYSTEM_PROMPT_STOCKS =
  "你是资深证券与权益市场分析助手。标的通常为**分段交易时段**品种：例如美股**常规交易时段**一般为**美东 9:30–16:00**；盘前、盘后与常规时段相比，流动性与价差特征可能不同；港股等另有当地交易时段。" +
  "每轮用户会提供一根**已收盘确认**的 K 线数据，必要时附带当前图表截图。请结合**此前对话中你已给出的判断**，与本轮新数据衔接分析，用简体中文作答：短期趋势、关键价位与观察点、风险提醒；" +
  "若该根 K 线明显落在常规时段之外，可简要提醒流动性与解读注意点。单轮回复仍宜简洁（约 200 字内），勿输出 Markdown 代码块。";

function defaultConfigFallback() {
  return {
    symbols: [
      { label: "BTC/USDT", value: "BINANCE:BTCUSDT" },
      { label: "ETH/USDT", value: "BINANCE:ETHUSDT" },
      { label: "SPY", value: "AMEX:SPY" },
      { label: "QQQ", value: "NASDAQ:QQQ" },
    ],
    defaultSymbol: "BINANCE:BTCUSDT",
    interval: "5",
    openaiBaseUrl: DEFAULT_OPENAI_BASE_URL,
    openaiModel: DEFAULT_OPENAI_MODEL,
    openaiApiKey: "",
    systemPromptCrypto: DEFAULT_SYSTEM_PROMPT_CRYPTO,
    systemPromptStocks: DEFAULT_SYSTEM_PROMPT_STOCKS,
  };
}

/** @returns {string} 唯一生效的配置文件路径（userData/config.json） */
function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

/** @deprecated 与 configPath 相同，保留旧名 */
function userConfigPath() {
  return configPath();
}

/**
 * 确保 userData/config.json 存在：优先迁移旧 argus-config.json，否则从仓库旁 config.json 或内置默认写入。
 */
function ensureConfigFile() {
  const p = configPath();
  const dir = path.dirname(p);
  const legacy = path.join(dir, LEGACY_USER_CONFIG_NAME);

  if (fs.existsSync(p)) {
    return;
  }

  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(legacy)) {
    try {
      fs.copyFileSync(legacy, p);
      fs.unlinkSync(legacy);
      return;
    } catch {
      /* fall through to seed */
    }
  }

  let raw = null;
  try {
    if (fs.existsSync(BUNDLED_CONFIG)) {
      raw = JSON.parse(fs.readFileSync(BUNDLED_CONFIG, "utf8"));
    }
  } catch {
    raw = null;
  }
  const initial = normalizeConfig(raw && typeof raw === "object" ? raw : defaultConfigFallback());
  try {
    fs.writeFileSync(p, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

function normalizeOpenAiBaseUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_OPENAI_BASE_URL;
  const u = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) return DEFAULT_OPENAI_BASE_URL;
  return u;
}

function normalizeOpenAiModel(raw) {
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_OPENAI_MODEL;
  return raw.trim();
}

function normalizeSystemPromptField(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  const t = raw.trim();
  return t.length ? t : fallback;
}

function normalizeConfig(raw) {
  const base = defaultConfigFallback();
  if (!raw || typeof raw !== "object") return base;
  let symbols = Array.isArray(raw.symbols) ? raw.symbols : base.symbols;
  symbols = symbols
    .filter((s) => s && typeof s.label === "string" && typeof s.value === "string")
    .map((s) => {
      const row = {
        label: s.label.trim(),
        value: s.value.trim(),
      };
      if (s.feed === "crypto" || s.feed === "longbridge") row.feed = s.feed;
      if (typeof s.longPortSymbol === "string" && s.longPortSymbol.trim()) {
        row.longPortSymbol = s.longPortSymbol.trim();
      }
      return row;
    })
    .filter((s) => s.label && s.value);
  const seen = new Set();
  symbols = symbols.filter((s) => {
    if (seen.has(s.value)) return false;
    seen.add(s.value);
    return true;
  });
  if (symbols.length === 0) symbols = base.symbols;

  let defaultSymbol =
    typeof raw.defaultSymbol === "string" ? raw.defaultSymbol.trim() : "";
  if (!symbols.some((s) => s.value === defaultSymbol)) {
    defaultSymbol = symbols[0].value;
  }

  let interval = typeof raw.interval === "string" ? raw.interval.trim() : base.interval;
  if (!ALLOWED_INTERVAL.has(interval)) interval = base.interval;

  const openaiBaseUrl = normalizeOpenAiBaseUrl(
    typeof raw.openaiBaseUrl === "string" ? raw.openaiBaseUrl : base.openaiBaseUrl,
  );
  const openaiModel = normalizeOpenAiModel(
    typeof raw.openaiModel === "string" ? raw.openaiModel : base.openaiModel,
  );
  const openaiApiKey =
    typeof raw.openaiApiKey === "string" ? raw.openaiApiKey.trim() : base.openaiApiKey;

  const systemPromptCrypto = normalizeSystemPromptField(
    raw.systemPromptCrypto,
    base.systemPromptCrypto,
  );
  const systemPromptStocks = normalizeSystemPromptField(
    raw.systemPromptStocks,
    base.systemPromptStocks,
  );

  return {
    symbols,
    defaultSymbol,
    interval,
    openaiBaseUrl,
    openaiModel,
    openaiApiKey,
    systemPromptCrypto,
    systemPromptStocks,
  };
}

function loadAppConfig() {
  ensureConfigFile();
  const p = configPath();
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return normalizeConfig(raw);
  } catch {
    return normalizeConfig(defaultConfigFallback());
  }
}

module.exports = {
  loadAppConfig,
  normalizeConfig,
  configPath,
  userConfigPath,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_SYSTEM_PROMPT_CRYPTO,
  DEFAULT_SYSTEM_PROMPT_STOCKS,
};
