const localDb = require("./local-db");
const promptStrategiesStore = require("./prompt-strategies-store");

/**
 * 应用可序列化设置保存在仓库根目录 `argus.sqlite`（`local-db`）的 kv `app/settings` 中。
 * 首次启动或库中无记录时：用 {@link APP_SETTINGS_SEED} 经 `normalizeConfig` 后写入。
 *
 * 系统提示词正文存于 SQLite 表 `prompt_strategies`（界面「策略中心」管理）；`app/settings` 仅保存当前选用的 `promptStrategy` id。
 */
const DEFAULT_PROMPT_STRATEGY = promptStrategiesStore.DEFAULT_PROMPT_STRATEGY;

const ALLOWED_INTERVAL = new Set(["1", "3", "5", "15", "30", "60", "120", "240", "D", "1D"]);

/**
 * 首次安装 /「恢复默认」时使用的持久化字段种子（仅存在于代码）。
 * @type {Readonly<Record<string, unknown>>}
 */
const APP_SETTINGS_SEED = Object.freeze({
  symbols: [
    { label: "BTC/USDT", value: "OKX:BTCUSDT" },
    { label: "ETH/USDT", value: "OKX:ETHUSDT" },
  ],
  defaultSymbol: "OKX:BTCUSDT",
  /** 占位；无 `prompt_strategies` 行时解析为空，不调用 Agent */
  promptStrategy: "",
  interval: "5",
  openaiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  openaiModel: "qwen3.5-plus",
  openaiApiKey: "",
  llmRequestTimeoutMs: 300_000,
  llmReasoningEnabled: false,
  /** 右侧面板「K 线收盘自动 Agent」总开关；关闭时不调用 LLM（仍推送收盘 payload）。 */
  barCloseAgentAutoEnabled: true,
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
  /** 仪表盘「初始资金」基准（USDT 权益）；null 表示未设定，可在界面一键写入当前权益。 */
  dashboardBaselineEquityUsdt: null,
  /** 仪表盘「Agent 工具统计」起点：仅统计 captured_at 不早于此 ISO 时间的回合；null 表示自始累计。 */
  dashboardAgentToolStatsSince: null,
  /** 仪表盘统计范围：按策略隔离保存，避免切换策略后混用同一段权益曲线。 */
  dashboardStrategyRanges: {},
});

const DEFAULT_OPENAI_BASE_URL = APP_SETTINGS_SEED.openaiBaseUrl;
const DEFAULT_OPENAI_MODEL = APP_SETTINGS_SEED.openaiModel;

/** 无存库正文时 system 占位：不设默认策略长文（Agent 须有用户自创策略才可运行）。 */
const EMPTY_SYSTEM_PROMPT_FALLBACK = "";

function normalizeSystemPromptField(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  const t = raw.trim();
  return t.length ? t : fallback;
}

/**
 * @returns {string[]}
 */
function listPromptStrategies() {
  promptStrategiesStore.seedFromDiskIfEmpty();
  return promptStrategiesStore.listStrategyIds();
}

/**
 * @param {string | undefined} preferred 首选策略 id
 * @returns {string}
 */
function resolvePromptStrategyId(preferred) {
  promptStrategiesStore.seedFromDiskIfEmpty();
  const available = promptStrategiesStore.listStrategyIds();
  if (!available.length) return "";
  const raw = typeof preferred === "string" && preferred.trim() ? preferred.trim() : "";
  if (raw && available.includes(raw)) return raw;
  if (available.includes(DEFAULT_PROMPT_STRATEGY)) return DEFAULT_PROMPT_STRATEGY;
  return available[0];
}

/**
 * 从本地库 `prompt_strategies` 读取当前策略的系统提示词（每次 `loadAppConfig` / 规范化时重新查询）。
 * @param {string} [strategyId]
 * @returns {{ systemPromptCrypto: string }}
 */
function loadSystemPromptsFromDisk(strategyId) {
  const id = resolvePromptStrategyId(strategyId);
  return {
    systemPromptCrypto: normalizeSystemPromptField(
      promptStrategiesStore.getStrategyBody(id),
      EMPTY_SYSTEM_PROMPT_FALLBACK,
    ),
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
 * 持久化时不写入完整系统提示词正文（正文在表 `prompt_strategies`），但保留 `promptStrategy` id。
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

/** @returns {string} 本地 SQLite 数据库路径（仓库根目录 argus.sqlite，与 src 同级） */
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

function normalizeDashboardStrategyRanges(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [strategyIdRaw, value] of Object.entries(raw)) {
    const strategyId = typeof strategyIdRaw === "string" ? strategyIdRaw.trim() : "";
    if (!strategyId || !value || typeof value !== "object" || Array.isArray(value)) continue;

    let baselineEquityUsdt = null;
    if ("baselineEquityUsdt" in value) {
      const v = value.baselineEquityUsdt;
      if (v !== null && v !== "") {
        const n = Number(v);
        baselineEquityUsdt = Number.isFinite(n) && n >= 0 ? n : null;
      }
    }

    let statsSince = null;
    if ("statsSince" in value) {
      const v = value.statsSince;
      if (typeof v === "string" && v.trim()) {
        const t = Date.parse(v.trim());
        statsSince = Number.isFinite(t) ? v.trim() : null;
      }
    }

    if (baselineEquityUsdt != null || statsSince != null) {
      out[strategyId] = { baselineEquityUsdt, statsSince };
    }
  }
  return out;
}

function normalizeConfig(raw) {
  const base = defaultConfigFallback();
  if (!raw || typeof raw !== "object") return base;
  let symbols = Array.isArray(raw.symbols) ? raw.symbols : base.symbols;
  symbols = symbols
    .filter((s) => s && typeof s.label === "string" && typeof s.value === "string")
    .map((s) => ({
      label: s.label.trim(),
      value: s.value.trim(),
    }))
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

  let barCloseAgentAutoEnabled = base.barCloseAgentAutoEnabled;
  if (raw.barCloseAgentAutoEnabled === false) barCloseAgentAutoEnabled = false;
  else if (raw.barCloseAgentAutoEnabled === true) barCloseAgentAutoEnabled = true;

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

  let dashboardBaselineEquityUsdt = base.dashboardBaselineEquityUsdt;
  if ("dashboardBaselineEquityUsdt" in raw) {
    const v = raw.dashboardBaselineEquityUsdt;
    if (v === null || v === "") dashboardBaselineEquityUsdt = null;
    else {
      const n = Number(v);
      dashboardBaselineEquityUsdt = Number.isFinite(n) && n >= 0 ? n : null;
    }
  }

  let dashboardAgentToolStatsSince = base.dashboardAgentToolStatsSince;
  if ("dashboardAgentToolStatsSince" in raw) {
    const v = raw.dashboardAgentToolStatsSince;
    if (v === null || v === "") dashboardAgentToolStatsSince = null;
    else if (typeof v === "string" && v.trim()) {
      const t = Date.parse(v.trim());
      dashboardAgentToolStatsSince = Number.isFinite(t) ? v.trim() : null;
    } else {
      dashboardAgentToolStatsSince = null;
    }
  }

  const hasExplicitDashboardStrategyRanges = "dashboardStrategyRanges" in raw;
  const dashboardStrategyRanges = normalizeDashboardStrategyRanges(raw.dashboardStrategyRanges);
  if (
    !hasExplicitDashboardStrategyRanges &&
    !(promptStrategy in dashboardStrategyRanges) &&
    (dashboardBaselineEquityUsdt != null || dashboardAgentToolStatsSince != null)
  ) {
    dashboardStrategyRanges[promptStrategy] = {
      baselineEquityUsdt: dashboardBaselineEquityUsdt,
      statsSince: dashboardAgentToolStatsSince,
    };
  }

  const activeDashboardRange =
    dashboardStrategyRanges[promptStrategy] && typeof dashboardStrategyRanges[promptStrategy] === "object"
      ? dashboardStrategyRanges[promptStrategy]
      : null;
  if (activeDashboardRange) {
    dashboardBaselineEquityUsdt = activeDashboardRange.baselineEquityUsdt ?? null;
    dashboardAgentToolStatsSince = activeDashboardRange.statsSince ?? null;
  } else {
    dashboardBaselineEquityUsdt = null;
    dashboardAgentToolStatsSince = null;
  }

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
    barCloseAgentAutoEnabled,
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
    dashboardBaselineEquityUsdt,
    dashboardAgentToolStatsSince,
    dashboardStrategyRanges,
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
  EMPTY_SYSTEM_PROMPT_FALLBACK,
};
