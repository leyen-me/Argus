const fs = require("fs");
const path = require("path");

const localDb = require("./local-db");

/**
 * 应用可序列化设置保存在 userData SQLite（`local-db`）的 kv `app/settings` 中。
 * 首次启动或库中无记录时：用 {@link APP_SETTINGS_SEED} 经 `normalizeConfig` 后写入。
 *
 * 系统提示词正文不落库，仅 `promptStrategy` 落库；正文来自 `prompts/<策略名>/system-crypto.txt`（每次 load 读盘）。
 */
/** prompts 所在目录（本文件在 src/node，资源在 src/） */
const SRC_ROOT = path.join(__dirname, "..");
const PROMPTS_DIR = path.join(SRC_ROOT, "prompts");
const STRATEGY_PROMPT_BASENAME = "system-crypto.txt";
const DEFAULT_PROMPT_STRATEGY = "default";

const ALLOWED_INTERVAL = new Set(["1", "3", "5", "15", "30", "60", "120", "240", "D", "1D"]);

/**
 * 首次安装 /「恢复默认」时使用的持久化字段种子（仅存在于代码）。
 * @type {Readonly<Record<string, unknown>>}
 */
const APP_SETTINGS_SEED = Object.freeze({
  symbols: [
    { label: "BTC/USDT (OKX)", value: "OKX:BTCUSDT" },
    { label: "ETH/USDT (OKX)", value: "OKX:ETHUSDT" },
  ],
  defaultSymbol: "OKX:BTCUSDT",
  promptStrategy: "default",
  interval: "5",
  openaiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  openaiModel: "qwen3.5-plus",
  openaiApiKey: "",
  llmRequestTimeoutMs: 300_000,
  llmReasoningEnabled: false,
  tradeNotifyEmailEnabled: false,
  smtpHost: "smtp.qq.com",
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: "",
  smtpPass: "",
  notifyEmailTo: "",
  okxSwapTradingEnabled: false,
  okxSimulated: true,
  okxApiKey: "",
  okxSecretKey: "",
  okxPassphrase: "",
  okxSwapLeverage: 10,
  okxSwapMarginFraction: 0.25,
  okxTdMode: "isolated",
});

const DEFAULT_OPENAI_BASE_URL = APP_SETTINGS_SEED.openaiBaseUrl;
const DEFAULT_OPENAI_MODEL = APP_SETTINGS_SEED.openaiModel;

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
  const promptStrategy = resolvePromptStrategyId(
    typeof APP_SETTINGS_SEED.promptStrategy === "string" ? APP_SETTINGS_SEED.promptStrategy : undefined,
  );
  return {
    ...APP_SETTINGS_SEED,
    promptStrategy,
    ...loadSystemPromptsFromDisk(promptStrategy),
  };
}

/**
 * 持久化时不写入完整系统提示词正文（正文仅来自 `prompts/<策略>/system-crypto.txt`），但保留 `promptStrategy`。
 * @param {object} cfg `normalizeConfig` 返回值
 */
function stripSystemPromptsForPersistence(cfg) {
  if (!cfg || typeof cfg !== "object") return cfg;
  const { systemPromptCrypto: _c, ...rest } = cfg;
  return rest;
}

function persistLoadedConfig(normalizedCfg) {
  const payload = stripSystemPromptsForPersistence(normalizedCfg);
  localDb.kvSet(
    localDb.KV_NS_APP,
    localDb.KV_KEY_SETTINGS,
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

/** @returns {string} 本地 SQLite 数据库路径（userData/argus.sqlite） */
function databasePath() {
  return localDb.databasePath();
}

/** @deprecated 历史名 configPath；现为 SQLite 库路径，与 {@link databasePath} 相同 */
function configPath() {
  return databasePath();
}

/** @deprecated 与 databasePath 相同，保留旧名 */
function userConfigPath() {
  return databasePath();
}

/**
 * 确保 kv 中已有应用设置：否则用代码种子写入。
 */
function ensurePersistedConfig() {
  localDb.getDatabase();
  if (localDb.kvHas(localDb.KV_NS_APP, localDb.KV_KEY_SETTINGS)) return;

  const initial = buildInitialConfigFromSeed();
  persistLoadedConfig(initial);
}

/**
 * 与首次启动 /「恢复默认」一致：`APP_SETTINGS_SEED` 经 `normalizeConfig`。
 * @returns {ReturnType<typeof normalizeConfig>}
 */
function buildInitialConfigFromSeed() {
  return normalizeConfig({ ...APP_SETTINGS_SEED });
}

/**
 * 将应用设置重置为模板/内置默认值（覆盖写入 SQLite），并返回规范化后的完整配置（含当前磁盘上的系统提示词）。
 * @returns {ReturnType<typeof normalizeConfig>}
 */
function resetAppConfig() {
  const initial = buildInitialConfigFromSeed();
  persistLoadedConfig(initial);
  return initial;
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
  ensurePersistedConfig();
  const rawStr = localDb.kvGet(localDb.KV_NS_APP, localDb.KV_KEY_SETTINGS);
  try {
    const raw = JSON.parse(rawStr);
    return normalizeConfig(raw);
  } catch {
    const repaired = normalizeConfig(defaultConfigFallback());
    persistLoadedConfig(repaired);
    return repaired;
  }
}

/**
 * 合并 partial 到当前配置、规范化并持久化（主进程保存配置用）。
 * @param {Record<string, unknown>} payload
 * @returns {ReturnType<typeof normalizeConfig>}
 */
function saveMergedConfigPayload(payload) {
  const current = loadAppConfig();
  const merged = { ...current, ...payload };
  const next = normalizeConfig(merged);
  persistLoadedConfig(next);
  return next;
}

module.exports = {
  APP_SETTINGS_SEED,
  loadAppConfig,
  normalizeConfig,
  databasePath,
  configPath,
  userConfigPath,
  buildInitialConfigFromSeed,
  resetAppConfig,
  saveMergedConfigPayload,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  loadSystemPromptsFromDisk,
  listPromptStrategies,
  resolvePromptStrategyId,
  stripSystemPromptsForPersistence,
  MIN_FALLBACK_SYSTEM_PROMPT_CRYPTO,
};
