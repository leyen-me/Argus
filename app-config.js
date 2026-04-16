const { app } = require("electron");
const fs = require("fs");
const path = require("path");

/**
 * 应用配置仅此一份：用户数据目录下的 `config.json`（与仓库内同名模板在首次启动时用于生成该文件）。
 * 旧版 `argus-config.json` 会在首次迁移到 `config.json` 后删除。
 *
 * 系统提示词不在配置文件中维护，见仓库 `prompts/` 下 `system-crypto.txt`、`system-stocks.txt`。
 */
const BUNDLED_CONFIG = path.join(__dirname, "config.json");
const LEGACY_USER_CONFIG_NAME = "argus-config.json";

const PROMPT_CRYPTO_FILE = path.join(__dirname, "prompts", "system-crypto.txt");
const PROMPT_STOCKS_FILE = path.join(__dirname, "prompts", "system-stocks.txt");

const ALLOWED_INTERVAL = new Set(["1", "3", "5", "15", "30", "60", "120", "240", "D", "1D"]);

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

/** 仅当 `prompts/*.txt` 缺失或为空时的极简兜底（与 renderer 非 Electron 兜底语义一致） */
const MIN_FALLBACK_SYSTEM_PROMPT_CRYPTO =
  "你是资深加密市场价格行为分析助手，核心方法参考 Al Brooks，但输出必须服务于一个由代码维护的交易状态机。" +
  "先判断趋势、震荡或过渡，再分析本根收盘 K 线在当前位置是延续、测试、拒绝、突破、失败突破还是噪音。" +
  "重点看价格行为本身，不机械复述原始 OHLCV；所有结论都基于概率，没有足够 edge 时优先保守。" +
  "你必须严格服从状态机：只能从 allowed_intents 中选择一个 intent；若当前为 HOLDING_*，禁止重复开仓；若当前为 LOOKING_*，只有确认成立才允许 ENTER_*。" +
  "若信号一般、位置不佳、盈亏比不清晰或只是震荡中部，优先 WAIT / HOLD / CANCEL_LOOKING。" +
  "请只返回严格 JSON，不要输出 Markdown、代码块或额外解释。";

const MIN_FALLBACK_SYSTEM_PROMPT_STOCKS =
  "你是资深证券与权益市场价格行为分析助手，核心方法参考 Al Brooks，但输出必须服务于一个由代码维护的交易状态机。" +
  "先判断趋势、震荡或过渡，再分析本根收盘 K 线在当前位置是延续、测试、拒绝、突破、失败突破还是噪音。" +
  "重点看价格行为本身，不机械复述原始 OHLCV；所有结论都基于概率，没有足够 edge 时优先保守。" +
  "你必须严格服从状态机：只能从 allowed_intents 中选择一个 intent；若当前为 HOLDING_*，禁止重复开仓；若当前为 LOOKING_*，只有确认成立才允许 ENTER_*。" +
  "若处于盘前、盘后、开盘初段异常波动或流动性不足时段，必须降低信心并体现谨慎；若只是区间中部噪音，优先 WAIT / HOLD / CANCEL_LOOKING。" +
  "请只返回严格 JSON，不要输出 Markdown、代码块或额外解释。";

function normalizeSystemPromptField(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  const t = raw.trim();
  return t.length ? t : fallback;
}

/**
 * 从应用目录 `prompts/` 读取系统提示词；每次调用重新读盘，便于修改文件后在下一次 `loadAppConfig` 生效。
 * @returns {{ systemPromptCrypto: string, systemPromptStocks: string }}
 */
function loadSystemPromptsFromDisk() {
  let cryptoRaw = "";
  let stocksRaw = "";
  try {
    if (fs.existsSync(PROMPT_CRYPTO_FILE)) {
      cryptoRaw = fs.readFileSync(PROMPT_CRYPTO_FILE, "utf8");
    }
  } catch {
    cryptoRaw = "";
  }
  try {
    if (fs.existsSync(PROMPT_STOCKS_FILE)) {
      stocksRaw = fs.readFileSync(PROMPT_STOCKS_FILE, "utf8");
    }
  } catch {
    stocksRaw = "";
  }
  return {
    systemPromptCrypto: normalizeSystemPromptField(cryptoRaw, MIN_FALLBACK_SYSTEM_PROMPT_CRYPTO),
    systemPromptStocks: normalizeSystemPromptField(stocksRaw, MIN_FALLBACK_SYSTEM_PROMPT_STOCKS),
  };
}

function defaultConfigFallback() {
  return {
    symbols: [
      { label: "BTC/USDT (OKX)", value: "OKX:BTCUSDT" },
      { label: "ETH/USDT (OKX)", value: "OKX:ETHUSDT" },
      { label: "SPY", value: "AMEX:SPY" },
      { label: "QQQ", value: "NASDAQ:QQQ" },
    ],
    defaultSymbol: "OKX:BTCUSDT",
    interval: "5",
    openaiBaseUrl: DEFAULT_OPENAI_BASE_URL,
    openaiModel: DEFAULT_OPENAI_MODEL,
    openaiApiKey: "",
    ...loadSystemPromptsFromDisk(),
    /** 单次调用 LLM 的超时（毫秒），含流式读完全程 */
    llmRequestTimeoutMs: 300_000,
    /**
     * 是否请求并展示「深度思考 / reasoning」（OpenRouter 等兼容接口的 `reasoning.enabled`）。
     * 默认关闭；非 OpenRouter 或模型不支持时可能被忽略或报错，请按需开启。
     */
    llmReasoningEnabled: false,
    /** 模拟仓位开仓/平仓（含止损止盈硬触发）时发邮件；需配置 QQ SMTP 授权码 */
    tradeNotifyEmailEnabled: false,
    smtpHost: "smtp.qq.com",
    smtpPort: 465,
    smtpSecure: true,
    smtpUser: "",
    smtpPass: "",
    /** 留空则发到发件邮箱本号 */
    notifyEmailTo: "",
  };
}

/**
 * 写入 `config.json` 时不包含系统提示词（提示词仅来自仓库 `prompts/*.txt`）。
 * @param {object} cfg `normalizeConfig` 返回值
 */
function stripSystemPromptsForPersistence(cfg) {
  if (!cfg || typeof cfg !== "object") return cfg;
  const { systemPromptCrypto: _c, systemPromptStocks: _s, ...rest } = cfg;
  return rest;
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
 * 与首次启动种子一致：优先使用安装目录旁 `config.json` 模板，否则用内置默认再 `normalizeConfig`。
 * @returns {ReturnType<typeof normalizeConfig>}
 */
function buildInitialConfigFromBundled() {
  let raw = null;
  try {
    if (fs.existsSync(BUNDLED_CONFIG)) {
      raw = JSON.parse(fs.readFileSync(BUNDLED_CONFIG, "utf8"));
    }
  } catch {
    raw = null;
  }
  return normalizeConfig(raw && typeof raw === "object" ? raw : defaultConfigFallback());
}

/**
 * 将用户 `config.json` 重置为模板/内置默认值（覆盖写入），并返回规范化后的完整配置（含当前磁盘上的系统提示词）。
 * @returns {ReturnType<typeof normalizeConfig>}
 */
function resetAppConfig() {
  const initial = buildInitialConfigFromBundled();
  const p = configPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify(stripSystemPromptsForPersistence(initial), null, 2)}\n`, "utf8");
  } catch {
    /* ignore */
  }
  return initial;
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

  const initial = buildInitialConfigFromBundled();
  try {
    fs.writeFileSync(p, `${JSON.stringify(stripSystemPromptsForPersistence(initial), null, 2)}\n`, "utf8");
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

  const { systemPromptCrypto, systemPromptStocks } = loadSystemPromptsFromDisk();

  let llmRequestTimeoutMs = base.llmRequestTimeoutMs;
  const tt = Number(raw.llmRequestTimeoutMs);
  if (Number.isFinite(tt) && tt > 0) llmRequestTimeoutMs = Math.floor(tt);

  let llmReasoningEnabled = base.llmReasoningEnabled;
  if (raw.llmReasoningEnabled === true) llmReasoningEnabled = true;
  else if (raw.llmReasoningEnabled === false) llmReasoningEnabled = false;

  let tradeNotifyEmailEnabled = base.tradeNotifyEmailEnabled;
  if (raw.tradeNotifyEmailEnabled === true) tradeNotifyEmailEnabled = true;
  else if (raw.tradeNotifyEmailEnabled === false) tradeNotifyEmailEnabled = false;

  let smtpHost =
    typeof raw.smtpHost === "string" && raw.smtpHost.trim() ? raw.smtpHost.trim() : base.smtpHost;
  let smtpPort = base.smtpPort;
  const sp = Number(raw.smtpPort);
  if (Number.isFinite(sp) && sp > 0) smtpPort = Math.floor(sp);
  let smtpSecure = base.smtpSecure;
  if (raw.smtpSecure === true) smtpSecure = true;
  else if (raw.smtpSecure === false) smtpSecure = false;

  const smtpUser = typeof raw.smtpUser === "string" ? raw.smtpUser.trim() : base.smtpUser;
  const smtpPass = typeof raw.smtpPass === "string" ? raw.smtpPass.trim() : base.smtpPass;
  const notifyEmailTo =
    typeof raw.notifyEmailTo === "string" ? raw.notifyEmailTo.trim() : base.notifyEmailTo;

  return {
    symbols,
    defaultSymbol,
    interval,
    openaiBaseUrl,
    openaiModel,
    openaiApiKey,
    systemPromptCrypto,
    systemPromptStocks,
    llmRequestTimeoutMs,
    llmReasoningEnabled,
    tradeNotifyEmailEnabled,
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUser,
    smtpPass,
    notifyEmailTo,
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
  buildInitialConfigFromBundled,
  resetAppConfig,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  loadSystemPromptsFromDisk,
  stripSystemPromptsForPersistence,
  MIN_FALLBACK_SYSTEM_PROMPT_CRYPTO,
  MIN_FALLBACK_SYSTEM_PROMPT_STOCKS,
};
