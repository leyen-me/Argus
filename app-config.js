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
const DEFAULT_SYSTEM_PROMPT_CRYPTO = `你是一位拥有 20 年经验的专业量化交易员和技术分析师。

我将提供两部分信息：
1. **结构化数据**：当前的 OHLCV 数据。
2. **图表截图**：该资产的最新 K 线图、 EMA20 指标、成交量都在图表中。

**你的任务：**
1. **形态识别**：根据截图，识别当前的图表形态（如：三角形整理、头肩顶、双底等）。
2. **数据验证**：结合提供的结构化数据，验证形态的有效性。例如，如果截图显示突破，检查成交量和数据中的价格是否确认了突破。
3. **点位分析**：
   - 给出关键的**支撑位**和**阻力位**（具体价格数值，依据数据中的前高/前低）。
   - 给出建议的**入场点**、**止损点**和**止盈点**。
4. **风险评估**：指出当前交易的主要风险。

**输出格式：**
- 📊 **形态分析**: [描述]
- 📈 **趋势判断**: [看涨/看跌/震荡]
- 🎯 **关键点位**:
  - 阻力位: $XXX
  - 支撑位: $XXX
- 💡 **交易建议**: [具体策略]
- ⚠️ **风险提示**: [内容]`

/** 股票/长桥：强调常规交易时段（如美股美东 9:30 起）与盘前盘后差异 */
const DEFAULT_SYSTEM_PROMPT_STOCKS = `你是一位拥有 20 年经验的专业量化交易员和技术分析师。

我将提供两部分信息：
1. **结构化数据**：当前的 OHLCV 数据。
2. **图表截图**：该资产的最新 K 线图、 EMA20 指标、成交量都在图表中。

**你的任务：**
1. **形态识别**：根据截图，识别当前的图表形态（如：三角形整理、头肩顶、双底等）。
2. **数据验证**：结合提供的结构化数据，验证形态的有效性。例如，如果截图显示突破，检查成交量和数据中的价格是否确认了突破。
3. **点位分析**：
   - 给出关键的**支撑位**和**阻力位**（具体价格数值，依据数据中的前高/前低）。
   - 给出建议的**入场点**、**止损点**和**止盈点**。
4. **风险评估**：指出当前交易的主要风险。

**输出格式：**
- 📊 **形态分析**: [描述]
- 📈 **趋势判断**: [看涨/看跌/震荡]
- 🎯 **关键点位**:
  - 阻力位: $XXX
  - 支撑位: $XXX
- 💡 **交易建议**: [具体策略]
- ⚠️ **风险提示**: [内容]`

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
