import { randomUUID } from "node:crypto";

import * as localDb from "./local-db/index.js";
import * as promptStrategiesStore from "./prompt-strategies-store.js";
import { listOkxStrategySymbolOptions } from "../shared/strategy-fields.js";
import { formatPromptStrategyDisplayLabel } from "../shared/prompt-strategy-display-label.js";

/**
 * 应用可序列化设置保存在仓库根目录 `argus.sqlite`（`local-db`）的 kv `app/settings` 中。
 * 首次启动或库中无记录时：用 {@link APP_SETTINGS_SEED} 经 `normalizeConfig` 后写入。
 *
 * 系统提示词正文存于 SQLite 表 `prompt_strategies`（界面「策略中心」管理）；`app/settings` 仅保存当前选用的 `promptStrategy` id。
 */
const DEFAULT_PROMPT_STRATEGY = promptStrategiesStore.DEFAULT_PROMPT_STRATEGY;

const ALLOWED_INTERVAL = new Set(["1", "3", "5", "15", "30", "60", "120", "240", "D", "1D"]);

/** 仪表盘「收盘自动 Agent」是否为当前策略运行中（与 UI 语义一致）：仅 `running` 时表示允许 Agent。 */
export type StrategyRuntimeStatus = "idle" | "running" | "paused" | "stopped";

export type StrategyRuntimeEntry = {
  status: StrategyRuntimeStatus;
  sessionId: string | null;
  startedAt: string | null;
  pausedAt: string | null;
  stoppedAt: string | null;
  lastDecisionAt: string | null;
  lastOrderAt: string | null;
  lastSkipReason: string | null;
};

/** `normalizeConfig` / `loadAppConfig` 的规范化形状（布尔与数字为宽类型，避免字面量收窄导致分支不可达）。 */
export type AppConfig = {
  symbols: { label: string; value: string }[];
  defaultSymbol: string;
  interval: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiApiKey: string;
  promptStrategy: string;
  promptStrategies: string[];
  /** 顶栏策略下拉：value=id，label=展示名（与 {@link promptStrategies} 顺序一致；不落库，由 DB 推导） */
  promptStrategySelectOptions: { value: string; label: string }[];
  systemPromptCrypto: string;
  llmRequestTimeoutMs: number;
  llmReasoningEnabled: boolean;
  barCloseAgentAutoEnabled: boolean;
  tradeNotifyEmailEnabled: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  notifyEmailTo: string;
  okxSwapTradingEnabled: boolean;
  okxSimulated: boolean;
  okxApiKey: string;
  okxSecretKey: string;
  okxPassphrase: string;
  dashboardBaselineEquityUsdt: number | null;
  dashboardAgentToolStatsSince: string | null;
  dashboardStrategyRanges: Record<string, { baselineEquityUsdt: number | null; statsSince: string | null }>;
  /** 按策略 id：`running` / `paused` / `stopped` / `idle` 控制收盘 Agent 授权；统计区间见 dashboardStrategyRanges。 */
  strategyRuntimeById: Record<string, StrategyRuntimeEntry>;
  /** 取自当前 `prompt_strategy` 行，非 kv 字段；normalizeConfig 时注入。 */
  promptStrategyDecisionIntervalTv: import("../shared/strategy-fields.js").StrategyDecisionIntervalTv;
};

type AppSettingsSeed = Omit<
  AppConfig,
  | "promptStrategies"
  | "promptStrategySelectOptions"
  | "systemPromptCrypto"
  | "promptStrategyDecisionIntervalTv"
>;

/**
 * 首次安装 /「恢复默认」时使用的持久化字段种子（仅存在于代码）。
 */
const APP_SETTINGS_SEED: AppSettingsSeed = Object.freeze({
  symbols: listOkxStrategySymbolOptions(),
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
  /** 策略执行态：按策略 id 持久化；与仪表盘统计会话独立。 */
  strategyRuntimeById: {},
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

function listPromptStrategySelectOptions(): { value: string; label: string }[] {
  promptStrategiesStore.seedFromDiskIfEmpty();
  const rows = promptStrategiesStore.listStrategiesMeta() as { id: string; label: string }[];
  return rows.map((row) => ({
    value: row.id,
    label: formatPromptStrategyDisplayLabel(row.id, row.label),
  }));
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
 */
function loadSystemPromptsFromDisk(strategyId?: string) {
  const id = resolvePromptStrategyId(strategyId);
  return {
    systemPromptCrypto: normalizeSystemPromptField(
      promptStrategiesStore.getStrategyBody(id),
      EMPTY_SYSTEM_PROMPT_FALLBACK,
    ),
  };
}

function defaultConfigFallback(): AppConfig {
  const promptStrategy = resolvePromptStrategyId(
    typeof APP_SETTINGS_SEED.promptStrategy === "string" ? APP_SETTINGS_SEED.promptStrategy : undefined,
  );
  return {
    ...APP_SETTINGS_SEED,
    promptStrategy,
    promptStrategies: listPromptStrategies(),
    promptStrategySelectOptions: listPromptStrategySelectOptions(),
    promptStrategyDecisionIntervalTv: promptStrategiesStore.getDecisionIntervalTvForStrategyId(promptStrategy),
    ...loadSystemPromptsFromDisk(promptStrategy),
  };
}

/**
 * 持久化时不写入完整系统提示词正文（正文在表 `prompt_strategies`），但保留 `promptStrategy` id。
 * @param {object} cfg `normalizeConfig` 返回值
 */
function stripSystemPromptsForPersistence(cfg) {
  if (!cfg || typeof cfg !== "object") return cfg;
  const {
    systemPromptCrypto: _c,
    promptStrategyDecisionIntervalTv: _p,
    promptStrategySelectOptions: _pso,
    symbols: _s,
    defaultSymbol: _d,
    ...rest
  } = cfg;
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

function normalizeDashboardStrategyRanges(raw: unknown): AppConfig["dashboardStrategyRanges"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: AppConfig["dashboardStrategyRanges"] = {};
  for (const [strategyIdRaw, value] of Object.entries(raw as Record<string, unknown>)) {
    const strategyId = typeof strategyIdRaw === "string" ? strategyIdRaw.trim() : "";
    if (!strategyId || !value || typeof value !== "object" || Array.isArray(value)) continue;

    let baselineEquityUsdt: number | null = null;
    if ("baselineEquityUsdt" in value) {
      const v = (value as { baselineEquityUsdt?: unknown }).baselineEquityUsdt;
      if (v !== null && v !== "") {
        const n = Number(v);
        baselineEquityUsdt = Number.isFinite(n) && n >= 0 ? n : null;
      }
    }

    let statsSince: string | null = null;
    if ("statsSince" in value) {
      const v = (value as { statsSince?: unknown }).statsSince;
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

const ALLOWED_RUNTIME_STATUS = new Set<StrategyRuntimeStatus>(["idle", "running", "paused", "stopped"]);

function normalizeIsoOrNull(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const t = raw.trim();
  return Number.isFinite(Date.parse(t)) ? t : null;
}

function normalizeNullableString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length ? t : null;
}

/**
 * @param {unknown} raw
 * @returns {AppConfig["strategyRuntimeById"]}
 */
function normalizeStrategyRuntimeById(raw: unknown): AppConfig["strategyRuntimeById"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: AppConfig["strategyRuntimeById"] = {};
  for (const [kRaw, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = typeof kRaw === "string" ? kRaw.trim() : "";
    if (!id || !v || typeof v !== "object" || Array.isArray(v)) continue;
    const row = v as Record<string, unknown>;
    let status: StrategyRuntimeStatus = "idle";
    if (typeof row.status === "string" && ALLOWED_RUNTIME_STATUS.has(row.status as StrategyRuntimeStatus)) {
      status = row.status as StrategyRuntimeStatus;
    }

    let sessionId: string | null = null;
    if (row.sessionId != null && row.sessionId !== "") {
      sessionId =
        typeof row.sessionId === "string" && row.sessionId.trim() ? row.sessionId.trim()
        : null;
    }

    const startedAt = normalizeIsoOrNull(row.startedAt);
    const pausedAt = normalizeIsoOrNull(row.pausedAt);
    const stoppedAt = normalizeIsoOrNull(row.stoppedAt);
    const lastDecisionAt = normalizeIsoOrNull(row.lastDecisionAt);
    const lastOrderAt = normalizeIsoOrNull(row.lastOrderAt);
    const lastSkipReason = normalizeNullableString(row.lastSkipReason);

    const next: StrategyRuntimeEntry = {
      status,
      sessionId,
      startedAt,
      pausedAt,
      stoppedAt,
      lastDecisionAt,
      lastOrderAt,
      lastSkipReason,
    };

    /** 不完整记录：若没有 session 且仍为 running/paused，降级为 idle，避免幽灵运行态 */
    const hasAnySignal =
      sessionId ||
      startedAt ||
      pausedAt ||
      stoppedAt ||
      lastDecisionAt ||
      lastOrderAt ||
      (lastSkipReason && lastSkipReason.length > 0);
    if (!hasAnySignal && (status === "running" || status === "paused" || status === "stopped")) {
      next.status = "idle";
    }

    /** 仅存 idle 且无其它字段的行可省略 */
    if (
      next.status === "idle" &&
      !next.sessionId &&
      !next.startedAt &&
      !next.pausedAt &&
      !next.stoppedAt &&
      !next.lastDecisionAt &&
      !next.lastOrderAt &&
      !next.lastSkipReason
    ) {
      continue;
    }

    out[id] = next;
  }
  return out;
}

/**
 * 当前选用策略是否在执行态允许收盘 Agent。
 * @param {Pick<AppConfig,"promptStrategy"|"strategyRuntimeById">} cfg
 */
function isPromptStrategyExecutionRunning(cfg: Pick<AppConfig, "promptStrategy" | "strategyRuntimeById">): boolean {
  const id = typeof cfg.promptStrategy === "string" ? cfg.promptStrategy.trim() : "";
  if (!id) return false;
  const row = cfg.strategyRuntimeById[id];
  return row?.status === "running";
}

/**
 * 仪表盘统计区间是否与 bar-close 旧版门闩一致（有基线且有统计起点）。
 * @param {import("./app-config.js").AppConfig["dashboardStrategyRanges"][string] | undefined} entry
 */
function isDashboardStatsSessionActive(entry: { baselineEquityUsdt: number | null; statsSince: string | null } | undefined): boolean {
  if (!entry || typeof entry !== "object") return false;
  const b = entry.baselineEquityUsdt;
  const baselineOk = b != null && Number.isFinite(Number(b));
  const since = typeof entry.statsSince === "string" ? entry.statsSince.trim() : "";
  return baselineOk && since.length > 0 && Number.isFinite(Date.parse(since));
}

function migrateStrategyRuntimeFromLegacyDashboard(
  promptStrategyId: string,
  ranges: AppConfig["dashboardStrategyRanges"],
): AppConfig["strategyRuntimeById"] {
  /** 旧逻辑：仪表盘「统计会话」曾作为 Agent 门闩；仅存库无 strategyRuntimeById 时，仅迁移当前选用策略 */
  const sid = typeof promptStrategyId === "string" ? promptStrategyId.trim() : "";
  const out: AppConfig["strategyRuntimeById"] = {};
  if (!sid) return out;
  const row = ranges[sid];
  if (!row || !isDashboardStatsSessionActive(row)) return out;
  const since =
    typeof row.statsSince === "string" && row.statsSince.trim()
      ? row.statsSince.trim()
      : "";
  out[sid] = {
    status: "running",
    sessionId: randomUUID(),
    startedAt: since,
    pausedAt: null,
    stoppedAt: null,
    lastDecisionAt: null,
    lastOrderAt: null,
    lastSkipReason: null,
  };
  return out;
}

function normalizeConfig(raw: unknown): AppConfig {
  const base = defaultConfigFallback();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  let symbols = listOkxStrategySymbolOptions();

  let interval = typeof r.interval === "string" ? r.interval.trim() : base.interval;
  if (!ALLOWED_INTERVAL.has(interval)) interval = base.interval;

  const openaiBaseUrl = normalizeOpenAiBaseUrl(
    typeof r.openaiBaseUrl === "string" ? r.openaiBaseUrl : base.openaiBaseUrl,
  );
  const openaiModel = normalizeOpenAiModel(
    typeof r.openaiModel === "string" ? r.openaiModel : base.openaiModel,
  );
  const openaiApiKey =
    typeof r.openaiApiKey === "string" ? r.openaiApiKey.trim() : base.openaiApiKey;

  const promptStrategy = resolvePromptStrategyId(
    typeof r.promptStrategy === "string" && r.promptStrategy.trim()
      ? r.promptStrategy.trim()
      : base.promptStrategy,
  );

  let defaultSymbol = promptStrategiesStore.getOkxTvSymbolForStrategyId(promptStrategy);
  if (!symbols.some((s) => s.value === defaultSymbol)) defaultSymbol = symbols[0]?.value ?? "OKX:BTCUSDT";

  const { systemPromptCrypto } = loadSystemPromptsFromDisk(promptStrategy);

  let llmRequestTimeoutMs = base.llmRequestTimeoutMs;
  const tt = Number(r.llmRequestTimeoutMs);
  if (Number.isFinite(tt) && tt > 0) llmRequestTimeoutMs = Math.floor(tt);

  let llmReasoningEnabled = base.llmReasoningEnabled;
  if (r.llmReasoningEnabled === true) llmReasoningEnabled = true;
  else if (r.llmReasoningEnabled === false) llmReasoningEnabled = false;

  let barCloseAgentAutoEnabled = base.barCloseAgentAutoEnabled;
  if (r.barCloseAgentAutoEnabled === false) barCloseAgentAutoEnabled = false;
  else if (r.barCloseAgentAutoEnabled === true) barCloseAgentAutoEnabled = true;

  let tradeNotifyEmailEnabled = base.tradeNotifyEmailEnabled;
  if (r.tradeNotifyEmailEnabled === true) tradeNotifyEmailEnabled = true;
  else if (r.tradeNotifyEmailEnabled === false) tradeNotifyEmailEnabled = false;

  const smtpHost =
    typeof r.smtpHost === "string" && r.smtpHost.trim() ? r.smtpHost.trim() : base.smtpHost;
  let smtpPort = base.smtpPort;
  const sp = Number(r.smtpPort);
  if (Number.isFinite(sp) && sp > 0) smtpPort = Math.floor(sp);
  let smtpSecure = base.smtpSecure;
  if (r.smtpSecure === true) smtpSecure = true;
  else if (r.smtpSecure === false) smtpSecure = false;

  const smtpUser = typeof r.smtpUser === "string" ? r.smtpUser.trim() : base.smtpUser;
  const smtpPass = typeof r.smtpPass === "string" ? r.smtpPass.trim() : base.smtpPass;
  const notifyEmailTo =
    typeof r.notifyEmailTo === "string" ? r.notifyEmailTo.trim() : base.notifyEmailTo;

  let okxSwapTradingEnabled = base.okxSwapTradingEnabled;
  if (r.okxSwapTradingEnabled === true) okxSwapTradingEnabled = true;
  else if (r.okxSwapTradingEnabled === false) okxSwapTradingEnabled = false;

  let okxSimulated = base.okxSimulated;
  if (r.okxSimulated === true) okxSimulated = true;
  else if (r.okxSimulated === false) okxSimulated = false;

  const okxApiKey = typeof r.okxApiKey === "string" ? r.okxApiKey.trim() : base.okxApiKey;
  const okxSecretKey =
    typeof r.okxSecretKey === "string" ? r.okxSecretKey.trim() : base.okxSecretKey;
  const okxPassphrase =
    typeof r.okxPassphrase === "string" ? r.okxPassphrase.trim() : base.okxPassphrase;

  let dashboardBaselineEquityUsdt = base.dashboardBaselineEquityUsdt;
  if ("dashboardBaselineEquityUsdt" in r) {
    const v = r.dashboardBaselineEquityUsdt;
    if (v === null || v === "") dashboardBaselineEquityUsdt = null;
    else {
      const n = Number(v);
      dashboardBaselineEquityUsdt = Number.isFinite(n) && n >= 0 ? n : null;
    }
  }

  let dashboardAgentToolStatsSince = base.dashboardAgentToolStatsSince;
  if ("dashboardAgentToolStatsSince" in r) {
    const v = r.dashboardAgentToolStatsSince;
    if (v === null || v === "") dashboardAgentToolStatsSince = null;
    else if (typeof v === "string" && v.trim()) {
      const t = Date.parse(v.trim());
      dashboardAgentToolStatsSince = Number.isFinite(t) ? v.trim() : null;
    } else {
      dashboardAgentToolStatsSince = null;
    }
  }

  const hasExplicitDashboardStrategyRanges = "dashboardStrategyRanges" in r;
  const dashboardStrategyRanges = normalizeDashboardStrategyRanges(r.dashboardStrategyRanges);
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

  const hasExplicitStrategyRuntimeById = "strategyRuntimeById" in r;
  const strategyRuntimeById = hasExplicitStrategyRuntimeById
    ? normalizeStrategyRuntimeById(r.strategyRuntimeById)
    : migrateStrategyRuntimeFromLegacyDashboard(promptStrategy, dashboardStrategyRanges);

  const promptStrategyDecisionIntervalTv =
    promptStrategiesStore.getDecisionIntervalTvForStrategyId(promptStrategy);

  return {
    symbols,
    defaultSymbol,
    interval,
    openaiBaseUrl,
    openaiModel,
    openaiApiKey,
    promptStrategy,
    promptStrategies: listPromptStrategies(),
    promptStrategySelectOptions: listPromptStrategySelectOptions(),
    promptStrategyDecisionIntervalTv,
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
    strategyRuntimeById,
  };
}

function loadAppConfig() {
  ensurePersistedConfig();
  const rawStr = localDb.kvGet(localDb.KV_NS_APP, localDb.KV_KEY_SETTINGS);
  if (typeof rawStr !== "string" || !rawStr.trim()) {
    const repaired = normalizeConfig(defaultConfigFallback());
    persistLoadedConfig(repaired);
    return repaired;
  }
  try {
    const raw: unknown = JSON.parse(rawStr);
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
function saveMergedConfigPayload(payload: Record<string, unknown>) {
  const current = loadAppConfig();
  const merged = { ...current, ...payload };
  const next = normalizeConfig(merged);
  persistLoadedConfig(next);
  return next;
}

export {
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
  isDashboardStatsSessionActive,
  isPromptStrategyExecutionRunning,
};
