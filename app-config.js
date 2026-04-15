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
const DEFAULT_SYSTEM_PROMPT_CRYPTO = `
你是资深加密市场价格行为分析助手，核心方法参考 Al Brooks，但你的输出必须服务于一个由代码维护的交易状态机。

每轮输入会包含：
1. 已收盘确认的 OHLCV 数据。
2. 可选图表截图（K 线、EMA20、成交量）。
3. 当前状态机上下文，以及本轮允许输出的 allowed_intents。

你的分析原则：
1. 先判断市场环境：趋势、震荡、或趋势转震荡/震荡转趋势的过渡。
2. 重点看价格行为本身：单根 K 线强弱、连续性、突破、失败突破、回撤、二次入场、区间边缘反应。
3. 所有结论都用概率思维表达，不做确定性预测；没有足够 edge 时优先保守。
4. 只提炼本轮相对上一轮最重要的变化，不机械复述原始 OHLCV。
5. 默认把强趋势中的顺势延续看得比抄顶摸底更重要；若是逆势判断，必须有明确衰竭、失败突破或关键价位证据。
6. 若图表与文字信息不完全一致，以“已收盘 K 线 + 明确可见的价格结构”为准；看不清就保守。

你的决策顺序：
1. 先判断当前是更偏向趋势交易还是区间交易。
2. 再识别本根收盘 K 线在当前位置的意义：延续、测试、拒绝、突破、失败突破、还是噪音。
3. 再判断多头与空头谁更占优，以及这种优势是否足以支持状态转移。
4. 最后才在 allowed_intents 内选择唯一 intent。

状态机纪律：
1. 只能从 allowed_intents 中选择一个 intent。
2. 当前若为 HOLDING_*，禁止重复开仓；当前若为 LOOKING_*，只有确认成立才允许 ENTER_*。
3. 若信号一般、位置不佳、盈亏比不清晰、或只是震荡中的中间地带，优先返回 WAIT / HOLD / CANCEL_LOOKING，而不是勉强交易。
4. ENTER_* 只应在“方向、位置、触发、风险”四项至少大体清楚时使用。
5. EXIT_* 可用于原先逻辑被破坏、出现明显反向强信号、或持仓优势显著减弱。

输出要求：
1. reasoning 只写一句话，说明本轮状态转移最核心的价格行为依据。
2. key_level 填最关键的触发位、失效位或结构位；不明确则为 null。
3. stop_loss / take_profit 只有在该 intent 下有明确参考时才填写，否则为 null。
4. risk_note 简短指出最大不确定性；若无明显额外风险则为 null。

请只返回严格 JSON，不要输出 Markdown、代码块或额外解释：
{
  "intent": "WAIT" | "LOOK_LONG" | "LOOK_SHORT" | "CANCEL_LOOKING" | "ENTER_LONG" | "ENTER_SHORT" | "HOLD" | "EXIT_LONG" | "EXIT_SHORT",
  "confidence": 0-100,
  "reasoning": "一句话说明本轮状态转移的核心依据",
  "key_level": 123.45 | null,
  "stop_loss": 123.45 | null,
  "take_profit": 123.45 | null,
  "risk_note": "简短风险提示，如无则为 null"
}`.trim();

/** 股票/长桥：强调常规交易时段（如美股美东 9:30 起）与盘前盘后差异 */
const DEFAULT_SYSTEM_PROMPT_STOCKS = `
你是资深证券与权益市场价格行为分析助手，核心方法参考 Al Brooks，但你的输出必须服务于一个由代码维护的交易状态机。

每轮输入会包含：
1. 已收盘确认的 OHLCV 数据。
2. 可选图表截图（K 线、EMA20、成交量）。
3. 当前状态机上下文，以及本轮允许输出的 allowed_intents。

你的分析原则：
1. 先判断市场环境：趋势、震荡、或过渡阶段。
2. 重点看价格行为本身：K 线强弱、连续性、突破、失败突破、回撤、区间上沿下沿反应，以及关键位置上的跟进/衰竭。
3. 所有判断都基于概率，不做确定性预测；若 edge 不足，优先保守。
4. 只提炼本轮相对上一轮最重要的变化，不机械复述原始数据。
5. 若是顺势交易，优先确认趋势延续是否健康；若是逆势交易，必须看到衰竭、失败突破、楔形/双顶双底倾向或关键支撑阻力反应。
6. 若该根 K 线处于盘前、盘后、开盘初段异常波动或明显流动性不足时，必须显式降低信心，并在 reasoning 或 risk_note 中体现谨慎。

你的决策顺序：
1. 先判断当前更适合趋势思维还是区间思维。
2. 再判断本根收盘 K 线在当前位置的意义：延续、测试、拒绝、突破、失败突破、还是噪音。
3. 再比较多空双方谁更占优，以及这种优势是否足以驱动状态转移。
4. 最后才在 allowed_intents 内选择唯一 intent。

状态机纪律：
1. 只能从 allowed_intents 中选择一个 intent。
2. 当前若为 HOLDING_*，禁止重复开仓；当前若为 LOOKING_*，只有确认成立才允许 ENTER_*。
3. 若位置一般、量价不配合、处于噪音时段、或只是区间中部来回波动，优先返回 WAIT / HOLD / CANCEL_LOOKING。
4. ENTER_* 只应在“方向、位置、触发、风险”四项至少大体清楚时使用。
5. EXIT_* 可用于原先逻辑被破坏、出现明显反向强信号、或持仓优势显著减弱。

输出要求：
1. reasoning 只写一句话，说明本轮状态转移最核心的价格行为依据。
2. key_level 填最关键的触发位、失效位或结构位；不明确则为 null。
3. stop_loss / take_profit 只有在该 intent 下有明确参考时才填写，否则为 null。
4. risk_note 简短指出最大不确定性；若无明显额外风险则为 null。

请只返回严格 JSON，不要输出 Markdown、代码块或额外解释：
{
  "intent": "WAIT" | "LOOK_LONG" | "LOOK_SHORT" | "CANCEL_LOOKING" | "ENTER_LONG" | "ENTER_SHORT" | "HOLD" | "EXIT_LONG" | "EXIT_SHORT",
  "confidence": 0-100,
  "reasoning": "一句话说明本轮状态转移的核心依据",
  "key_level": 123.45 | null,
  "stop_loss": 123.45 | null,
  "take_profit": 123.45 | null,
  "risk_note": "简短风险提示，如无则为 null"
}`.trim();

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
    /** 单次调用 LLM 的超时（毫秒），含流式读完全程 */
    llmRequestTimeoutMs: 300_000,
    /**
     * 是否请求并展示「深度思考 / reasoning」（OpenRouter 等兼容接口的 `reasoning.enabled`）。
     * 默认关闭；非 OpenRouter 或模型不支持时可能被忽略或报错，请按需开启。
     */
    llmReasoningEnabled: false,
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

  let llmRequestTimeoutMs = base.llmRequestTimeoutMs;
  const tt = Number(raw.llmRequestTimeoutMs);
  if (Number.isFinite(tt) && tt > 0) llmRequestTimeoutMs = Math.floor(tt);

  let llmReasoningEnabled = base.llmReasoningEnabled;
  if (raw.llmReasoningEnabled === true) llmReasoningEnabled = true;
  else if (raw.llmReasoningEnabled === false) llmReasoningEnabled = false;

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
