const { app } = require("electron");
const fs = require("fs");
const path = require("path");

/**
 * 应用配置仅此一份：用户数据目录下的 `config.json`（与仓库内同名模板在首次启动时用于生成该文件）。
 * 旧版 `argus-config.json` 会在首次迁移到 `config.json` 后删除。
 *
 * 系统提示词按策略分目录：`prompts/<策略名>/system-crypto.txt`；当前策略 ID 写在 `config.json` 的 `promptStrategy`。
 */
/** 内置模板与 prompts 所在目录（本文件在 src/node，资源在 src/） */
const SRC_ROOT = path.join(__dirname, "..");
const BUNDLED_CONFIG = path.join(SRC_ROOT, "config.json");
const LEGACY_USER_CONFIG_NAME = "argus-config.json";

const PROMPTS_DIR = path.join(SRC_ROOT, "prompts");
const STRATEGY_PROMPT_BASENAME = "system-crypto.txt";
const DEFAULT_PROMPT_STRATEGY = "default";

const ALLOWED_INTERVAL = new Set(["1", "3", "5", "15", "30", "60", "120", "240", "D", "1D"]);

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

/** 仅当策略文件缺失或为空时的极简兜底（与 renderer 非 Electron 兜底语义一致） */
const MIN_FALLBACK_SYSTEM_PROMPT_CRYPTO =
  "你是资深加密市场价格行为分析助手，核心方法参考 Al Brooks，但输出必须服务于一个由代码维护的交易状态机。" +
  "先判断趋势、震荡或过渡，再分析本根收盘 K 线在当前位置是延续、测试、拒绝、突破、失败突破还是噪音。" +
  "重点看价格行为本身，不机械复述原始 OHLCV；所有结论都基于概率，没有足够 edge 时优先保守。" +
  "你必须严格服从状态机：只能从 allowed_intents 中选择一个 intent；若当前为 HOLDING_*，禁止重复开仓；若当前为 LOOKING_*，只有确认成立才允许 ENTER_*。" +
  "若信号一般、位置不佳、盈亏比不清晰或只是震荡中部，优先 WAIT / HOLD / CANCEL_LOOKING。" +
  "请只返回严格 JSON，不要输出 Markdown、代码块或额外解释。";

function normalizeSystemPromptField(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  const t = raw.trim();
  return t.length ? t : fallback;
}

/**
 * 枚举 `prompts/<目录>/system-crypto.txt` 存在的子目录名（每种策略一个文件夹）。
 * @returns {string[]}
 */
function listPromptStrategies() {
  const out = [];
  try {
    if (!fs.existsSync(PROMPTS_DIR)) return [DEFAULT_PROMPT_STRATEGY];
    const entries = fs.readdirSync(PROMPTS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const name = e.name;
      if (name.startsWith(".")) continue;
      const f = path.join(PROMPTS_DIR, name, STRATEGY_PROMPT_BASENAME);
      if (fs.existsSync(f)) out.push(name);
    }
  } catch {
    return [DEFAULT_PROMPT_STRATEGY];
  }
  out.sort((a, b) => {
    if (a === DEFAULT_PROMPT_STRATEGY) return -1;
    if (b === DEFAULT_PROMPT_STRATEGY) return 1;
    return a.localeCompare(b);
  });
  return out.length ? out : [DEFAULT_PROMPT_STRATEGY];
}

/**
 * @param {string | undefined} preferred 首选策略文件夹名
 * @returns {string}
 */
function resolvePromptStrategyId(preferred) {
  const available = listPromptStrategies();
  const want =
    typeof preferred === "string" && preferred.trim() ? preferred.trim() : DEFAULT_PROMPT_STRATEGY;
  if (available.includes(want)) return want;
  /** 未填写、或 ID 无效 / 已删目录时：回到 default（「默认提示词」固定对应 prompts/default） */
  if (want === DEFAULT_PROMPT_STRATEGY || preferred == null || preferred === "") {
    return DEFAULT_PROMPT_STRATEGY;
  }
  if (available.includes(DEFAULT_PROMPT_STRATEGY)) return DEFAULT_PROMPT_STRATEGY;
  return available[0] || DEFAULT_PROMPT_STRATEGY;
}

/**
 * 从 `prompts/<strategy>/system-crypto.txt` 读取；每次 `loadAppConfig` 重新读盘。
 * @param {string} [strategyId]
 * @returns {{ systemPromptCrypto: string }}
 */
function loadSystemPromptsFromDisk(strategyId) {
  const id = resolvePromptStrategyId(strategyId);
  let cryptoRaw = "";
  try {
    const f = path.join(PROMPTS_DIR, id, STRATEGY_PROMPT_BASENAME);
    if (fs.existsSync(f)) {
      cryptoRaw = fs.readFileSync(f, "utf8");
    }
  } catch {
    cryptoRaw = "";
  }
  return {
    systemPromptCrypto: normalizeSystemPromptField(cryptoRaw, MIN_FALLBACK_SYSTEM_PROMPT_CRYPTO),
  };
}

function defaultConfigFallback() {
  const promptStrategy = resolvePromptStrategyId(DEFAULT_PROMPT_STRATEGY);
  return {
    symbols: [
      { label: "BTC/USDT (OKX)", value: "OKX:BTCUSDT" },
      { label: "ETH/USDT (OKX)", value: "OKX:ETHUSDT" },
    ],
    defaultSymbol: "OKX:BTCUSDT",
    interval: "5",
    openaiBaseUrl: DEFAULT_OPENAI_BASE_URL,
    openaiModel: DEFAULT_OPENAI_MODEL,
    openaiApiKey: "",
    promptStrategy,
    ...loadSystemPromptsFromDisk(promptStrategy),
    /** 单次调用 LLM 的超时（毫秒），含流式读完全程 */
    llmRequestTimeoutMs: 300_000,
    /**
     * 是否请求并展示「深度思考」：OpenRouter 用 `reasoning.enabled`；其它兼容端点（如通义）用 `enable_thinking`。
     * 默认关闭；模型不支持时可能被忽略或报错，请按需开启。
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
    /** OKX USDT 永续：需显式开启；默认模拟盘（x-simulated-trading + 模拟站密钥） */
    okxSwapTradingEnabled: false,
    okxSimulated: true,
    okxApiKey: "",
    okxSecretKey: "",
    okxPassphrase: "",
    okxSwapLeverage: 10,
    /** 使用账户 USDT 可用权益的比例作为单笔保证金（默认 0.25 = 25%） */
    okxSwapMarginFraction: 0.25,
    okxTdMode: "isolated",
  };
}

/**
 * 写入 `config.json` 时不包含完整系统提示词正文（正文仅来自 `prompts/<策略>/system-crypto.txt`），但保留 `promptStrategy`。
 * @param {object} cfg `normalizeConfig` 返回值
 */
function stripSystemPromptsForPersistence(cfg) {
  if (!cfg || typeof cfg !== "object") return cfg;
  const { systemPromptCrypto: _c, ...rest } = cfg;
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
 * 与首次启动种子一致：优先使用 `src/config.json` 模板，否则用内置默认再 `normalizeConfig`。
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
 * 确保 userData/config.json 存在：优先迁移旧 argus-config.json，否则从 `src/config.json` 模板或内置默认写入。
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
      if (s.feed === "crypto") row.feed = s.feed;
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

  const promptStrategy = resolvePromptStrategyId(
    typeof raw.promptStrategy === "string" && raw.promptStrategy.trim()
      ? raw.promptStrategy.trim()
      : base.promptStrategy,
  );
  const { systemPromptCrypto } = loadSystemPromptsFromDisk(promptStrategy);

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

  let okxSwapTradingEnabled = base.okxSwapTradingEnabled;
  if (raw.okxSwapTradingEnabled === true) okxSwapTradingEnabled = true;
  else if (raw.okxSwapTradingEnabled === false) okxSwapTradingEnabled = false;

  let okxSimulated = base.okxSimulated;
  if (raw.okxSimulated === true) okxSimulated = true;
  else if (raw.okxSimulated === false) okxSimulated = false;

  const okxApiKey = typeof raw.okxApiKey === "string" ? raw.okxApiKey.trim() : base.okxApiKey;
  const okxSecretKey =
    typeof raw.okxSecretKey === "string" ? raw.okxSecretKey.trim() : base.okxSecretKey;
  const okxPassphrase =
    typeof raw.okxPassphrase === "string" ? raw.okxPassphrase.trim() : base.okxPassphrase;

  let okxSwapLeverage = base.okxSwapLeverage;
  const ol = Number(raw.okxSwapLeverage);
  if (Number.isFinite(ol) && ol >= 1) okxSwapLeverage = Math.min(125, Math.floor(ol));

  let okxSwapMarginFraction = base.okxSwapMarginFraction;
  const omf = Number(raw.okxSwapMarginFraction);
  if (Number.isFinite(omf) && omf > 0) okxSwapMarginFraction = Math.min(1, omf);

  let okxTdMode = base.okxTdMode;
  if (raw.okxTdMode === "isolated") okxTdMode = "isolated";
  else if (raw.okxTdMode === "cross") okxTdMode = "cross";

  return {
    symbols,
    defaultSymbol,
    interval,
    openaiBaseUrl,
    openaiModel,
    openaiApiKey,
    promptStrategy,
    promptStrategies: listPromptStrategies(),
    systemPromptCrypto,
    llmRequestTimeoutMs,
    llmReasoningEnabled,
    tradeNotifyEmailEnabled,
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUser,
    smtpPass,
    notifyEmailTo,
    okxSwapTradingEnabled,
    okxSimulated,
    okxApiKey,
    okxSecretKey,
    okxPassphrase,
    okxSwapLeverage,
    okxSwapMarginFraction,
    okxTdMode,
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
  listPromptStrategies,
  resolvePromptStrategyId,
  stripSystemPromptsForPersistence,
  MIN_FALLBACK_SYSTEM_PROMPT_CRYPTO,
};
