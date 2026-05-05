/* global TradingView */
import { CountUp } from "countup.js";
import { canonTradingViewInterval, sortMultiTimeframeSpecsSmallestFirst } from "@shared/strategy-fields";
import type { StrategyChartIndicatorId } from "@shared/strategy-fields";
import { tradingViewStudiesFromChartIndicators } from "@shared/tradingview-chart-studies";
import { formatPromptStrategyDisplayLabel } from "@shared/prompt-strategy-display-label";

const DEFAULT_STRATEGY_CHART_INDICATORS: StrategyChartIndicatorId[] = ["EM20"];
const MULTI_TIMEFRAME_SPECS = [
  {
    interval: "1D",
    label: "1D",
    caption: "日线",
    containerId: "tradingview_chart_1d",
  },
  {
    interval: "60",
    label: "1H",
    caption: "1 小时",
    containerId: "tradingview_chart_1h",
  },
  {
    interval: "15",
    label: "15m",
    caption: "15 分钟",
    containerId: "tradingview_chart_15m",
  },
  {
    interval: "5",
    label: "5m",
    caption: "5 分钟",
    containerId: "tradingview_chart_5m",
  },
];
let tvWidgets = new Map();
let tvWidgetRenderTimer = 0;
let tvWidgetRenderFrameA = 0;
let tvWidgetRenderFrameB = 0;
let tvWidgetRenderSeq = 0;
let tvLayoutObserver = null;
let lastTvWidgetRequest = {
  symbol: "OKX:BTCUSDT",
  interval: "5",
  chartIndicators: [...DEFAULT_STRATEGY_CHART_INDICATORS],
};

function normalizeTradingViewSymbolForPerp(symbol) {
  const raw = String(symbol || "").trim();
  if (!raw.startsWith("OKX:")) return raw;
  const body = raw.slice("OKX:".length).trim().toUpperCase();
  if (!body) return raw;
  if (body.endsWith(".P")) return `OKX:${body}`;
  return `OKX:${body}.P`;
}

function cancelPendingTradingViewRender() {
  if (tvWidgetRenderTimer) {
    window.clearTimeout(tvWidgetRenderTimer);
    tvWidgetRenderTimer = 0;
  }
  if (tvWidgetRenderFrameA) {
    window.cancelAnimationFrame(tvWidgetRenderFrameA);
    tvWidgetRenderFrameA = 0;
  }
  if (tvWidgetRenderFrameB) {
    window.cancelAnimationFrame(tvWidgetRenderFrameB);
    tvWidgetRenderFrameB = 0;
  }
}

function areTradingViewContainersReady() {
  return MULTI_TIMEFRAME_SPECS.every((spec) => {
    const el = document.getElementById(spec.containerId);
    return el instanceof HTMLElement && el.clientWidth > 0 && el.clientHeight > 0;
  });
}

function scheduleTradingViewWidget(
  symbol,
  interval,
  options: {
    debounceMs?: number;
    attempt?: number;
    chartIndicators?: import("@shared/strategy-fields").StrategyChartIndicatorId[];
  } = {},
) {
  const { debounceMs = 0, attempt = 0, chartIndicators } = options;
  const nextSymbol = symbol || "OKX:BTCUSDT";
  const nextInterval = String(interval || chartInterval || "5");
  const nextChartIndicators =
    chartIndicators !== undefined ? chartIndicators : lastTvWidgetRequest.chartIndicators;
  lastTvWidgetRequest = {
    symbol: nextSymbol,
    interval: nextInterval,
    chartIndicators: nextChartIndicators,
  };
  const seq = ++tvWidgetRenderSeq;
  cancelPendingTradingViewRender();

  const render = () => {
    tvWidgetRenderFrameA = window.requestAnimationFrame(() => {
      tvWidgetRenderFrameB = window.requestAnimationFrame(() => {
        tvWidgetRenderFrameA = 0;
        tvWidgetRenderFrameB = 0;
        if (seq !== tvWidgetRenderSeq) return;
        if (!areTradingViewContainersReady()) {
          if (attempt < 8) {
            scheduleTradingViewWidget(nextSymbol, nextInterval, {
              attempt: attempt + 1,
              debounceMs: 80,
            });
          }
          return;
        }
        createTradingViewWidgetNow(nextSymbol, nextInterval);
      });
    });
  };

  if (debounceMs > 0) {
    tvWidgetRenderTimer = window.setTimeout(() => {
      tvWidgetRenderTimer = 0;
      render();
    }, debounceMs);
    return;
  }

  render();
}

function initTradingViewAutoLayout() {
  if (tvLayoutObserver || typeof ResizeObserver === "undefined") return;
  const grid = document.querySelector(".chart-grid");
  if (!(grid instanceof HTMLElement)) return;

  let lastWidth = 0;
  let lastHeight = 0;

  tvLayoutObserver = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) return;
    const width = Math.round(entry.contentRect.width);
    const height = Math.round(entry.contentRect.height);
    if (width <= 0 || height <= 0) return;
    const hadStableSize = lastWidth > 0 && lastHeight > 0;
    if (width === lastWidth && height === lastHeight) return;
    lastWidth = width;
    lastHeight = height;
    if (!hadStableSize) return;
    if (tvWidgets.size === 0) return;
    scheduleTradingViewWidget(lastTvWidgetRequest.symbol, lastTvWidgetRequest.interval, { debounceMs: 160 });
  });

  tvLayoutObserver.observe(grid);
}

/**
 * 最近一次行情截图（供多模态 LLM 使用）。
 * `base64` 为不含 `data:*;base64,` 前缀的裸字符串，可直接作为 image_url / inline_data 等字段内容。
 * `dataUrl` 为完整 Data URL，与 `<img src>` 一致。
 */
function setLastChartScreenshot(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const base64 = comma === -1 ? "" : dataUrl.slice(comma + 1);
  window.argusLastChartImage = {
    mimeType: "image/png",
    dataUrl,
    base64,
  };
}

/**
 * K 线收盘后主进程推送的完整上下文：`textForLlm` + `chartImage.base64`，供后续 Chat 一并提交。
 * @type {object | null}
 */
window.argusLastBarClose = null;

async function captureTradingViewPng(interval = "5") {
  const widget = tvWidgets.get(String(interval));
  if (!widget || typeof widget.ready !== "function") {
    throw new Error(`无图表：${interval}`);
  }
  if (typeof widget.imageCanvas !== "function") {
    throw new Error(`图表不支持截图：${interval}`);
  }
  const canvasUnknown = await new Promise((resolve, reject) => {
    widget.ready(() => {
      widget.imageCanvas().then(resolve).catch(reject);
    });
  });
  const canvas = canvasUnknown as HTMLCanvasElement;
  const dataUrl = canvas.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  const base64 = comma === -1 ? "" : dataUrl.slice(comma + 1);
  return { mimeType: "image/png", dataUrl, base64 };
}

function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图像解码失败"));
    img.src = dataUrl;
  });
}

/**
 * @param {string[] | undefined} selectedIntervals TradingView interval，如 `5`/`1D`；空或未传截取全部
 */
function resolveMultiTimeframeSpecsForCapture(selectedIntervals: string[] | undefined) {
  const all = MULTI_TIMEFRAME_SPECS;
  if (!Array.isArray(selectedIntervals) || selectedIntervals.length === 0) {
    return sortMultiTimeframeSpecsSmallestFirst(all);
  }
  const want = new Set(selectedIntervals.map((iv) => canonTradingViewInterval(iv)));
  const filtered = all.filter((s) => want.has(canonTradingViewInterval(s.interval)));
  const specs = filtered.length ? filtered : all;
  return sortMultiTimeframeSpecsSmallestFirst(specs);
}

/**
 * @param {string[] | undefined} selectedIntervals 策略勾选的多周期；未传则截四宫格全部
 */
async function captureMultiTimeframeCharts(selectedIntervals?: string[]) {
  const specs = resolveMultiTimeframeSpecsForCapture(selectedIntervals);
  if (!specs.length) throw new Error("无可截取的多周期图表");

  const charts = await Promise.all(
    specs.map(async (spec) => {
      const shot = await captureTradingViewPng(spec.interval);
      return {
        interval: spec.interval,
        label: spec.label,
        caption: spec.caption,
        mimeType: shot.mimeType,
        base64: shot.base64,
        dataUrl: shot.dataUrl,
      };
    }),
  );
  const images = await Promise.all(charts.map((chart) => loadImageElement(chart.dataUrl)));
  const n = charts.length;
  const cols = n <= 2 ? n : 2;
  const rows = Math.ceil(n / cols);
  const cellWidth = Math.max(...images.map((img) => img.width));
  const cellHeight = Math.max(...images.map((img) => img.height));
  const gap = 12;
  const pad = 16;
  const titleHeight = 42;
  const canvas = document.createElement("canvas");
  canvas.width = pad * 2 + cellWidth * cols + gap * Math.max(0, cols - 1);
  canvas.height = pad * 2 + cellHeight * rows + gap * Math.max(0, rows - 1);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建截图画布");
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  charts.forEach((chart, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const x = pad + col * (cellWidth + gap);
    const y = pad + row * (cellHeight + gap);
    ctx.fillStyle = "#111827";
    ctx.fillRect(x, y, cellWidth, cellHeight);
    ctx.drawImage(images[index], x, y, cellWidth, cellHeight);
    ctx.fillStyle = "rgba(13, 17, 23, 0.78)";
    ctx.fillRect(x + 10, y + 10, 102, titleHeight);
    ctx.strokeStyle = "rgba(148, 163, 184, 0.22)";
    ctx.strokeRect(x + 10, y + 10, 102, titleHeight);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 18px system-ui";
    ctx.fillText(chart.label, x + 22, y + 28);
    ctx.fillStyle = "#94a3b8";
    ctx.font = "12px system-ui";
    ctx.fillText(chart.caption, x + 22, y + 45);
  });
  const dataUrl = canvas.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  const base64 = comma === -1 ? "" : dataUrl.slice(comma + 1);
  return {
    mimeType: "image/png",
    dataUrl,
    base64,
    charts,
  };
}

/**
 * 与 app-config 中 `MIN_FALLBACK_*` 一致：仅当非 Electron 打开页面时用于界面预览兜底。
 * 正式内容由本地库表 `prompt_strategies` 提供；策略在「策略中心」维护，并在顶部快捷栏切换。
 */
const FALLBACK_SYSTEM_PROMPT_CRYPTO =
  "你是资深加密市场价格行为分析助手。每轮会收到已收盘 K 线、可选图表截图，以及 OKX 永续持仓与挂单快照（若已配置 API）。" +
  "需要交易时使用工具：open_position、close_position、cancel_order、amend_order、amend_tp_sl；不要只写评论不下单。" +
  "分析参考 Al Brooks 式价格行为，结论基于概率；信号不清时少调用工具。";

/** 与主进程 `APP_SETTINGS_SEED` + 兜底系统提示词语义一致，供非 Electron 打开页面时兜底 */
const FALLBACK_APP_CONFIG = {
  symbols: [
    { label: "BTC/USDT", value: "OKX:BTCUSDT" },
    { label: "ETH/USDT", value: "OKX:ETHUSDT" },
    { label: "SOL/USDT", value: "OKX:SOLUSDT" },
    { label: "DOGE/USDT", value: "OKX:DOGEUSDT" },
  ],
  defaultSymbol: "OKX:BTCUSDT",
  promptStrategy: "",
  promptStrategies: [],
  promptStrategySelectOptions: [],
  interval: "5",
  openaiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  openaiModel: "qwen3.5-plus",
  openaiApiKey: "",
  systemPromptCrypto: FALLBACK_SYSTEM_PROMPT_CRYPTO,
  llmRequestTimeoutMs: 300000,
  llmReasoningEnabled: false,
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
  dashboardBaselineEquityUsdt: null,
  dashboardAgentToolStatsSince: null,
  dashboardStrategyRanges: {},
  strategyRuntimeById: {},
  promptStrategyDecisionIntervalTv: "5",
  promptStrategyChartIndicators: [...DEFAULT_STRATEGY_CHART_INDICATORS],
};

type RendererAppConfig = typeof FALLBACK_APP_CONFIG;

function asRendererAppConfig(raw: unknown): RendererAppConfig {
  return raw as RendererAppConfig;
}

function asOkxSwapPositionSnapshot(raw: unknown): OkxSwapPositionSnapshot {
  return raw as OkxSwapPositionSnapshot;
}

/** `chart-interval-select` 的 option value（可能与 canonical `1D`/`D` 对齐）；会话 key 用 chartIntervalCanonical。 */
let chartInterval = "5";
/** 与主进程 OKX WS / bar-close `conversationKey` 对齐（如 `1D`）。 */
let chartIntervalCanonical = "5";

/** 按 `品种|周期` 缓存最近一次 OKX 快照（收盘推送），切换品种时可恢复展示 */
window.argusExchangeContextCache = window.argusExchangeContextCache || Object.create(null);

/**
 * 与主进程 llm-context.conversationKey 一致
 * @param {string} tvSymbol
 * @param {string} interval
 */
function conversationKeyForUi(tvSymbol, interval) {
  const sym = String(tvSymbol || "").trim();
  const rawIv = interval ?? chartIntervalCanonical ?? chartInterval ?? "5";
  const ivCanon = canonTradingViewInterval(rawIv) || "5";
  return sym ? `${sym}|${ivCanon}` : "";
}

/** 当前界面选中的品种 + 策略决策周期 canonical，与主进程 `conversationKey(tvSymbol, interval)` 对齐 */
function currentConversationKeyForUi() {
  const sel = document.getElementById("symbol-select");
  const sym = sel?.value?.trim() || "";
  return conversationKeyForUi(sym, chartIntervalCanonical);
}

/**
 * @param {string} key
 * @param {object | null | undefined} ctx
 */
function rememberExchangeContext(key, ctx) {
  if (!key || !ctx || typeof ctx !== "object") return;
  window.argusExchangeContextCache[key] = ctx;
}

/**
 * @param {object} p
 */
function formatOnePlainPendingBrief(p) {
  return `${p.ordType || "?"} ${p.side || ""} @${p.px ?? "?"}`;
}

/**
 * @param {object} o
 */
function formatOneAlgoPendingBrief(o) {
  const type = o.ordType || "?";
  const side = o.side || "";
  const parts = [];
  if (o.tpTriggerPx != null && String(o.tpTriggerPx).trim() !== "") {
    parts.push(`止盈${o.tpTriggerPx}`);
  }
  if (o.slTriggerPx != null && String(o.slTriggerPx).trim() !== "") {
    parts.push(`止损${o.slTriggerPx}`);
  }
  if (
    !parts.length &&
    o.triggerPx != null &&
    String(o.triggerPx).trim() !== ""
  ) {
    parts.push(`触发${o.triggerPx}`);
  }
  const tpsl = parts.join("/");
  return tpsl ? `${type} ${side} ${tpsl}` : `${type} ${side}`;
}

/**
 * @param {unknown} plain
 * @param {unknown} algo
 */
function formatPendingOrdersSummaryLine(plain, algo) {
  const pend = Array.isArray(plain) ? plain : [];
  const alg = Array.isArray(algo) ? algo : [];
  const pendBit =
    pend.length === 0
      ? "挂单 0"
      : `挂单 ${pend.length}：${pend
          .slice(0, 4)
          .map(formatOnePlainPendingBrief)
          .join("；")}${pend.length > 4 ? "…" : ""}`;
  const algoBit =
    alg.length === 0
      ? "算法 0"
      : `算法 ${alg.length}：${alg
          .slice(0, 4)
          .map(formatOneAlgoPendingBrief)
          .join("；")}${alg.length > 4 ? "…" : ""}`;
  return `${pendBit} ｜ ${algoBit}`;
}

/**
 * @param {object | null | undefined} ctx 主进程 getOkxExchangeContextForBar
 */
function formatExchangeContextLine(ctx) {
  if (!ctx || typeof ctx !== "object") return "—";
  if (!ctx.enabled) {
    if (ctx.reason === "okx_swap_disabled") {
      return "未启用 OKX 永续；在配置中开启并填写 API 后可显示持仓与挂单。";
    }
    if (ctx.reason === "not_crypto_chart") return "当前品种非 OKX 加密图表。";
    return "无 OKX 快照。";
  }
  if (!ctx.ok) return `快照失败：${ctx.message || "未知错误"}`;
  const posLine = formatOkxPositionLine({
    ok: true,
    skipped: false,
    simulated: ctx.simulated,
    instId: ctx.instId,
    hasPosition: ctx.position?.hasPosition,
    posNum: ctx.position?.posNum,
    absContracts: ctx.position?.absContracts,
    posSide: ctx.position?.posSide,
    fields: ctx.position?.fields,
  });
  const ordersLine = formatPendingOrdersSummaryLine(ctx.pending_orders, ctx.pending_algo_orders);
  return `${posLine} ｜ ${ordersLine}`;
}

function updateOkxBarFromExchangeContext(ctx) {
  const bar = document.getElementById("okx-position-bar");
  const sel = document.getElementById("symbol-select");
  if (!bar) return;
  const sym = sel?.value?.trim() || "";
  if (!sym.startsWith("OKX:")) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  renderOkxPositionSnapshot(
    {
      ok: ctx?.ok,
      skipped: ctx?.enabled === false,
      reason: ctx?.reason,
      message: ctx?.message,
      simulated: ctx?.simulated,
      instId: ctx?.instId,
      hasPosition: ctx?.position?.hasPosition,
      posNum: ctx?.position?.posNum,
      absContracts: ctx?.position?.absContracts,
      posSide: ctx?.position?.posSide,
      fields: ctx?.position?.fields,
      pending_orders: ctx?.pending_orders,
      pending_algo_orders: ctx?.pending_algo_orders,
    },
    {
      sourceText: "收盘快照",
      footnote: formatExchangeContextLine(ctx),
      titlePayload: ctx,
    },
  );
}

function refreshExchangeContextBarFromCache() {
  const key = currentConversationKeyForUi();
  const cached = key ? window.argusExchangeContextCache[key] : null;
  if (cached) {
    updateOkxBarFromExchangeContext(cached);
  } else {
    void refreshOkxPositionBar();
  }
}

/** 当前最近一次收盘推送 id，用于忽略过期的流式片段 */
let latestBarCloseId = null;

/** 从库分页拉取时每页条数 */
const LLM_HISTORY_PAGE_SIZE = 20;

/** 实时收盘插入后，DOM 中最多保留的轮数（最旧靠近列表底部会被删掉） */
const LLM_HISTORY_MAX_DOM_ROUNDS = 80;

/** @type {{ capturedAt: string, barCloseId: string } | null} */
let llmHistoryCursor = null;
let llmHistoryExhausted = false;
let llmHistoryLoading = false;
/** @type {IntersectionObserver | null} */
let llmHistoryScrollObserver = null;

/**
 * @returns {HTMLElement | null}
 */
function getLlmScrollViewport() {
  const history = document.getElementById("llm-chat-history");
  if (!history) return null;
  const root = history.closest('[data-slot="scroll-area"]');
  const vp = root?.querySelector('[data-slot="scroll-area-viewport"]');
  return vp instanceof HTMLElement ? vp : null;
}

function scrollLlmHistoryToTop() {
  const vp = getLlmScrollViewport();
  if (vp) vp.scrollTop = 0;
}

function updateLlmHistorySentinelText(text) {
  const s = document.getElementById("llm-history-load-more");
  if (s) s.textContent = text;
}

function observeLlmHistorySentinel() {
  const sent = document.getElementById("llm-history-load-more");
  const root = getLlmScrollViewport();
  if (!sent || !root) return;
  if (llmHistoryScrollObserver) {
    llmHistoryScrollObserver.disconnect();
  }
  llmHistoryScrollObserver = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      void loadNextLlmHistoryPage();
    },
    { root, rootMargin: "64px", threshold: 0 },
  );
  llmHistoryScrollObserver.observe(sent);
}

/**
 * 确保列表底部有分页哨兵（最新一条始终在列表最上方）。
 * @param {HTMLElement} history
 */
function ensureLlmHistorySentinel(history) {
  let s = document.getElementById("llm-history-load-more");
  if (s && s.parentElement === history) {
    observeLlmHistorySentinel();
    return s;
  }
  s = document.createElement("div");
  s.id = "llm-history-load-more";
  s.className = "llm-history-sentinel";
  s.textContent = "加载中…";
  history.appendChild(s);
  observeLlmHistorySentinel();
  return s;
}

function trimLlmHistoryDom(maxRounds) {
  const history = document.getElementById("llm-chat-history");
  const sent = document.getElementById("llm-history-load-more");
  if (!history || !sent) return;
  /** @type {HTMLElement[]} */
  const rounds = [...history.querySelectorAll(".llm-round")];
  if (rounds.length <= maxRounds) return;
  let removeCount = rounds.length - maxRounds;
  while (removeCount-- > 0) {
    const oldest = sent.previousElementSibling;
    if (oldest instanceof HTMLElement && oldest.classList.contains("llm-round")) {
      oldest.remove();
    } else {
      break;
    }
  }
}

/**
 * @param {object} row listAgentBarTurnsPage 返回的条目
 */
function agentBarTurnRowToPayload(row) {
  const reasoningBody =
    row.assistantReasoningText != null && String(row.assistantReasoningText).trim()
      ? String(row.assistantReasoningText).trim()
      : "";
  return {
    kind: "bar_close",
    barCloseId: row.barCloseId,
    tvSymbol: row.tvSymbol,
    periodLabel: row.periodLabel,
    capturedAt: row.capturedAt,
    textForLlm: row.textForLlm,
    fullUserPromptForDisplay: row.llmUserFullText,
    chartImage: null,
    llm: {
      enabled: true,
      reasoningEnabled: !!reasoningBody,
      streaming: false,
      analysisText: row.agentOk ? row.assistantText || "" : null,
      cardSummary: row.agentOk && row.cardSummary ? String(row.cardSummary) : null,
      toolTrace: Array.isArray(row.toolTrace) ? row.toolTrace : [],
      error: row.agentOk ? null : row.agentError || "Agent 失败",
      reasoningText: reasoningBody || null,
    },
  };
}

async function loadNextLlmHistoryPage() {
  const history = document.getElementById("llm-chat-history");
  if (!history || !window.argus?.listAgentBarTurnsPage) return;
  if (llmHistoryLoading || llmHistoryExhausted) return;

  const sel = document.getElementById("symbol-select");
  const tvSymbol = sel?.value?.trim() || "";
  const interval = chartIntervalCanonical || canonTradingViewInterval(chartInterval) || "5";
  if (!tvSymbol) {
    updateLlmHistorySentinelText("请先选择交易品种");
    return;
  }

  llmHistoryLoading = true;
  updateLlmHistorySentinelText("加载中…");
  try {
    const res = (await window.argus.listAgentBarTurnsPage({
      tvSymbol,
      interval,
      limit: LLM_HISTORY_PAGE_SIZE,
      cursor: llmHistoryCursor,
    })) as { rows: unknown[]; nextCursor: unknown; hasMore: boolean };

    const sentinel = document.getElementById("llm-history-load-more");
    if (!sentinel) {
      ensureLlmHistorySentinel(history);
    }

    for (const row of res.rows) {
      const payload = agentBarTurnRowToPayload(row);
      const roundEl = buildLlmRoundElement(payload);
      history.insertBefore(roundEl, document.getElementById("llm-history-load-more"));
    }

    llmHistoryCursor = res.nextCursor;
    if (!res.hasMore || res.rows.length === 0) {
      llmHistoryExhausted = true;
      if (res.rows.length === 0 && !llmHistoryCursor) {
        updateLlmHistorySentinelText("暂无历史记录");
      } else {
        updateLlmHistorySentinelText("已加载全部");
      }
    } else {
      updateLlmHistorySentinelText("继续下滑加载更早记录");
    }
  } catch (e) {
    llmHistoryExhausted = true;
    const msg = e instanceof Error ? e.message : String(e);
    updateLlmHistorySentinelText(`加载失败：${msg}（点击重试）`);
    const sent = document.getElementById("llm-history-load-more");
    if (sent) {
      sent.onclick = () => {
        sent.onclick = null;
        llmHistoryExhausted = false;
        void loadNextLlmHistoryPage();
      };
    }
  } finally {
    llmHistoryLoading = false;
    observeLlmHistorySentinel();
  }
}

/**
 * 切换品种/周期或应用启动时：清空并重新拉第一页（最新在上）。
 */
async function reloadLlmHistoryFromStore() {
  const history = document.getElementById("llm-chat-history");
  if (!history || !window.argus?.listAgentBarTurnsPage) return;

  if (llmHistoryScrollObserver) {
    llmHistoryScrollObserver.disconnect();
    llmHistoryScrollObserver = null;
  }

  history.replaceChildren();
  llmHistoryCursor = null;
  llmHistoryExhausted = false;
  llmHistoryLoading = false;

  const sentinel = document.createElement("div");
  sentinel.id = "llm-history-load-more";
  sentinel.className = "llm-history-sentinel";
  sentinel.textContent = "加载中…";
  history.appendChild(sentinel);
  history.hidden = false;

  await loadNextLlmHistoryPage();
}

/**
 * @param {string} barCloseId
 * @returns {HTMLElement | null}
 */
function findAssistantBubbleForBar(barCloseId) {
  if (!barCloseId) return null;
  const id = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(barCloseId) : barCloseId;
  return document.querySelector(
    `#llm-chat-history .llm-round[data-bar-close-id="${id}"] .llm-bubble--assistant`,
  );
}

/**
 * @param {string} barCloseId
 * @returns {HTMLElement | null}
 */
function findReasoningBubbleForBar(barCloseId) {
  if (!barCloseId) return null;
  const id = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(barCloseId) : barCloseId;
  return document.querySelector(
    `#llm-chat-history .llm-round[data-bar-close-id="${id}"] .llm-bubble--reasoning`,
  );
}

/**
 * @param {string} barCloseId
 * @returns {HTMLElement | null}
 */
function findToolBubbleForBar(barCloseId) {
  if (!barCloseId) return null;
  const id = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(barCloseId) : barCloseId;
  return document.querySelector(`#llm-chat-history .llm-round[data-bar-close-id="${id}"] .llm-bubble--tools`);
}

/**
 * @param {string} barCloseId
 * @returns {HTMLElement | null}
 */
function findLlmRoundRoot(barCloseId) {
  if (!barCloseId) return null;
  const id = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(barCloseId) : barCloseId;
  const el = document.querySelector(`#llm-chat-history .llm-round[data-bar-close-id="${id}"]`);
  return el instanceof HTMLElement ? el : null;
}

/**
 * @param {object} payload
 * @param {object} llm
 * @returns {"running" | "done" | "error"}
 */
function getLlmRoundStatusKind(payload, llm) {
  if (llm.streaming === true) return "running";
  if (llm.error) return "error";
  if (llm.skippedReason && String(llm.skippedReason).trim()) return "skipped";
  return "done";
}

/**
 * @param {"running" | "done" | "error"} kind
 * @returns {HTMLElement}
 */
function buildLlmRoundStatusEl(kind) {
  const wrap = document.createElement("span");
  wrap.className = "llm-round-status-wrap";
  const st = document.createElement("span");
  st.className = `llm-round-status llm-round-status--${kind}`;
  if (kind === "running") {
    const sp = document.createElement("span");
    sp.className = "llm-round-spinner";
    sp.setAttribute("aria-hidden", "true");
    st.appendChild(sp);
    st.appendChild(document.createTextNode("决策中"));
  } else if (kind === "error") {
    st.textContent = "失败";
  } else if (kind === "skipped") {
    st.textContent = "已跳过";
  } else {
    st.textContent = "已完成";
  }
  wrap.appendChild(st);
  return wrap;
}

/**
 * Agent 结束后刷新列表项：解锁明细、更新角标。
 * @param {string} barCloseId
 * @param {"ok" | "err"} outcome
 */
function updateLlmRoundAfterAgentFinished(barCloseId, outcome) {
  const root = findLlmRoundRoot(barCloseId);
  if (!root) return;
  root.dataset.detailLocked = "0";
  const card = root.querySelector(".llm-round-card");
  if (card instanceof HTMLElement) card.classList.remove("llm-round-card--locked");
  const btn = root.querySelector(".llm-round-detail-btn");
  if (btn instanceof HTMLButtonElement) {
    btn.disabled = false;
    btn.setAttribute("aria-label", "在弹窗中查看多轮对话明细");
  }
  const statusWrap = root.querySelector(".llm-round-status-wrap");
  if (statusWrap) {
    const kind = outcome === "err" ? "error" : "done";
    statusWrap.replaceWith(buildLlmRoundStatusEl(kind));
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeSessionDisplayText(text) {
  return String(text || "").replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
}

/**
 * 仅用于弹窗展示：把多模态 content 提炼成人可读文本。
 * - `type: "text"` 提取其中的 text
 * - `type: "image_url"` 直接忽略
 * 其他结构仍交回 JSON 回退逻辑处理。
 *
 * @param {unknown} content
 * @returns {string | null}
 */
function extractReadableSessionContent(content) {
  if (Array.isArray(content)) {
    const textParts = [];
    let recognized = false;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const item = /** @type {{ type?: string, text?: string }} */ (part);
      const type = String(item.type || "");
      if (type === "text") {
        recognized = true;
        textParts.push(normalizeSessionDisplayText(item.text || ""));
        continue;
      }
      if (type === "image_url") {
        recognized = true;
      }
    }
    if (recognized) return textParts.join("\n\n").trim();
    return null;
  }

  if (content && typeof content === "object") {
    const item = /** @type {{ type?: string, text?: string }} */ (content);
    const type = String(item.type || "");
    if (type === "text") return normalizeSessionDisplayText(item.text || "");
    if (type === "image_url") return "";
  }

  return null;
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function formatSessionMsgContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return normalizeSessionDisplayText(content);
  const readable = extractReadableSessionContent(content);
  if (readable != null) return readable;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

/**
 * 非 assistant 行仍合并在一列（含罕见的 tool_calls），与落库结构一致。
 * @param {object} m
 * @returns {string}
 */
function formatSessionMessageRowBody(m) {
  const parts = [];
  if (m.content != null && m.content !== "") {
    parts.push(formatSessionMsgContent(m.content));
  }
  if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
    parts.push(`tool_calls:\n${JSON.stringify(m.toolCalls, null, 2)}`);
  }
  if (m.toolCallId) parts.push(`tool_call_id: ${m.toolCallId}`);
  if (m.name) parts.push(`name: ${m.name}`);
  return parts.join("\n\n").trim() || "（空）";
}

/**
 * assistant 主文本（不含 tool_calls），单独一块展示。
 * @param {object} m
 * @returns {string}
 */
function formatAssistantSessionMainText(m) {
  if (m.content != null && m.content !== "") {
    return formatSessionMsgContent(m.content);
  }
  return "";
}

/**
 * @param {string} role
 * @returns {string}
 */
function sanitizeSessionMsgRoleClass(role) {
  const s = String(role || "unknown").replace(/[^a-z0-9_-]/gi, "");
  return s || "unknown";
}

/**
 * @param {string | null | undefined} capturedAt
 * @returns {string}
 */
function formatSessionCapturedAt(capturedAt) {
  if (!capturedAt) return "";
  const dt = new Date(capturedAt);
  if (Number.isNaN(dt.getTime())) return "";
  const pad2 = (n) => String(n).padStart(2, "0");
  return [
    `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`,
    `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`,
  ].join(" ");
}

/**
 * @param {string} dataUrl
 * @returns {HTMLDivElement}
 */
function createSessionChartRow(dataUrl) {
  const row = document.createElement("div");
  row.className = "llm-session-msg llm-session-msg--chart";
  row.setAttribute("role", "listitem");

  const roleEl = document.createElement("div");
  roleEl.className = "llm-session-msg-role";
  roleEl.textContent = "chart";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "llm-round-card-thumb llm-session-detail-chart-thumb";
  btn.title = "放大查看本轮截图";
  btn.setAttribute("aria-label", "放大预览图表截图");

  const img = document.createElement("img");
  img.src = dataUrl;
  img.alt = "本轮 K 线收盘时的图表截图";
  img.decoding = "async";

  btn.appendChild(img);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    openLlmChartPreview(dataUrl);
  });

  row.append(roleEl, btn);
  return row;
}

/**
 * @param {string} role
 * @param {string} text
 * @returns {boolean}
 */
function shouldCollapseSessionMessage(role, text) {
  const normalizedRole = String(role || "").toLowerCase();
  if (normalizedRole !== "system" && normalizedRole !== "user") return false;
  const body = String(text || "");
  if (!body) return false;
  const lineCount = body.split("\n").length;
  return body.length > 600 || lineCount > 10;
}

/**
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copySessionText(text) {
  const value = String(text || "");
  if (!value) return false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to legacy copy path.
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "true");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(ta);
    return copied === true;
  } catch {
    return false;
  }
}

/**
 * @param {SVGSVGElement} svg
 * @param {"copy"|"success"|"error"} state
 */
function setSessionCopyIconState(svg, state) {
  svg.replaceChildren();
  const NS = "http://www.w3.org/2000/svg";
  if (state === "copy") {
    const rectBack = document.createElementNS(NS, "rect");
    rectBack.setAttribute("x", "9");
    rectBack.setAttribute("y", "9");
    rectBack.setAttribute("width", "11");
    rectBack.setAttribute("height", "11");
    rectBack.setAttribute("rx", "2");
    rectBack.setAttribute("ry", "2");
    const pathFront = document.createElementNS(NS, "path");
    pathFront.setAttribute("d", "M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3");
    svg.append(rectBack, pathFront);
    return;
  }
  if (state === "success") {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", "M20 6L9 17l-5-5");
    svg.append(path);
    return;
  }
  const a = document.createElementNS(NS, "path");
  a.setAttribute("d", "M18 6L6 18");
  const b = document.createElementNS(NS, "path");
  b.setAttribute("d", "m6 6 12 12");
  svg.append(a, b);
}

/**
 * @param {string} text
 * @returns {HTMLButtonElement}
 */
function createSessionCopyButton(text) {
  const setLabel = (label) => {
    labelEl.textContent = label;
  };

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "llm-session-copy-btn";
  btn.setAttribute("aria-label", "复制当前内容块");

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.8");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.classList.add("llm-session-copy-btn-icon");
  icon.setAttribute("aria-hidden", "true");
  setSessionCopyIconState(icon, "copy");

  const labelEl = document.createElement("span");
  labelEl.className = "llm-session-copy-btn-label";
  setLabel("复制");

  btn.append(icon, labelEl);

  let resetTimer = 0;
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    btn.disabled = true;
    const copied = await copySessionText(text);
    setLabel(copied ? "已复制" : "复制失败");
    setSessionCopyIconState(icon, copied ? "success" : "error");
    btn.classList.toggle("llm-session-copy-btn--ok", copied === true);
    btn.classList.toggle("llm-session-copy-btn--err", copied === false);
    btn.setAttribute("aria-label", copied ? "已复制到剪贴板" : "复制失败，请重试");
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      setLabel("复制");
      setSessionCopyIconState(icon, "copy");
      btn.classList.remove("llm-session-copy-btn--ok", "llm-session-copy-btn--err");
      btn.setAttribute("aria-label", "复制当前内容块");
      btn.disabled = false;
    }, copied ? 1200 : 1600);
  });

  return btn;
}

/**
 * @param {HTMLElement} contentEl
 * @param {string} text
 * @returns {HTMLDivElement}
 */
function createSessionCopyBlock(contentEl, text) {
  const wrap = document.createElement("div");
  wrap.className = "llm-session-copy-block";
  wrap.append(createSessionCopyButton(text), contentEl);
  return wrap;
}

/**
 * @param {string} text
 * @returns {HTMLDivElement}
 */
function createCollapsibleSessionContent(text) {
  const wrap = document.createElement("div");
  wrap.className = "llm-session-msg-collapse llm-session-copy-block";

  const preview = document.createElement("pre");
  preview.className = "llm-session-msg-pre llm-session-msg-pre--collapsed";
  preview.textContent = text;

  const full = document.createElement("pre");
  full.className = "llm-session-msg-pre llm-session-msg-pre--full";
  full.textContent = text;
  full.hidden = true;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "llm-session-msg-collapse-toggle";
  toggle.textContent = "展开全文";
  toggle.setAttribute("aria-expanded", "false");

  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
    toggle.textContent = expanded ? "展开全文" : "收起";
    preview.hidden = !expanded;
    full.hidden = expanded;
  });

  wrap.append(createSessionCopyButton(text), preview, full, toggle);
  return wrap;
}

/**
 * @param {string} reasoningText
 * @returns {HTMLDivElement}
 */
function createSessionReasoningRow(reasoningText) {
  const row = document.createElement("div");
  row.className = "llm-session-msg llm-session-msg--reasoning";
  row.setAttribute("role", "listitem");
  const roleEl = document.createElement("div");
  roleEl.className = "llm-session-msg-role";
  roleEl.textContent = "reasoning · 深度思考";
  const text = String(reasoningText || "").trim();
  const pre = document.createElement("pre");
  pre.className = "llm-session-msg-pre llm-session-msg-reasoning-pre";
  pre.textContent = text;
  row.appendChild(roleEl);
  row.appendChild(createSessionCopyBlock(pre, text));
  return row;
}

/**
 * @param {HTMLElement} container
 * @param {object[]} msgs
 * @param {string} [chartDataUrl]
 * @param {string} [assistantReasoningText]
 */
function renderSessionMessagesInto(container, msgs, chartDataUrl = "", assistantReasoningText = "") {
  container.replaceChildren();
  const reasoningTrimmed = String(assistantReasoningText || "").trim();
  let reasoningInserted = false;

  /** 深度思考紧接附图之后（有图时在 user → chart → reasoning → assistant/tool…）。*/
  const insertReasoningAfterChart = () => {
    if (!reasoningTrimmed || reasoningInserted) return;
    reasoningInserted = true;
    container.appendChild(createSessionReasoningRow(reasoningTrimmed));
  };

  const lastUserIdx = msgs.reduce((acc, m, idx) => {
    return String(m?.role || "").toLowerCase() === "user" ? idx : acc;
  }, -1);
  let chartInserted = false;
  /** @type {HTMLElement | null} */
  let lastUserRowEl = null;

  for (const [idx, m] of msgs.entries()) {
    const row = document.createElement("div");
    row.className = `llm-session-msg llm-session-msg--${sanitizeSessionMsgRoleClass(m.role)}`;
    row.setAttribute("role", "listitem");
    const roleEl = document.createElement("div");
    roleEl.className = "llm-session-msg-role";
    const seq = m.seq != null ? ` · #${m.seq}` : "";
    roleEl.textContent = `${m.role || "?"}${seq}`;
    const isAssistant = String(m.role || "").toLowerCase() === "assistant";
    const toolCalls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    const hasToolCalls = toolCalls.length > 0;

    if (isAssistant && hasToolCalls) {
      const mainText = formatAssistantSessionMainText(m);
      if (mainText) {
        const preMain = document.createElement("pre");
        preMain.className = "llm-session-msg-pre";
        preMain.textContent = mainText;
        row.appendChild(roleEl);
        row.appendChild(createSessionCopyBlock(preMain, mainText));
      } else {
        row.appendChild(roleEl);
      }
      const toolsWrap = document.createElement("div");
      toolsWrap.className = "llm-session-msg-toolcalls";
      const toolsLabel = document.createElement("div");
      toolsLabel.className = "llm-session-msg-toolcalls-label";
      toolsLabel.textContent = "工具调用";
      const toolText = JSON.stringify(toolCalls, null, 2);
      const preTools = document.createElement("pre");
      preTools.className = "llm-session-msg-pre llm-session-msg-pre--toolcalls";
      preTools.textContent = toolText;
      toolsWrap.append(toolsLabel, createSessionCopyBlock(preTools, toolText));
      row.appendChild(toolsWrap);
    } else {
      const bodyText = formatSessionMessageRowBody(m);
      row.appendChild(roleEl);
      if (shouldCollapseSessionMessage(m.role, bodyText)) {
        row.appendChild(createCollapsibleSessionContent(bodyText));
      } else {
        const pre = document.createElement("pre");
        pre.className = "llm-session-msg-pre";
        pre.textContent = bodyText;
        row.appendChild(createSessionCopyBlock(pre, bodyText));
      }
    }
    container.appendChild(row);
    if (String(m?.role || "").toLowerCase() === "user") {
      lastUserRowEl = row;
    }

    if (!chartInserted && chartDataUrl && lastUserIdx === idx) {
      container.appendChild(createSessionChartRow(chartDataUrl));
      chartInserted = true;
      insertReasoningAfterChart();
    }
  }

  if (!chartInserted && chartDataUrl) {
    container.appendChild(createSessionChartRow(chartDataUrl));
    chartInserted = true;
    insertReasoningAfterChart();
  }

  if (!reasoningInserted && reasoningTrimmed && lastUserRowEl) {
    const reasoningRow = createSessionReasoningRow(reasoningTrimmed);
    reasoningInserted = true;
    if (lastUserRowEl.nextSibling) {
      container.insertBefore(reasoningRow, lastUserRowEl.nextSibling);
    } else {
      container.appendChild(reasoningRow);
    }
  }

  if (!reasoningInserted && reasoningTrimmed) {
    container.appendChild(createSessionReasoningRow(reasoningTrimmed));
    reasoningInserted = true;
  }
}

async function openLlmSessionDetailModal(barCloseId) {
  const modal = document.getElementById("llm-session-detail-modal");
  const bodyEl = document.getElementById("llm-session-detail-body");
  const loading = document.getElementById("llm-session-detail-loading");
  const errEl = document.getElementById("llm-session-detail-error");
  const subtitle = document.getElementById("llm-session-detail-subtitle");
  const title = document.getElementById("llm-session-detail-title");
  if (!modal || !bodyEl) return;

  const root = findLlmRoundRoot(barCloseId);
  const sym = root?.dataset.tvSymbol?.trim() || "";
  const cap = root?.dataset.capturedAt || "";
  const timeLine = formatSessionCapturedAt(cap);

  if (subtitle) {
    subtitle.textContent = "";
    subtitle.hidden = true;
  }
  if (title) {
    title.textContent = [sym, timeLine].filter(Boolean).join(" · ") || "Agent 多轮对话";
  }

  bodyEl.replaceChildren();
  if (errEl) {
    errEl.textContent = "";
    errEl.hidden = true;
  }
  if (loading) loading.hidden = false;
  modal.hidden = false;

  if (!window.argus || typeof window.argus.getAgentSessionMessages !== "function") {
    if (loading) loading.hidden = true;
    if (errEl) {
      errEl.textContent = "当前环境无法读取会话明细";
      errEl.hidden = false;
    }
    return;
  }

  try {
    const rawSession = await window.argus.getAgentSessionMessages(barCloseId);
    /** @type {unknown[]} */
    let msgs: unknown[] = [];
    let assistantReasoningText = "";
    if (Array.isArray(rawSession)) {
      msgs = rawSession;
    } else if (rawSession && typeof rawSession === "object") {
      const rs = rawSession as { messages?: unknown; assistantReasoningText?: unknown };
      msgs = Array.isArray(rs.messages) ? rs.messages : [];
      assistantReasoningText =
        typeof rs.assistantReasoningText === "string" && rs.assistantReasoningText.trim()
          ? rs.assistantReasoningText.trim()
          : "";
    }
    let chartData: unknown = null;
    if (typeof window.argus.getAgentBarTurnChart === "function") {
      try {
        chartData = await window.argus.getAgentBarTurnChart(barCloseId);
      } catch {
        chartData = null;
      }
    }
    if (loading) loading.hidden = true;
    if (!Array.isArray(msgs) || msgs.length === 0) {
      if (errEl) {
        errEl.textContent = "暂无消息记录（可能尚未落库）";
        errEl.hidden = false;
      }
      return;
    }
    const chartUrl =
      chartData && typeof chartData === "object" && chartData !== null && "dataUrl" in chartData
        ? String((chartData as { dataUrl?: unknown }).dataUrl ?? "")
        : "";
    renderSessionMessagesInto(bodyEl, msgs, chartUrl, assistantReasoningText);
  } catch (e) {
    if (loading) loading.hidden = true;
    const msg = e instanceof Error ? e.message : String(e);
    if (errEl) {
      errEl.textContent = `加载失败：${msg}`;
      errEl.hidden = false;
    }
  }
}

function closeLlmSessionDetailModal() {
  const modal = document.getElementById("llm-session-detail-modal");
  if (modal) modal.hidden = true;
}

function initLlmSessionDetailModal() {
  const modal = document.getElementById("llm-session-detail-modal");
  const btn = document.getElementById("btn-llm-session-detail-close");
  if (!modal) return;
  const close = () => closeLlmSessionDetailModal();
  btn?.addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (modal.hidden) return;
    close();
  });
}

/**
 * 老数据里曾将 assistant 正文与工具轨迹拼在同一个字段里，这里兼容拆开显示。
 * @param {string | null | undefined} text
 * @returns {{ assistantText: string, legacyToolText: string }}
 */
function splitLegacyAssistantAndToolText(text) {
  const raw = typeof text === "string" ? text : "";
  const marker = "\n---\n工具轨迹：\n";
  const idx = raw.indexOf(marker);
  if (idx < 0) return { assistantText: raw, legacyToolText: "" };
  return {
    assistantText: raw.slice(0, idx),
    legacyToolText: raw.slice(idx + marker.length),
  };
}

/**
 * @param {unknown[] | null | undefined} trace
 * @returns {string}
 */
function formatToolTraceDisplay(trace) {
  if (!Array.isArray(trace) || trace.length === 0) return "";
  return trace
    .map((t) => {
      const result = t?.result && typeof t.result === "object" ? t.result : {};
      const ok = result.ok === true ? "ok" : "fail";
      const name = t?.name ? String(t.name) : "unknown_tool";
      return `• ${name} (${ok}) ${JSON.stringify(result)}`;
    })
    .join("\n");
}

/**
 * @param {object | null | undefined} llm
 * @returns {{ assistantText: string, toolText: string }}
 */
function resolveAssistantAndToolDisplay(llm) {
  const skip = llm?.skippedReason != null ? String(llm.skippedReason).trim() : "";
  if (skip) {
    return { assistantText: skip, toolText: "" };
  }
  const legacy = splitLegacyAssistantAndToolText(llm?.analysisText);
  const toolText = formatToolTraceDisplay(llm?.toolTrace) || legacy.legacyToolText;
  return {
    assistantText: legacy.assistantText,
    toolText,
  };
}

function fmtTradePx(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function pickFiniteNum(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object | null | undefined} llm
 */
function setIdleNeutralTradeSummaryText(textEl, llm) {
  const L = llm && typeof llm === "object" ? llm : {};
  const short =
    L.cardSummary != null && String(L.cardSummary).trim()
      ? normalizeAssistantDisplayText(String(L.cardSummary).trim())
      : "";
  if (short) {
    textEl.textContent = short;
    textEl.classList.remove("llm-round-neutral-trade-text--analysis");
    textEl.classList.add("llm-round-neutral-trade-text--summary");
    return;
  }
  const d = resolveAssistantAndToolDisplay(L);
  const body = d.assistantText && String(d.assistantText).trim();
  if (body) {
    textEl.textContent = normalizeAssistantDisplayText(body);
    textEl.classList.add("llm-round-neutral-trade-text--analysis");
    textEl.classList.remove("llm-round-neutral-trade-text--summary");
  } else {
    textEl.textContent = "暂无可摘录的分析正文。";
    textEl.classList.remove("llm-round-neutral-trade-text--analysis", "llm-round-neutral-trade-text--summary");
  }
}

/**
 * @param {"running" | "idle" | "skipped" | "error"} kind
 * @param {object | null | undefined} [llm] 与 `kind === "idle"` 时展示 `llm.cardSummary` 或正文摘要用
 * @returns {HTMLElement}
 */
function buildNeutralTradeStripElement(kind, llm) {
  const wrap = document.createElement("div");
  wrap.className = `llm-round-neutral-trade llm-round-neutral-trade--${kind}`;
  wrap.setAttribute("role", "status");

  const badge = document.createElement("span");
  badge.className = "llm-round-event-badge llm-round-event-badge--neutral";
  if (kind === "running") badge.textContent = "THINK";
  else if (kind === "skipped") badge.textContent = "SKIP";
  else if (kind === "error") badge.textContent = "ERROR";
  else badge.textContent = "NO TRADE";
  const badgeCell = document.createElement("div");
  badgeCell.className = "llm-round-event-badge-cell";
  badgeCell.appendChild(badge);

  const body = document.createElement("div");
  body.className = "llm-round-neutral-trade-body";
  const title = document.createElement("div");
  title.className = "llm-round-neutral-trade-title";
  if (kind === "running") title.textContent = "等待本轮下单决策";
  else if (kind === "skipped") title.textContent = "本轮未触发 Agent 会话";
  else if (kind === "error") title.textContent = "本轮未完成交易执行";
  else title.textContent = "本轮无下单动作";
  const text = document.createElement("div");
  text.className = "llm-round-neutral-trade-text";
  if (kind === "running") text.textContent = "模型分析进行中，若触发交易将追加到此处。";
  else if (kind === "skipped") text.textContent = "当前只有状态判断或外部条件未满足，没有生成可查看的交易会话。";
  else if (kind === "error") {
    const raw = llm && typeof llm.error === "string" ? llm.error.trim() : "";
    const detail = raw && raw !== "error" ? raw : "";
    text.textContent = detail
      ? detail
      : "Agent 分析未成功完成，因此没有可确认的开平仓事件。";
  } else setIdleNeutralTradeSummaryText(text, llm);
  body.append(title, text);

  wrap.append(badgeCell, body);
  return wrap;
}

/**
 * @param {object} payload
 * @returns {"running" | "idle" | "skipped" | "error"}
 */
function getNeutralTradeKind(payload) {
  const llm = payload?.llm;
  if (llm?.streaming === true) return "running";
  if (llm?.skippedReason && String(llm.skippedReason).trim()) return "skipped";
  if (llm?.error) return "error";
  return "idle";
}

/**
 * @param {object} args
 * @param {object} result
 * @returns {HTMLElement | null}
 */
function buildOpenTradeStripElement(args, result) {
  const side = String(args.side || "").toLowerCase() === "short" ? "short" : "long";
  const orderType = String(args.order_type || "market").toLowerCase() === "limit" ? "limit" : "market";
  const takeProfit = pickFiniteNum(args.take_profit_trigger_price ?? args.tp_trigger_price);
  const stopLoss = pickFiniteNum(args.stop_loss_trigger_price ?? args.sl_trigger_price);
  const limitPx = pickFiniteNum(args.limit_price);
  const ex = result.exchange && typeof result.exchange === "object" ? result.exchange : {};
  const avgPx = pickFiniteNum(ex.avgPx);
  const openPrice = avgPx ?? (orderType === "limit" ? limitPx : null);

  const wrap = document.createElement("div");
  wrap.className = `llm-round-open-trade llm-round-open-trade--${side}`;
  wrap.setAttribute("role", "status");

  const badge = document.createElement("span");
  badge.className = "llm-round-event-badge llm-round-event-badge--open";
  badge.textContent = "OPEN";
  const badgeCell = document.createElement("div");
  badgeCell.className = "llm-round-event-badge-cell";
  badgeCell.appendChild(badge);

  let priceLine = "—";
  if (openPrice != null) {
    priceLine = fmtTradePx(openPrice) + (orderType === "limit" ? " · LIMIT" : " · AVG");
  } else if (orderType === "limit") {
    priceLine = "LIMIT · 待成交";
  } else {
    priceLine = "MKT · 见持仓均价";
  }

  const body = document.createElement("div");
  body.className = "llm-round-event-body";
  const title = document.createElement("div");
  title.className = "llm-round-event-title";
  title.textContent = side === "short" ? "做空开仓" : "做多开仓";
  const meta = document.createElement("div");
  meta.className = "llm-round-event-meta";

  const metaLines = [
    ["入场", priceLine],
    ["TP", takeProfit != null ? fmtTradePx(takeProfit) : "未设"],
    ["SL", stopLoss != null ? fmtTradePx(stopLoss) : "未设"],
  ];
  for (const [label, value] of metaLines) {
    const row = document.createElement("span");
    row.className = "llm-round-event-meta-item";
    const k = document.createElement("span");
    k.className = "llm-round-event-meta-label";
    k.textContent = label;
    const v = document.createElement("span");
    v.className = "llm-round-event-meta-value";
    v.textContent = value;
    row.append(k, v);
    meta.appendChild(row);
  }

  body.append(title, meta);
  wrap.append(badgeCell, body);
  return wrap;
}

/**
 * @param {object} args
 * @param {object} result
 * @returns {HTMLElement | null}
 */
function buildCloseTradeStripElement(args, result) {
  const orderType = String(args.order_type || "market").toLowerCase() === "limit" ? "limit" : "market";
  const limitPx = pickFiniteNum(args.limit_price);
  const ex = result.exchange && typeof result.exchange === "object" ? result.exchange : {};
  const closeSz = ex.closeSz != null && String(ex.closeSz).trim() !== "" ? String(ex.closeSz) : "—";
  const closedSide =
    result.closedSide === "short" || result.closedSide === "long" ? result.closedSide : null;

  const wrap = document.createElement("div");
  const sideMod =
    closedSide === "short"
      ? "llm-round-close-trade--short"
      : closedSide === "long"
        ? "llm-round-close-trade--long"
        : "llm-round-close-trade--unknown";
  wrap.className = `llm-round-close-trade ${sideMod}`;
  wrap.setAttribute("role", "status");

  const badge = document.createElement("span");
  badge.className = "llm-round-event-badge llm-round-event-badge--close";
  badge.textContent = "CLOSE";
  const badgeCell = document.createElement("div");
  badgeCell.className = "llm-round-event-badge-cell";
  badgeCell.appendChild(badge);
  const priceLine =
    orderType === "limit" && limitPx != null
      ? `${fmtTradePx(limitPx)} · LIMIT`
      : orderType === "limit"
        ? "LIMIT · 待确认"
        : "MKT";

  const body = document.createElement("div");
  body.className = "llm-round-event-body";
  const title = document.createElement("div");
  title.className = "llm-round-event-title";
  if (closedSide === "short") title.textContent = "平空";
  else if (closedSide === "long") title.textContent = "平多";
  else title.textContent = "平仓";
  const meta = document.createElement("div");
  meta.className = "llm-round-event-meta";
  const metaLines = [
    ["委托", priceLine],
    ["数量", closeSz],
  ];
  for (const [label, value] of metaLines) {
    const row = document.createElement("span");
    row.className = "llm-round-event-meta-item";
    const k = document.createElement("span");
    k.className = "llm-round-event-meta-label";
    k.textContent = label;
    const v = document.createElement("span");
    v.className = "llm-round-event-meta-value";
    v.textContent = value;
    row.append(k, v);
    meta.appendChild(row);
  }

  body.append(title, meta);
  wrap.append(badgeCell, body);
  return wrap;
}

/**
 * 按 tool_trace **时间顺序**生成平仓/开仓摘要块；同一根 K 线内先平后开会得到上下两块。
 * 卡片整体高亮取**最后一笔**成功交易（平→开 则与最终开仓方向一致）。
 * @param {object} payload
 * @returns {{ stack: HTMLElement | null, accent: "long" | "short" | "close" | null }}
 */
function buildTradeStackFromToolTrace(payload) {
  const toolTrace = payload?.llm?.toolTrace;
  if (!Array.isArray(toolTrace)) return { stack: null, accent: null };
  /** @type {HTMLElement[]} */
  const blocks = [];
  /** @type {"long" | "short" | "close" | null} */
  let accent = null;

  for (const t of toolTrace) {
    const name = t?.name != null ? String(t.name) : "";
    const result = t?.result && typeof t.result === "object" ? t.result : {};
    if (result.ok !== true) continue;
    const args = t?.args && typeof t.args === "object" ? t.args : {};
    if (name === "close_position") {
      const el = buildCloseTradeStripElement(args, result);
      if (el) {
        blocks.push(el);
        accent =
          result.closedSide === "short"
            ? "short"
            : result.closedSide === "long"
              ? "long"
              : "close";
      }
    } else if (name === "open_position") {
      const el = buildOpenTradeStripElement(args, result);
      if (el) {
        blocks.push(el);
        accent = String(args.side || "").toLowerCase() === "short" ? "short" : "long";
      }
    }
  }

  const stack = document.createElement("div");
  stack.className = "llm-round-trade-stack";
  if (blocks.length === 0) {
    stack.appendChild(buildNeutralTradeStripElement(getNeutralTradeKind(payload), payload?.llm));
    return { stack, accent: null };
  }
  for (const b of blocks) stack.appendChild(b);
  return { stack, accent };
}

/**
 * @param {HTMLElement} card
 * @param {HTMLElement} inner
 * @param {HTMLElement} subEl
 * @param {object} payload
 */
function applyTradeStripsToRoundCard(card, inner, subEl, payload) {
  for (const n of inner.querySelectorAll(".llm-round-trade-stack")) {
    n.remove();
  }
  card.classList.remove(
    "llm-round-card--has-open",
    "llm-round-card--open-long",
    "llm-round-card--open-short",
    "llm-round-card--trade-close",
  );
  const { stack, accent } = buildTradeStackFromToolTrace(payload);
  if (!stack) return;
  card.classList.add("llm-round-card--has-open");
  if (accent === "close") {
    card.classList.add("llm-round-card--trade-close");
  } else if (accent === "short") {
    card.classList.add("llm-round-card--open-short");
  } else if (accent === "long") {
    card.classList.add("llm-round-card--open-long");
  }
  inner.insertBefore(stack, subEl);
}

/**
 * 列表卡片上可见的说明（`.llm-round-stream-target` 在 CSS 中不可见，主因/跳过须写在此处）。
 * @param {HTMLElement} el
 * @param {object} llm
 */
function fillLlmRoundCardNoteElement(el, llm) {
  if (!el) return;
  const skip = llm?.skippedReason && String(llm.skippedReason).trim();
  const err = llm?.error && String(llm.error).trim() && !llm?.streaming;
  if (skip) {
    el.textContent = skip;
    el.className = "llm-round-card-note llm-round-card-note--skip";
    el.hidden = false;
  } else if (err) {
    el.textContent = String(llm.error).trim();
    el.className = "llm-round-card-note llm-round-card-note--error";
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

/**
 * @param {string} barCloseId
 * @param {object} llm
 */
function syncLlmRoundCardNoteFromPayload(barCloseId, llm) {
  const root = findLlmRoundRoot(barCloseId);
  if (!root) return;
  const el = root.querySelector(".llm-round-card-note");
  if (el instanceof HTMLElement) fillLlmRoundCardNoteElement(el, llm);
}

/**
 * 流式结束后根据最终 toolTrace 更新平仓/开仓摘要区。
 * @param {string} barCloseId
 * @param {unknown} toolTrace
 * @param {"idle" | "error"} [state]
 * @param {object} [llmPatch] 与无成交摘要条一起展示；失败时须带 `error` 原文，勿覆盖为 \"error\"。
 */
function syncLlmRoundTradeStrips(barCloseId, toolTrace, state = "idle", llmPatch) {
  const root = findLlmRoundRoot(barCloseId);
  if (!root) return;
  const card = root.querySelector(".llm-round-card");
  const inner = root.querySelector(".llm-round-card-inner");
  const sub = root.querySelector(".llm-round-card-sub");
  if (card instanceof HTMLElement && inner instanceof HTMLElement && sub instanceof HTMLElement) {
    const base = llmPatch && typeof llmPatch === "object" ? { ...llmPatch } : {};
    if (state === "error") {
      const em = typeof base.error === "string" && base.error.trim() ? base.error.trim() : "";
      base.error = em || "error";
    } else {
      if (!("error" in base)) base.error = null;
    }
    applyTradeStripsToRoundCard(card, inner, sub, {
      llm: {
        ...base,
        toolTrace: Array.isArray(toolTrace) ? toolTrace : [],
      },
    });
  }
}

/**
 * 构建单轮 DOM（实时收盘与库分页复用）：卡片 + 可见的 `.llm-round-card-note`；隐藏区仍供流式/IPC 更新气泡。
 * @returns {HTMLElement} `.llm-round` 根节点
 */
function buildLlmRoundElement(payload) {
  const llm = payload?.llm;
  const barCloseId = payload?.barCloseId;
  if (!barCloseId || !llm) {
    throw new Error("buildLlmRoundElement: 无效 payload");
  }
  const allowListItem =
    llm.enabled === true || Boolean(llm.skippedReason && String(llm.skippedReason).trim());
  if (!allowListItem) {
    throw new Error("buildLlmRoundElement: 无效 payload");
  }
  const display = resolveAssistantAndToolDisplay(llm);
  const statusKind = getLlmRoundStatusKind(payload, llm);
  const locked = llm.streaming === true;

  const round = document.createElement("div");
  round.className = "llm-round";
  round.dataset.barCloseId = barCloseId;
  round.dataset.tvSymbol = payload.tvSymbol || "";
  round.dataset.capturedAt = payload.capturedAt || "";
  round.dataset.detailLocked = locked ? "1" : "0";

  const cap = payload.capturedAt
    ? new Date(payload.capturedAt).toLocaleString("zh-CN", { hour12: false })
    : "";

  const card = document.createElement("div");
  card.className = "llm-round-card";
  if (locked) card.classList.add("llm-round-card--locked");

  const inner = document.createElement("div");
  inner.className = "llm-round-card-inner";

  const top = document.createElement("div");
  top.className = "llm-round-card-top";

  const head = document.createElement("div");
  head.className = "llm-round-card-head";
  const summaryTitle = document.createElement("span");
  summaryTitle.className = "llm-round-summary-title";
  summaryTitle.textContent = payload.tvSymbol || "未命名标的";
  head.appendChild(summaryTitle);

  top.append(head, buildLlmRoundStatusEl(statusKind));

  const sub = document.createElement("div");
  sub.className = "llm-round-card-sub";
  const subMeta = document.createElement("div");
  subMeta.className = "llm-round-card-submeta";
  const timeEl = document.createElement("span");
  timeEl.className = "llm-round-card-time";
  timeEl.textContent = cap;
  const detailBtn = document.createElement("button");
  detailBtn.type = "button";
  detailBtn.className = "llm-round-detail-btn";
  detailBtn.textContent = "详情";
  detailBtn.disabled = locked;
  detailBtn.setAttribute(
    "aria-label",
    locked ? "决策完成后可查看明细" : "在弹窗中查看多轮对话明细",
  );
  const skipped = Boolean(llm.skippedReason && String(llm.skippedReason).trim());
  if (skipped) {
    detailBtn.disabled = true;
    detailBtn.textContent = "—";
    detailBtn.setAttribute("aria-label", "本轮未调用 Agent，无会话明细");
    round.dataset.detailLocked = "1";
  }
  subMeta.append(timeEl);
  sub.append(subMeta, detailBtn);
  const cardNote = document.createElement("div");
  cardNote.className = "llm-round-card-note";
  cardNote.setAttribute("role", "status");
  fillLlmRoundCardNoteElement(cardNote, llm);

  inner.appendChild(top);
  inner.appendChild(cardNote);
  inner.appendChild(sub);
  applyTradeStripsToRoundCard(card, inner, sub, payload);
  card.appendChild(inner);

  const openIfUnlocked = () => {
    if (round.dataset.detailLocked === "1") return;
    void openLlmSessionDetailModal(barCloseId);
  };
  card.addEventListener("click", (e) => {
    const t = /** @type {HTMLElement | null} */ (e.target);
    if (t?.closest?.(".llm-round-detail-btn")) return;
    openIfUnlocked();
  });
  detailBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!detailBtn.disabled) void openLlmSessionDetailModal(barCloseId);
  });

  const streamTarget = document.createElement("div");
  streamTarget.className = "llm-round-stream-target";
  streamTarget.setAttribute("aria-hidden", "true");

  const rowUser = document.createElement("div");
  rowUser.className = "llm-chat-row llm-chat-row--user";
  const bubbleUser = document.createElement("div");
  bubbleUser.className = "llm-bubble llm-bubble--user";
  const userFull =
    typeof payload?.fullUserPromptForDisplay === "string" && payload.fullUserPromptForDisplay.trim()
      ? payload.fullUserPromptForDisplay
      : payload?.textForLlm || "";
  bubbleUser.textContent = userFull;

  /** @type {HTMLElement | null} */
  let rowReasoning = null;
  if (llm.reasoningEnabled) {
    rowReasoning = document.createElement("div");
    rowReasoning.className = "llm-chat-row llm-chat-row--reasoning";
    const wrap = document.createElement("div");
    wrap.className = "llm-reasoning-wrap";
    const label = document.createElement("div");
    label.className = "llm-reasoning-label";
    label.textContent = "深度思考";
    const bubbleReasoning = document.createElement("div");
    bubbleReasoning.className = "llm-bubble llm-bubble--reasoning";
    if (llm.streaming) {
      bubbleReasoning.textContent =
        llm.reasoningText != null && String(llm.reasoningText).length > 0
          ? normalizeAssistantDisplayText(llm.reasoningText)
          : "…";
    } else if (llm.reasoningText != null && String(llm.reasoningText).trim()) {
      bubbleReasoning.textContent = normalizeAssistantDisplayText(llm.reasoningText);
    } else {
      bubbleReasoning.textContent = "";
    }
    wrap.append(label, bubbleReasoning);
    rowReasoning.appendChild(wrap);
  }

  const rowTool = document.createElement("div");
  rowTool.className = "llm-chat-row llm-chat-row--tools";
  rowTool.hidden = !display.toolText;
  const toolWrap = document.createElement("div");
  toolWrap.className = "llm-tools-wrap";
  const toolLabel = document.createElement("div");
  toolLabel.className = "llm-tools-label";
  toolLabel.textContent = "工具调用";
  const bubbleTool = document.createElement("div");
  bubbleTool.className = "llm-bubble llm-bubble--tools";
  bubbleTool.textContent = display.toolText;
  toolWrap.append(toolLabel, bubbleTool);
  rowTool.appendChild(toolWrap);

  const rowAsst = document.createElement("div");
  rowAsst.className = "llm-chat-row llm-chat-row--assistant";
  const bubbleAsst = document.createElement("div");
  bubbleAsst.className = "llm-bubble llm-bubble--assistant";
  bubbleAsst.classList.remove("llm-bubble--error");
  if (llm.streaming) {
    bubbleAsst.textContent = "…";
  } else if (display.assistantText) {
    bubbleAsst.textContent = normalizeAssistantDisplayText(display.assistantText);
  } else {
    bubbleAsst.textContent = llm.error || "";
    bubbleAsst.classList.add("llm-bubble--error");
  }

  rowUser.appendChild(bubbleUser);
  rowAsst.appendChild(bubbleAsst);
  streamTarget.appendChild(rowUser);
  if (rowReasoning) streamTarget.appendChild(rowReasoning);
  streamTarget.appendChild(rowTool);
  streamTarget.appendChild(rowAsst);

  round.appendChild(card);
  round.appendChild(streamTarget);
  return round;
}

/**
 * 每根 K 线收盘且启用 LLM 时插入一轮：**最新在最上方**。
 * @returns {HTMLElement | null} 本轮助手气泡
 */
function appendLlmRound(payload) {
  const history = document.getElementById("llm-chat-history");
  const llm = payload?.llm;
  const barCloseId = payload?.barCloseId;
  if (!history || !barCloseId || !llm) return null;
  const canAppend =
    llm.enabled === true || Boolean(llm.skippedReason && String(llm.skippedReason).trim());
  if (!canAppend) return null;

  const round = buildLlmRoundElement(payload);
  ensureLlmHistorySentinel(history);
  const anchor = history.firstChild;
  if (anchor) {
    history.insertBefore(round, anchor);
  } else {
    history.appendChild(round);
  }
  history.hidden = false;
  trimLlmHistoryDom(LLM_HISTORY_MAX_DOM_ROUNDS);
  scrollLlmHistoryToTop();
  return round.querySelector(".llm-bubble--assistant");
}

async function loadAppConfig(): Promise<RendererAppConfig> {
  if (window.argus && typeof window.argus.getConfig === "function") {
    try {
      return asRendererAppConfig(await window.argus.getConfig());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        "[Argus] 拉取应用配置失败，界面将暂时使用内置默认（标的常为 BTC）。请确认服务端已启动且可访问 /api/rpc。",
        msg,
      );
    }
  }
  return FALLBACK_APP_CONFIG;
}

function applySymbolSelect(config: Pick<RendererAppConfig, "symbols" | "defaultSymbol">) {
  const sel = document.getElementById("symbol-select");
  if (!sel) return;
  sel.replaceChildren();
  for (const s of config.symbols) {
    const opt = document.createElement("option");
    opt.value = s.value;
    opt.textContent = s.label;
    sel.appendChild(opt);
  }
  const def =
    config.symbols.some((x) => x.value === config.defaultSymbol) && config.defaultSymbol
      ? config.defaultSymbol
      : config.symbols[0]?.value || "OKX:BTCUSDT";
  sel.value = def;
  window.dispatchEvent(
    new CustomEvent("argus:symbol-select-sync", {
      detail: {
        symbols: config.symbols.map((s) => ({ label: s.label, value: s.value })),
        value: def,
      },
    }),
  );
}

/**
 * 根据策略决策周期（TradingView 写法）同步原生 select 与 React Select，并写入 canonical 供 conversationKey 使用。
 * @param {string} intervalRaw
 */
function applyChartIntervalSelect(intervalRaw) {
  chartIntervalCanonical = canonTradingViewInterval(intervalRaw) || "5";
  let iv = chartIntervalCanonical;
  const sel = document.getElementById("chart-interval-select");
  if (sel instanceof HTMLSelectElement) {
    const optionValues = [...sel.options].map((o) => o.value);
    if (chartIntervalCanonical === "1D") {
      if (optionValues.includes("1D")) iv = "1D";
      else if (optionValues.includes("D")) iv = "D";
      else iv = "5";
    } else if (!optionValues.includes(iv)) {
      iv = "5";
    }
    sel.value = iv;
  }
  chartInterval = iv;
  window.dispatchEvent(new CustomEvent("argus:chart-interval-sync", { detail: { value: iv } }));
}

/**
 * 同步顶栏当前策略展示与隐藏原生 select（供内部逻辑读取）；顶栏由 React 只读展示，用户切换在仪表盘内完成。
 * @param {{ promptStrategies?: string[], promptStrategy?: string, promptStrategySelectOptions?: Array<{ value: string, label: string }> }} cfg
 */
function applyPromptStrategySelect(cfg) {
  const sel = document.getElementById("config-prompt-strategy");
  const list: string[] =
    Array.isArray(cfg?.promptStrategies) && cfg.promptStrategies.length > 0
      ? cfg.promptStrategies.map((x) => String(x))
      : [];

  const rawOpts = Array.isArray(cfg?.promptStrategySelectOptions) ? cfg.promptStrategySelectOptions : [];
  const labelEntries: [string, string][] = rawOpts
    .filter((o) => o && typeof o === "object" && typeof (o as { value?: unknown }).value === "string")
    .map((o) => {
      const r = o as { value: string; label?: unknown };
      return [String(r.value).trim(), typeof r.label === "string" ? r.label : ""] as [string, string];
    });
  const labelById = new Map<string, string>(labelEntries);

  const syncOptions = list.map((id) => ({
    value: id,
    label: formatPromptStrategyDisplayLabel(id, labelById.get(id) ?? ""),
  }));

  const cur =
    cfg?.promptStrategy && typeof cfg.promptStrategy === "string" && list.includes(cfg.promptStrategy)
      ? cfg.promptStrategy
      : list.includes("default")
        ? "default"
        : list[0] ?? "";
  if (sel) {
    sel.replaceChildren();
    if (list.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "（无策略 · 请先打开策略中心创建）";
      opt.disabled = true;
      sel.appendChild(opt);
      sel.value = "";
    } else {
      for (const row of syncOptions) {
        const opt = document.createElement("option");
        opt.value = row.value;
        opt.textContent = row.label;
        sel.appendChild(opt);
      }
      sel.value = cur || list[0] || "";
    }
  }
  window.dispatchEvent(
    new CustomEvent("argus:prompt-strategy-sync", {
      detail: {
        options: syncOptions,
        value: cur,
      },
    }),
  );
}

/**
 * 将顶栏当前策略写入本地设置；切换即生效。
 * @param {string} promptStrategy
 */
async function persistPromptStrategyPreference(promptStrategy) {
  const next = String(promptStrategy ?? "").trim();
  if (!window.argus || typeof window.argus.saveConfig !== "function") {
    applyPromptStrategySelect({
      promptStrategies: next ? [next] : [],
      promptStrategy: next,
      promptStrategySelectOptions: next
        ? [{ value: next, label: formatPromptStrategyDisplayLabel(next, next) }]
        : [],
    });
    return;
  }
  try {
    const saved = asRendererAppConfig(await window.argus.saveConfig({ promptStrategy: next }));
    applyPromptStrategySelect(saved);
    applyChartIntervalSelect(saved.promptStrategyDecisionIntervalTv ?? FALLBACK_APP_CONFIG.promptStrategyDecisionIntervalTv);
    applySymbolSelect(saved);
    createTradingViewWidget(saved.defaultSymbol, chartInterval, {
      chartIndicators:
        saved.promptStrategyChartIndicators ?? FALLBACK_APP_CONFIG.promptStrategyChartIndicators,
    });
    if (typeof window.argus.setMarketContext === "function") {
      window.argus.setMarketContext(saved.defaultSymbol);
    }
    void reloadLlmHistoryFromStore();
    refreshExchangeContextBarFromCache();
    void refreshOkxPositionBar();
    setLlmStatus(next ? `已切换策略：${saved.promptStrategy || next}` : "已清空当前策略选择");
  } catch (err) {
    console.error(err);
    setLlmStatus("切换策略失败");
  }
}



function initDevToolsButton() {
  const btn = document.getElementById("btn-open-devtools");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (window.argus && typeof window.argus.openDevTools === "function") {
      void window.argus.openDevTools();
    }
  });
}

function initFishMode() {
  const btn = document.getElementById("btn-fish-mode");
  const overlay = document.getElementById("fish-mode-overlay");
  const dismiss = document.getElementById("fish-mode-dismiss");
  if (!btn || !overlay) return;

  const setLabel = (on) => {
    const label = document.getElementById("btn-fish-mode-label");
    const next = on ? "恢复显示" : "隐私遮挡";
    if (label) label.textContent = next;
    else btn.textContent = next;
  };

  const setActive = (on) => {
    overlay.hidden = !on;
    overlay.setAttribute("aria-hidden", on ? "false" : "true");
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.classList.toggle("titlebar-config--fish-active", on);
    setLabel(on);
  };

  btn.addEventListener("click", () => {
    setActive(overlay.hidden);
  });

  if (dismiss) {
    dismiss.addEventListener("click", () => setActive(false));
  }

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || overlay.hidden) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setActive(false);
    },
    true,
  );
}

/** 与 `lib/argus-config-modal-events.ts` 中常量一致（shadcn Dialog 由 React 控制显隐） */
const ARGUS_CONFIG_MODAL_OPEN = "argus:config-modal-open";
const ARGUS_CONFIG_MODAL_CLOSE = "argus:config-modal-close";
const ARGUS_STRATEGY_MODAL_OPEN = "argus:strategy-modal-open";
const ARGUS_DASHBOARD_MODAL_OPEN = "argus:dashboard-modal-open";
const ARGUS_PROMPT_STRATEGIES_CHANGED = "argus:prompt-strategies-changed";

/** @param cfg `normalizeConfig` 返回的配置；用于配置 Dialog 表单与顶栏下拉同步。 */
function fillConfigModalFields(cfg) {
  const openaiUrlEl = document.getElementById("config-openai-base-url");
  const openaiModelEl = document.getElementById("config-openai-model");
  if (openaiUrlEl) openaiUrlEl.value = cfg.openaiBaseUrl || FALLBACK_APP_CONFIG.openaiBaseUrl;
  if (openaiModelEl) openaiModelEl.value = cfg.openaiModel || FALLBACK_APP_CONFIG.openaiModel;
  const openaiKeyEl = document.getElementById("config-openai-api-key");
  if (openaiKeyEl) openaiKeyEl.value = cfg.openaiApiKey ?? FALLBACK_APP_CONFIG.openaiApiKey;
  const reasoningEl = document.getElementById("config-llm-reasoning");
  if (reasoningEl) reasoningEl.checked = cfg.llmReasoningEnabled === true;
  const tradeNotifyEl = document.getElementById("config-trade-notify-email");
  if (tradeNotifyEl) tradeNotifyEl.checked = cfg.tradeNotifyEmailEnabled === true;
  const smtpUserEl = document.getElementById("config-smtp-user");
  const smtpPassEl = document.getElementById("config-smtp-pass");
  const notifyToEl = document.getElementById("config-notify-email-to");
  if (smtpUserEl) smtpUserEl.value = cfg.smtpUser ?? FALLBACK_APP_CONFIG.smtpUser;
  if (smtpPassEl) smtpPassEl.value = cfg.smtpPass ?? FALLBACK_APP_CONFIG.smtpPass;
  if (notifyToEl) notifyToEl.value = cfg.notifyEmailTo ?? FALLBACK_APP_CONFIG.notifyEmailTo;
  const okxEn = document.getElementById("config-okx-swap-enabled");
  const okxSim = document.getElementById("config-okx-simulated");
  if (okxEn) okxEn.checked = cfg.okxSwapTradingEnabled === true;
  if (okxSim) okxSim.checked = cfg.okxSimulated !== false;
  const okxAk = document.getElementById("config-okx-api-key");
  const okxSk = document.getElementById("config-okx-secret-key");
  const okxPh = document.getElementById("config-okx-passphrase");
  if (okxAk) okxAk.value = cfg.okxApiKey ?? FALLBACK_APP_CONFIG.okxApiKey;
  if (okxSk) okxSk.value = cfg.okxSecretKey ?? FALLBACK_APP_CONFIG.okxSecretKey;
  if (okxPh) okxPh.value = cfg.okxPassphrase ?? FALLBACK_APP_CONFIG.okxPassphrase;
  applyPromptStrategySelect(cfg);
  applyChartIntervalSelect(cfg.promptStrategyDecisionIntervalTv ?? FALLBACK_APP_CONFIG.promptStrategyDecisionIntervalTv);
}

async function applyMarketUiFromLoadedConfig(prefetched?: unknown) {
  try {
    const hasValid =
      prefetched &&
      typeof prefetched === "object" &&
      prefetched !== null &&
      typeof (prefetched as { defaultSymbol?: unknown }).defaultSymbol === "string" &&
      String((prefetched as { defaultSymbol: string }).defaultSymbol).trim().length > 0;

    const cfg = hasValid ? asRendererAppConfig(prefetched) : await loadAppConfig();

    fillConfigModalFields(cfg);
    applySymbolSelect(cfg);
    applyPromptStrategySelect(cfg);
    applyChartIntervalSelect(cfg.promptStrategyDecisionIntervalTv ?? FALLBACK_APP_CONFIG.promptStrategyDecisionIntervalTv);
    const sym = cfg.defaultSymbol || FALLBACK_APP_CONFIG.defaultSymbol;
    createTradingViewWidget(sym, chartInterval, {
      chartIndicators:
        cfg.promptStrategyChartIndicators ?? FALLBACK_APP_CONFIG.promptStrategyChartIndicators,
    });
    if (window.argus && typeof window.argus.setMarketContext === "function") {
      window.argus.setMarketContext(sym);
    }
    await reloadLlmHistoryFromStore();
    refreshExchangeContextBarFromCache();
    void refreshOkxPositionBar();
  } catch (e) {
    console.error(e);
  }
}

/** 独立于配置弹窗 DOM；策略中心保存后通过事件（可带 `detail`）刷新图表。 */
let __promptStrategiesListenerBound = false;
function initPromptStrategiesChangedListener() {
  if (__promptStrategiesListenerBound) return;
  __promptStrategiesListenerBound = true;
  window.addEventListener(ARGUS_PROMPT_STRATEGIES_CHANGED, (ev: Event) => {
    const detail = (ev as CustomEvent<unknown>).detail as unknown;
    void applyMarketUiFromLoadedConfig(detail);
  });
}

/**
 * 配置弹窗按钮用 document 委托绑定：Dialog 关闭会卸载 Portal，若只对节点 addEventListener 一次，
 * 第二次打开会是新 DOM，旧监听全丢。
 */
let __argusConfigModalDocClickBound = false;

function initConfigCenter() {
  const btnOpen = document.getElementById("btn-open-config");
  if (!btnOpen) return;

  const closeModal = () => {
    window.dispatchEvent(new CustomEvent(ARGUS_CONFIG_MODAL_CLOSE));
  };

  const openModal = async () => {
    const cfg = await loadAppConfig();
    window.dispatchEvent(new CustomEvent(ARGUS_CONFIG_MODAL_OPEN));
    const fillAfterOpen = async () => {
      fillConfigModalFields(cfg);
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void fillAfterOpen();
      });
    });
  };

  btnOpen.addEventListener("click", () => {
    void openModal();
  });

  const handleConfigModalDocumentClick = (ev) => {
    const raw = ev.target;
    if (!(raw instanceof Element)) return;
    const dlg = raw.closest('[data-slot="dialog-content"]');
    if (!dlg) return;

    const el = raw.closest(
      "#btn-config-save, #btn-config-reset, #btn-config-close, #btn-config-cancel",
    );
    if (!el) return;

    const id = el.id;

    if (id === "btn-config-close" || id === "btn-config-cancel") {
      closeModal();
      return;
    }

    if (id === "btn-config-reset") {
      ev.preventDefault();
      void (async () => {
        const ok = window.confirm(
          "将本地数据库中的应用设置恢复为代码中的默认种子。API Key、SMTP 等将清空为默认，是否继续？",
        );
        if (!ok) return;

        if (!window.argus || typeof window.argus.resetConfig !== "function") {
          fillConfigModalFields(FALLBACK_APP_CONFIG);
          applySymbolSelect(FALLBACK_APP_CONFIG);
          applyChartIntervalSelect(
            FALLBACK_APP_CONFIG.promptStrategyDecisionIntervalTv ?? "5",
          );
          createTradingViewWidget(FALLBACK_APP_CONFIG.defaultSymbol, chartInterval, {
            chartIndicators: FALLBACK_APP_CONFIG.promptStrategyChartIndicators,
          });
          if (typeof window.argus.setMarketContext === "function") {
            window.argus.setMarketContext(FALLBACK_APP_CONFIG.defaultSymbol);
          }
          setLlmStatus("已恢复界面为内置默认（非 Electron 环境不会写入磁盘）");
          refreshExchangeContextBarFromCache();
          return;
        }
        try {
          const saved = asRendererAppConfig(await window.argus.resetConfig());
          fillConfigModalFields(saved);
          applySymbolSelect(saved);
          applyChartIntervalSelect(saved.promptStrategyDecisionIntervalTv ?? FALLBACK_APP_CONFIG.promptStrategyDecisionIntervalTv);
          createTradingViewWidget(saved.defaultSymbol, chartInterval, {
            chartIndicators:
              saved.promptStrategyChartIndicators ?? FALLBACK_APP_CONFIG.promptStrategyChartIndicators,
          });
          if (typeof window.argus.setMarketContext === "function") {
            window.argus.setMarketContext(saved.defaultSymbol);
          }
          setLlmStatus("配置已恢复默认");
          refreshExchangeContextBarFromCache();
        } catch (err) {
          console.error(err);
          setLlmStatus("恢复默认配置失败");
        }
      })();
      return;
    }

    if (id === "btn-config-save") {
      ev.preventDefault();
      void (async () => {
        const openaiUrlEl = document.getElementById("config-openai-base-url");
        const openaiModelEl = document.getElementById("config-openai-model");
        const openaiKeyEl = document.getElementById("config-openai-api-key");
        const openaiBaseUrl = openaiUrlEl?.value?.trim() ?? "";
        const openaiModel = openaiModelEl?.value?.trim() ?? "";
        const openaiApiKey = openaiKeyEl?.value?.trim() ?? "";
        const reasoningEl = document.getElementById("config-llm-reasoning");
        const llmReasoningEnabled = reasoningEl?.checked === true;
        const tradeNotifyEl = document.getElementById("config-trade-notify-email");
        const tradeNotifyEmailEnabled = tradeNotifyEl?.checked === true;
        const smtpUserEl = document.getElementById("config-smtp-user");
        const smtpPassEl = document.getElementById("config-smtp-pass");
        const notifyToEl = document.getElementById("config-notify-email-to");
        const smtpUser = smtpUserEl?.value?.trim() ?? "";
        const smtpPass = smtpPassEl?.value?.trim() ?? "";
        const notifyEmailTo = notifyToEl?.value?.trim() ?? "";
        const okxEn = document.getElementById("config-okx-swap-enabled");
        const okxSim = document.getElementById("config-okx-simulated");
        const okxAk = document.getElementById("config-okx-api-key");
        const okxSk = document.getElementById("config-okx-secret-key");
        const okxPh = document.getElementById("config-okx-passphrase");
        const okxSwapTradingEnabled = okxEn?.checked === true;
        const okxSimulated = okxSim?.checked !== false;
        const okxApiKey = okxAk?.value?.trim() ?? "";
        const okxSecretKey = okxSk?.value?.trim() ?? "";
        const okxPassphrase = okxPh?.value?.trim() ?? "";

        if (!window.argus || typeof window.argus.saveConfig !== "function") {
          const cfg = await loadAppConfig();
          applySymbolSelect(cfg);
          createTradingViewWidget(cfg.defaultSymbol, chartInterval, {
            chartIndicators:
              cfg.promptStrategyChartIndicators ?? FALLBACK_APP_CONFIG.promptStrategyChartIndicators,
          });
          closeModal();
          refreshExchangeContextBarFromCache();
          void refreshOkxPositionBar();
          return;
        }
        try {
          const saved = asRendererAppConfig(
            await window.argus.saveConfig({
              openaiBaseUrl,
              openaiModel,
              openaiApiKey,
              llmReasoningEnabled,
              tradeNotifyEmailEnabled,
              smtpUser,
              smtpPass,
              notifyEmailTo,
              okxSwapTradingEnabled,
              okxSimulated,
              okxApiKey,
              okxSecretKey,
              okxPassphrase,
            }),
          );
          applySymbolSelect(saved);
          applyChartIntervalSelect(saved.promptStrategyDecisionIntervalTv ?? FALLBACK_APP_CONFIG.promptStrategyDecisionIntervalTv);
          createTradingViewWidget(saved.defaultSymbol, chartInterval, {
            chartIndicators:
              saved.promptStrategyChartIndicators ?? FALLBACK_APP_CONFIG.promptStrategyChartIndicators,
          });
          if (typeof window.argus.setMarketContext === "function") {
            window.argus.setMarketContext(saved.defaultSymbol);
          }
          closeModal();
          refreshExchangeContextBarFromCache();
          void refreshOkxPositionBar();
        } catch (err) {
          console.error(err);
          setLlmStatus("保存配置失败");
        }
      })();
    }
  };

  if (!__argusConfigModalDocClickBound) {
    __argusConfigModalDocClickBound = true;
    document.addEventListener("click", handleConfigModalDocumentClick);
  }
}

function initStrategyCenter() {
  const btn = document.getElementById("btn-open-strategy-center");
  if (!btn) return;
  btn.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent(ARGUS_STRATEGY_MODAL_OPEN));
  });
}

function initDashboardModal() {
  const btn = document.getElementById("btn-open-dashboard");
  if (!btn) return;
  btn.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent(ARGUS_DASHBOARD_MODAL_OPEN));
  });
}

function destroyWidget() {
  for (const widget of tvWidgets.values()) {
    if (widget && typeof widget.remove === "function") {
      try {
        widget.remove();
      } catch {
        /* ignore */
      }
    }
  }
  tvWidgets = new Map();
  for (const spec of MULTI_TIMEFRAME_SPECS) {
    const el = document.getElementById(spec.containerId);
    if (el) el.innerHTML = "";
  }
}

function createTradingViewWidgetNow(symbol, _interval) {
  destroyWidget();

  if (typeof TradingView === "undefined" || !TradingView.widget) {
    for (const spec of MULTI_TIMEFRAME_SPECS) {
      const el = document.getElementById(spec.containerId);
      if (el) {
        el.innerHTML =
          '<p style="padding:16px;color:#f85149;font-size:13px;">无法加载 TradingView 脚本，请检查网络或 CSP。</p>';
      }
    }
    return;
  }

  const tvSymbol = normalizeTradingViewSymbolForPerp(symbol || "OKX:BTCUSDT");
  const tvStudies = tradingViewStudiesFromChartIndicators(lastTvWidgetRequest.chartIndicators);
  /**
   * tv.js（免费 Advanced Chart）里与「隐藏界面」相关的选项主要来自官方 embed：
   *
   * - hide_top_toolbar：顶部栏（品种搜索、周期、布局等）
   * - hide_side_toolbar：左侧竖条绘图/工具栏（画线、斐波那契等）
   * - hide_legend：主图左上角 OHLC 等图例
   * - hide_volume：底部成交量副图
   * - hideideasbutton：图表上的 Ideas 相关按钮（注意：不是 hideideas；源码里 URL 还会带 hideideas 参数）
   *
   * 另：save_image 为 false 时可关闭保存图片；show_popup_button 控制弹出大图等。
   * enabled_features / disabled_features 会传给 iframe，主要给 Charting Library 用，免费 embed 是否生效因版本而异。
   */
  for (const spec of MULTI_TIMEFRAME_SPECS) {
    const widget = new TradingView.widget({
      autosize: true,
      symbol: tvSymbol,
      interval: spec.interval,
      timezone: "Asia/Shanghai",
      theme: "dark",
      style: "1",
      locale: "zh_CN",
      toolbar_bg: "#161b22",
      enable_publishing: false,
      hide_top_toolbar: true,
      hide_side_toolbar: true,
      hide_legend: true,
      hide_volume: tvStudies.hide_volume,
      hideideasbutton: true,
      /** 为 false 时 iframe 可能拒绝 imageCanvas 截图，需保留导出能力 */
      save_image: true,
      container_id: spec.containerId,
      allow_symbol_change: true,
      studies: tvStudies.studies,
    });
    tvWidgets.set(spec.interval, widget);
  }
}

function createTradingViewWidget(
  symbol,
  interval,
  options: { chartIndicators?: import("@shared/strategy-fields").StrategyChartIndicatorId[] } = {},
) {
  scheduleTradingViewWidget(symbol, interval, options);
}

function initSymbolSelect() {
  // 图表标的由当前策略在「策略中心」绑定的代币决定，不从顶栏另行切换或持久化。
}

function initChartIntervalSelect() {
  const sel = document.getElementById("chart-interval-select");
  if (!(sel instanceof HTMLSelectElement)) return;
  sel.addEventListener("change", () => {
    const symEl = document.getElementById("symbol-select");
    const sym = symEl?.value?.trim() || "OKX:BTCUSDT";
    applyChartIntervalSelect(chartIntervalCanonical);
    setLlmStatus("主周期由当前策略「决策时间」决定，请在策略中心修改");
    createTradingViewWidget(sym, chartInterval);
    void reloadLlmHistoryFromStore();
    refreshExchangeContextBarFromCache();
    void refreshOkxPositionBar();
  });
}

function initPromptStrategySelect() {
  const sel = document.getElementById("config-prompt-strategy");
  if (!sel) return;
  sel.addEventListener("change", () => {
    void persistPromptStrategyPreference(sel.value);
  });
}

/**
 * 助手气泡展示用：模型与流式接口常在行首或段间输出 \\n\\n；配合 CSS pre-wrap 会原样显示，看起来像「多出一行」或双倍段距。
 */
function normalizeAssistantDisplayText(s: unknown): string {
  if (s == null || s === "") return "";
  return String(s)
    .replace(/\r\n/g, "\n")
    .replace(/^\n+/, "")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * 右侧「状态」徽章用短标签（约 2～4 字），完整句子由元素 title 展示。
 */
function shortLlmStatusLabel(full: string | null | undefined): string {
  const t = String(full ?? "").trim();
  if (!t) return "就绪";

  const rules: ReadonlyArray<readonly [(s: string) => boolean, string]> = [
    [(s) => s.includes("LLM 输出中"), "分析中"],
    [(s) => s.includes("收盘（截图异常）"), "截图异常"],
    [(s) => s.includes("收盘 · LLM 已分析"), "已分析"],
    [(s) => s.includes("收盘 · LLM 失败"), "分析失败"],
    [(s) => s.includes("收盘 · Agent 已跳过"), "已跳过"],
    [(s) => s.includes("K 线收盘已采集"), "已采集"],
    [(s) => s.startsWith("OKX WS · K 收盘"), "WS收盘"],
    [(s) => s.startsWith("收盘处理失败"), "处理失败"],
    [(s) => s.includes("WS 断开") && s.includes("重连"), "WS重连"],
    [(s) => s.startsWith("OKX WS 已连接"), "WS已连"],
    [(s) => s.includes("无效 OKX"), "代码无效"],
    [(s) => s.startsWith("OKX："), "OKX异常"],
    [(s) => s.includes("请使用 OKX:") || (s.includes("OKX:") && s.includes("前缀")), "前缀无效"],
    [(s) => s.includes("需为 OKX:") && s.includes("订阅行情"), "无行情"],
    [(s) => s.includes("已恢复界面为内置默认"), "已恢复"],
    [(s) => s === "配置已恢复默认", "已恢复"],
    [(s) => s.includes("恢复默认配置失败"), "恢复失败"],
    [(s) => s === "保存配置失败", "保存失败"],
    [(s) => s === "就绪", "就绪"],
  ];

  for (const [pred, label] of rules) {
    if (pred(t)) return label;
  }
  if (t.length <= 6) return t;
  return `${t.slice(0, 5)}…`;
}

/** 主进程或本页逻辑写入的完整状态句 */
function setLlmStatus(text: string | null | undefined): void {
  const el = document.getElementById("llm-status");
  if (!el) return;
  const full = String(text ?? "").trim() || "就绪";
  el.textContent = shortLlmStatusLabel(full);
  el.title = full;
}

function openLlmChartPreview(dataUrl) {
  const modal = document.getElementById("llm-chart-preview-modal");
  const img = document.getElementById("llm-chart-preview-img");
  if (!modal || !img || !dataUrl) return;
  img.src = dataUrl;
  img.alt = "本轮 K 线收盘时的图表截图";
  modal.hidden = false;
}

function closeLlmChartPreview() {
  const modal = document.getElementById("llm-chart-preview-modal");
  const img = document.getElementById("llm-chart-preview-img");
  if (modal) modal.hidden = true;
  if (img) {
    img.removeAttribute("src");
    img.alt = "";
  }
}

function initLlmChartPreview() {
  const modal = document.getElementById("llm-chart-preview-modal");
  const btn = document.getElementById("btn-llm-chart-preview-close");
  if (!modal) return;
  const close = () => closeLlmChartPreview();
  btn?.addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (modal.hidden) return;
    close();
  });
}

function currentUiTvSymbol() {
  const sel = document.getElementById("symbol-select");
  if (!sel || typeof sel.value !== "string") return "";
  return sel.value.trim();
}

function tvSymbolsDiffer(desired, current) {
  return String(desired || "").trim() !== String(current || "").trim();
}

/** 按钮「测试截图」：纯本页 captureMultiTimeframeCharts，不走 HTTP/RPC，避免与 WS 截图回传互相等死。 */
function initLocalChartTestListener() {
  if (typeof window === "undefined") return;
  window.addEventListener("argus:test-chart-capture-local", () => {
    void (async () => {
      try {
        const shot = await captureMultiTimeframeCharts();
        window.dispatchEvent(
          new CustomEvent("argus:test-chart-capture-result", {
            detail: {
              ok: true,
              mimeType: shot.mimeType,
              dataUrl: shot.dataUrl,
              base64: shot.base64,
              charts: shot.charts,
            },
          }),
        );
      } catch (e) {
        window.dispatchEvent(
          new CustomEvent("argus:test-chart-capture-result", {
            detail: {
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            },
          }),
        );
      }
    })();
  });
}

function initChartCaptureBridge() {
  if (!window.argus?.onChartCaptureRequest || !window.argus?.submitChartCaptureResult) {
    return;
  }
  window.argus.onChartCaptureRequest(async (payload) => {
    const requestId = payload?.requestId;
    const tvSymbol = typeof payload?.tvSymbol === "string" ? payload.tvSymbol.trim() : "";
    if (!requestId) return;
    try {
      if (
        tvSymbol &&
        tvSymbolsDiffer(tvSymbol, currentUiTvSymbol()) &&
        typeof window.argus?.setMarketContext === "function"
      ) {
        await window.argus.setMarketContext(tvSymbol);
        scheduleTradingViewWidget(tvSymbol, chartInterval, { debounceMs: 120 });
        const readyDeadline = Date.now() + 18000;
        while (Date.now() < readyDeadline) {
          try {
            await captureTradingViewPng("5");
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 400));
          }
        }
      }
      const mtRaw = payload?.marketTimeframes;
      const selectedIntervals = Array.isArray(mtRaw)
        ? mtRaw.map((x) => String(x ?? "").trim()).filter(Boolean)
        : undefined;
      const shot = await captureMultiTimeframeCharts(selectedIntervals);
      window.argus.submitChartCaptureResult({
        requestId,
        ok: true,
        mimeType: shot.mimeType,
        base64: shot.base64,
        dataUrl: shot.dataUrl,
        charts: shot.charts,
      });
    } catch (e) {
      window.argus.submitChartCaptureResult({
        requestId,
        ok: false,
        error: e instanceof Error ? e.message || String(e) : String(e),
      });
    }
  });
}

function bindMarketBarClose() {
  if (typeof window.argus === "undefined" || !window.argus.onMarketBarClose) {
    return;
  }
  window.argus.onMarketBarClose((payload) => {
    latestBarCloseId = payload?.barCloseId ?? null;
    window.argusLastBarClose = payload;
    if (payload?.chartImage?.dataUrl) {
      setLastChartScreenshot(payload.chartImage.dataUrl);
    }

    if (payload?.conversationKey && payload?.exchangeContext) {
      rememberExchangeContext(payload.conversationKey, payload.exchangeContext);
      if (payload.conversationKey === currentConversationKeyForUi()) {
        updateOkxBarFromExchangeContext(payload.exchangeContext);
      }
    }

    const llm = payload?.llm;
    const showRound =
      llm &&
      (Boolean(llm.skippedReason && String(llm.skippedReason).trim()) ||
        (llm.enabled === true &&
          (llm.streaming === true ||
            Boolean(llm.analysisText) ||
            Boolean(llm.error))));
    if (showRound) {
      appendLlmRound(payload);
    }

    if (llm?.skippedReason && String(llm.skippedReason).trim()) {
      setLlmStatus("收盘 · Agent 已跳过");
    } else if (payload?.chartCaptureError) {
      setLlmStatus("收盘（截图异常）");
    } else if (llm?.enabled && llm.streaming) {
      setLlmStatus("LLM 输出中…");
    } else if (llm?.enabled && llm.analysisText) {
      setLlmStatus("收盘 · LLM 已分析");
    } else if (llm?.enabled && llm.error) {
      setLlmStatus("收盘 · LLM 失败");
    } else {
      setLlmStatus("K 线收盘已采集");
    }
  });
}

function bindLlmStream() {
  if (typeof window.argus === "undefined") return;
  const { onLlmStreamDelta, onLlmStreamEnd, onLlmStreamError } = window.argus;
  if (typeof onLlmStreamDelta === "function") {
    onLlmStreamDelta(({ barCloseId, full, reasoningFull, toolFull }) => {
      const bubbleAsst = findAssistantBubbleForBar(barCloseId);
      const bubbleReas = findReasoningBubbleForBar(barCloseId);
      const bubbleTool = findToolBubbleForBar(barCloseId);
      if (!bubbleAsst && !bubbleReas && !bubbleTool) return;
      if (bubbleReas && reasoningFull != null) {
        bubbleReas.textContent = normalizeAssistantDisplayText(String(reasoningFull));
      }
      if (bubbleTool) {
        bubbleTool.textContent = toolFull ? normalizeAssistantDisplayText(String(toolFull)) : "";
        if (bubbleTool.parentElement?.parentElement) {
          bubbleTool.parentElement.parentElement.hidden = !toolFull;
        }
      }
      if (bubbleAsst) {
        bubbleAsst.textContent = normalizeAssistantDisplayText(full);
        bubbleAsst.classList.remove("llm-bubble--error");
      }
      if (barCloseId === latestBarCloseId) {
        setLlmStatus("LLM 输出中…");
      }
      const history = document.getElementById("llm-chat-history");
      if (history) history.scrollTop = history.scrollHeight;
    });
  }
  if (typeof onLlmStreamEnd === "function") {
    onLlmStreamEnd(
      ({ barCloseId, analysisText, cardSummary, reasoningText, toolTrace, conversationKey, exchangeContext }) => {
      const bubbleAsst = findAssistantBubbleForBar(barCloseId);
      const display = resolveAssistantAndToolDisplay({ analysisText, toolTrace });
      if (bubbleAsst && analysisText != null) {
        bubbleAsst.textContent = normalizeAssistantDisplayText(display.assistantText);
        bubbleAsst.classList.remove("llm-bubble--error");
      }
      const bubbleReas = findReasoningBubbleForBar(barCloseId);
      if (bubbleReas && reasoningText != null) {
        bubbleReas.textContent = normalizeAssistantDisplayText(String(reasoningText));
      }
      const bubbleTool = findToolBubbleForBar(barCloseId);
      if (bubbleTool) {
        bubbleTool.textContent = display.toolText ? normalizeAssistantDisplayText(display.toolText) : "";
        if (bubbleTool.parentElement?.parentElement) {
          bubbleTool.parentElement.parentElement.hidden = !display.toolText;
        }
      }
      syncLlmRoundTradeStrips(barCloseId, toolTrace, "idle", { analysisText, cardSummary });
      syncLlmRoundCardNoteFromPayload(barCloseId, { skippedReason: null, error: null, streaming: false });
      if (conversationKey && exchangeContext) {
        rememberExchangeContext(conversationKey, exchangeContext);
        if (conversationKey === currentConversationKeyForUi()) {
          updateOkxBarFromExchangeContext(exchangeContext);
        }
      }
      updateLlmRoundAfterAgentFinished(barCloseId, "ok");
      if (barCloseId !== latestBarCloseId) return;
      if (window.argusLastBarClose?.llm) {
        window.argusLastBarClose.llm.analysisText = analysisText;
        window.argusLastBarClose.llm.cardSummary =
          cardSummary != null && String(cardSummary).trim() ? String(cardSummary).trim() : null;
        window.argusLastBarClose.llm.toolTrace = Array.isArray(toolTrace) ? toolTrace : [];
        window.argusLastBarClose.llm.reasoningText = reasoningText ?? "";
        window.argusLastBarClose.llm.streaming = false;
        window.argusLastBarClose.llm.error = null;
      }
      if (window.argusLastBarClose && exchangeContext) {
        window.argusLastBarClose.exchangeContext = exchangeContext;
      }
      setLlmStatus("收盘 · LLM 已分析");
    },
    );
  }
  if (typeof onLlmStreamError === "function") {
    onLlmStreamError(({ barCloseId, message, toolTrace }) => {
      const bubbleAsst = findAssistantBubbleForBar(barCloseId);
      if (bubbleAsst) {
        bubbleAsst.textContent = message || "错误";
        bubbleAsst.classList.add("llm-bubble--error");
      }
      const bubbleTool = findToolBubbleForBar(barCloseId);
      const toolText = formatToolTraceDisplay(toolTrace);
      if (bubbleTool) {
        bubbleTool.textContent = toolText ? normalizeAssistantDisplayText(toolText) : "";
        if (bubbleTool.parentElement?.parentElement) {
          bubbleTool.parentElement.parentElement.hidden = !toolText;
        }
      }
      syncLlmRoundTradeStrips(barCloseId, toolTrace, "error", {
        error: message && String(message).trim() ? String(message).trim() : "错误",
      });
      syncLlmRoundCardNoteFromPayload(barCloseId, {
        skippedReason: null,
        error: message && String(message).trim() ? String(message).trim() : "错误",
        streaming: false,
      });
      updateLlmRoundAfterAgentFinished(barCloseId, "err");
      if (barCloseId !== latestBarCloseId) return;
      if (window.argusLastBarClose?.llm) {
        window.argusLastBarClose.llm.error = message;
        window.argusLastBarClose.llm.streaming = false;
        window.argusLastBarClose.llm.analysisText = null;
        window.argusLastBarClose.llm.toolTrace = Array.isArray(toolTrace) ? toolTrace : [];
      }
      setLlmStatus("收盘 · LLM 失败");
    });
  }
}

function bindMarketStatus() {
  if (typeof window.argus === "undefined" || !window.argus.onMarketStatus) {
    return;
  }
  window.argus.onMarketStatus((payload) => {
    if (payload?.text) setLlmStatus(payload.text);
  });
}

function formatOkxPositionLine(r: OkxSwapPositionSnapshot | null | undefined): string {
  if (!r) return "—";
  if (r.skipped && r.reason === "not_okx_chart") return "";
  if (r.skipped && r.reason === "okx_swap_disabled") {
    return "未启用 OKX 永续下单；在配置中开启后可显示交易所持仓。";
  }
  if (r.ok === false) return r.message || "查询失败";
  const sim = r.simulated !== false ? "模拟" : "实盘";
  const id = r.instId || "";
  const f = r.fields;
  if (!r.hasPosition || !f) {
    return `${sim} · ${id} · 当前无持仓`;
  }
  const dir = r.posNum > 0 ? "多" : r.posNum < 0 ? "空" : "—";
  const contracts = f.pos != null ? String(f.pos) : String(r.absContracts ?? "");
  const upl = f.upl != null && f.upl !== "" ? ` · 未实现盈亏 ${f.upl}` : "";
  const avg = f.avgPx != null && f.avgPx !== "" ? ` · 开仓均价 ${f.avgPx}` : "";
  const mark = f.markPx != null && f.markPx !== "" ? ` · 标记 ${f.markPx}` : "";
  const lev = f.lever != null && f.lever !== "" ? ` · ${f.lever}x` : "";
  return `${sim} · ${f.instId || id} · ${dir} ${contracts} 张${lev}${avg}${mark}${upl}`;
}

function currentOkxSymbolLabel() {
  const sel = document.getElementById("symbol-select");
  const sym = sel?.value?.trim() || "";
  return sym.startsWith("OKX:") ? sym.slice(4) : sym || "—";
}

function formatCompactValue(v, options: { signed?: boolean; suffix?: string } = {}) {
  if (v == null) return "—";
  const raw = String(v).trim();
  if (!raw) return "—";
  const n = Number(raw);
  if (!Number.isFinite(n)) return `${raw}${options.suffix || ""}`;
  const abs = Math.abs(n);
  const maxDigits = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
  const out = n.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDigits,
  });
  const prefix = options.signed && n > 0 ? "+" : "";
  return `${prefix}${out}${options.suffix || ""}`;
}

function parseLooseNumericText(s: string | null | undefined): number | null {
  if (s == null) return null;
  const t = s
    .replace(/\s/g, "")
    .replace(/,/g, "")
    .replace(/^\+/, "")
    .replace(/\u2212/g, "-")
    .trim();
  if (!t || t === "—") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

let okxUplCountUp: CountUp | null = null;
/** 最近一次已落稳的未实现盈亏数值（用于下一次滚动的起点）。 */
let lastOkxUplNumeric: number | null = null;
let okxUplAnimGen = 0;

function teardownOkxUplCountUp() {
  okxUplCountUp?.onDestroy();
  okxUplCountUp = null;
}

function setOkxPanelUplPlain(text: string, tone: "positive" | "negative" | "neutral" = "neutral") {
  teardownOkxUplCountUp();
  okxUplAnimGen += 1;
  const el = document.getElementById("okx-position-upl");
  if (!el) return;
  setOkxPnlTone(tone);
  el.textContent = text;
  if (text === "—") lastOkxUplNumeric = null;
  else {
    const n = parseLooseNumericText(text);
    lastOkxUplNumeric = n;
  }
}

function setOkxPanelUplAnimated(
  endRaw: unknown,
  tone: "positive" | "negative" | "neutral",
  options: { duration?: number } = {},
) {
  const el = document.getElementById("okx-position-upl");
  if (!el) return;

  const endNum = Number(String(endRaw ?? "").trim());
  if (!Number.isFinite(endNum)) {
    setOkxPanelUplPlain("—", "neutral");
    return;
  }

  setOkxPnlTone(tone);

  let startNum: number | null = null;
  const active = okxUplCountUp;
  if (active && active.el === el && Number.isFinite(active.frameVal)) {
    startNum = active.frameVal;
  }
  if (startNum == null && lastOkxUplNumeric != null && Number.isFinite(lastOkxUplNumeric)) {
    startNum = lastOkxUplNumeric;
  }
  if (startNum == null) {
    startNum = parseLooseNumericText(el.textContent);
  }

  teardownOkxUplCountUp();

  const instant = startNum == null || !Number.isFinite(startNum) || startNum === endNum;
  if (instant) {
    okxUplAnimGen += 1;
    el.textContent = formatCompactValue(String(endRaw), { signed: true });
    lastOkxUplNumeric = endNum;
    return;
  }

  const gen = ++okxUplAnimGen;
  const duration = options.duration ?? 0.9;
  okxUplCountUp = new CountUp(el, endNum, {
    startVal: startNum,
    duration,
    decimalPlaces: 6,
    useEasing: true,
    formattingFn: (n) => formatCompactValue(String(n), { signed: true }),
    onCompleteCallback: () => {
      if (gen === okxUplAnimGen) lastOkxUplNumeric = endNum;
    },
  });
  if (okxUplCountUp.error) {
    el.textContent = formatCompactValue(String(endRaw), { signed: true });
    lastOkxUplNumeric = endNum;
    okxUplCountUp = null;
    return;
  }
  okxUplCountUp.start();
}

function setOkxPanelText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
  return el;
}

function setOkxPanelTitle(id, text) {
  const el = document.getElementById(id);
  if (!el) return null;
  const title = typeof text === "string" ? text.trim() : "";
  if (title) el.setAttribute("title", title);
  else el.removeAttribute("title");
  return el;
}

function setOkxSideTone(kind) {
  const el = document.getElementById("okx-position-side");
  if (!el) return;
  const map = {
    long: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    short: "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    neutral: "border-border/70 bg-background/70 text-foreground",
    loading: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    danger: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300",
  };
  el.className = `inline-flex items-center rounded-full border px-2.5 py-1 text-[12px] font-semibold ${map[kind] || map.neutral}`;
}

function setOkxPnlTone(kind) {
  const el = document.getElementById("okx-position-upl");
  if (!el) return;
  const map = {
    positive: "mt-1 text-4xl leading-none font-semibold tracking-tight text-emerald-700 dark:text-emerald-300",
    negative: "mt-1 text-4xl leading-none font-semibold tracking-tight text-rose-700 dark:text-rose-300",
    neutral: "mt-1 text-4xl leading-none font-semibold tracking-tight text-foreground",
  };
  el.className = map[kind] || map.neutral;
}

function setOkxHeroTone(kind) {
  const shell = document.getElementById("okx-position-shell");
  if (!shell) return;
  const map = {
    long:
      "rounded-2xl border px-4 py-4 text-xs text-foreground shadow-md bg-card border-emerald-500/30",
    short:
      "rounded-2xl border px-4 py-4 text-xs text-foreground shadow-md bg-card border-rose-500/30",
    neutral:
      "rounded-2xl border px-4 py-4 text-xs text-foreground shadow-md bg-card border-border/80",
    loading:
      "rounded-2xl border px-4 py-4 text-xs text-foreground shadow-md bg-card border-sky-500/30",
    danger:
      "rounded-2xl border px-4 py-4 text-xs text-foreground shadow-md bg-card border-red-500/30",
  };
  shell.className = map[kind] || map.neutral;
}

function summarizePlainOrders(plain) {
  const list = Array.isArray(plain) ? plain : [];
  if (list.length === 0) return "0 笔";
  return `${list.length} 笔`;
}

function formatPlainOrdersTooltip(plain) {
  const list = Array.isArray(plain) ? plain : [];
  if (list.length === 0) return "";
  return list
    .map((row, idx) => {
      const main = formatOnePlainPendingBrief(row);
      const state =
        row && typeof row === "object" && row.state != null && String(row.state).trim() !== ""
          ? ` · ${String(row.state).trim()}`
          : "";
      const filled =
        row && typeof row === "object" && row.accFillSz != null && String(row.accFillSz).trim() !== ""
          ? ` · 已成交 ${String(row.accFillSz).trim()}`
          : "";
      return `${idx + 1}. ${main}${state}${filled}`;
    })
    .join("\n");
}

function formatAlgoSummaryLine(row) {
  if (!row || typeof row !== "object") return "";
  const parts = [];
  if (row.tpTriggerPx != null && String(row.tpTriggerPx).trim() !== "") {
    parts.push(`TP ${String(row.tpTriggerPx).trim()}`);
  }
  if (row.slTriggerPx != null && String(row.slTriggerPx).trim() !== "") {
    parts.push(`SL ${String(row.slTriggerPx).trim()}`);
  }
  if (!parts.length && row.triggerPx != null && String(row.triggerPx).trim() !== "") {
    parts.push(`触发 ${String(row.triggerPx).trim()}`);
  }
  return parts.join(" / ");
}

function pickAlgoTriggerValue(algo, key) {
  const list = Array.isArray(algo) ? algo : [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const raw = row[key];
    if (raw != null && String(raw).trim() !== "") return String(raw).trim();
  }
  return "";
}

function summarizeAlgoOrders(algo) {
  const list = Array.isArray(algo) ? algo : [];
  if (list.length === 0) return "0 笔";
  const lines = list.map(formatAlgoSummaryLine).filter(Boolean);
  if (!lines.length) return `${list.length} 笔`;
  return `${list.length} 笔 · ${lines.slice(0, 2).join(" ｜ ")}${lines.length > 2 ? " …" : ""}`;
}

function renderOkxPositionSnapshot(
  r: OkxSwapPositionSnapshot | null | undefined,
  options: { sourceText?: string; footnote?: string; titlePayload?: unknown } = {},
) {
  const bar = document.getElementById("okx-position-bar");
  if (!bar) return;
  const sourceText = options.sourceText || "实时查询";
  const fallbackSymbol = currentOkxSymbolLabel();
  const modeText = r?.simulated !== false ? "模拟盘" : "实盘";
  const instText = r?.fields?.instId || r?.instId || fallbackSymbol;
  const pendingOrders = Array.isArray(r?.pending_orders) ? r.pending_orders : [];
  const pendingAlgoOrders = Array.isArray(r?.pending_algo_orders) ? r.pending_algo_orders : [];
  const tpValue = pickAlgoTriggerValue(pendingAlgoOrders, "tpTriggerPx");
  const slValue = pickAlgoTriggerValue(pendingAlgoOrders, "slTriggerPx");

  setOkxHeroTone("neutral");
  setOkxPanelText("okx-position-mode", modeText);
  setOkxPanelText("okx-position-symbol", instText || fallbackSymbol || "—");
  setOkxPanelText("okx-position-source", sourceText);
  setOkxPanelText("okx-position-status-copy", "等待同步");
  setOkxPanelText("okx-position-size", "—");
  setOkxPanelText("okx-position-entry", "—");
  setOkxPanelText("okx-position-mark", "—");
  setOkxPanelText("okx-position-tp", tpValue || "未设");
  setOkxPanelText("okx-position-sl", slValue || "未设");
  setOkxPanelText("okx-position-orders", summarizePlainOrders(pendingOrders));
  setOkxPanelText("okx-position-orders-sub", pendingOrders.length > 0 ? "悬浮查看挂单详情" : "当前无普通挂单");
  setOkxPanelText("okx-position-algos", summarizeAlgoOrders(pendingAlgoOrders));
  setOkxPanelTitle("okx-position-orders", formatPlainOrdersTooltip(pendingOrders));
  setOkxPanelTitle("okx-position-algos", pendingAlgoOrders.map(formatOneAlgoPendingBrief).filter(Boolean).join("\n"));
  setOkxPnlTone("neutral");

  if (!r) {
    setOkxHeroTone("neutral");
    setOkxSideTone("neutral");
    setOkxPanelUplPlain("—");
    setOkxPanelText("okx-position-side", "—");
    setOkxPanelText("okx-position-status-copy", "暂无数据");
    setOkxPanelText("okx-position-text", options.footnote || "暂无 OKX 数据");
    bar.title = typeof options.titlePayload === "string" ? options.titlePayload : "暂无 OKX 数据";
    return;
  }

  if (r.skipped && r.reason === "not_okx_chart") {
    bar.hidden = true;
    return;
  }

  if (r.skipped && r.reason === "okx_swap_disabled") {
    setOkxHeroTone("neutral");
    setOkxSideTone("neutral");
    setOkxPanelUplPlain("—");
    setOkxPanelText("okx-position-side", "未启用");
    setOkxPanelText("okx-position-status-copy", "未启用");
    setOkxPanelText("okx-position-text", options.footnote || "未启用 OKX 永续下单；在配置中开启后可显示交易所持仓。");
    bar.title = "OKX 永续未启用";
    return;
  }

  if (r.ok === false) {
    setOkxHeroTone("danger");
    setOkxSideTone("danger");
    setOkxPanelUplPlain("—");
    setOkxPanelText("okx-position-side", "异常");
    setOkxPanelText("okx-position-status-copy", "查询失败");
    setOkxPanelText("okx-position-text", options.footnote || r.message || "查询失败");
    bar.title = typeof options.titlePayload === "string" ? options.titlePayload : JSON.stringify(options.titlePayload ?? r, null, 2);
    return;
  }

  const f = r.fields;
  if (!r.hasPosition || !f) {
    setOkxHeroTone("neutral");
    setOkxSideTone("neutral");
    setOkxPanelText("okx-position-side", "空仓");
    setOkxPanelText("okx-position-status-copy", "当前空仓");
    setOkxPanelText("okx-position-size", "0 张");
    setOkxPanelUplAnimated(0, "neutral");
    setOkxPanelText("okx-position-entry", "—");
    setOkxPanelText("okx-position-mark", "—");
    setOkxPanelText("okx-position-text", options.footnote || formatOkxPositionLine(r));
    bar.title = JSON.stringify(options.titlePayload ?? { position: r?.fields ?? null, pending_orders: pendingOrders, pending_algo_orders: pendingAlgoOrders }, null, 2);
    return;
  }

  const isLong = Number(r.posNum) > 0;
  const isShort = Number(r.posNum) < 0;
  setOkxHeroTone(isLong ? "long" : isShort ? "short" : "neutral");
  setOkxSideTone(isLong ? "long" : isShort ? "short" : "neutral");
  setOkxPanelText("okx-position-side", isLong ? "多头" : isShort ? "空头" : "持仓");
  setOkxPanelText("okx-position-status-copy", isLong ? "Long Exposure" : isShort ? "Short Exposure" : "Position Open");
  setOkxPanelText("okx-position-size", `${formatCompactValue(f.pos ?? r.absContracts)} 张`);
  const uplNum = Number(f.upl);
  setOkxPanelUplAnimated(
    f.upl,
    !Number.isFinite(uplNum) ? "neutral" : uplNum > 0 ? "positive" : uplNum < 0 ? "negative" : "neutral",
  );
  setOkxPanelText("okx-position-entry", formatCompactValue(f.avgPx));
  setOkxPanelText(
    "okx-position-mark",
    [formatCompactValue(f.markPx), f.lever != null && String(f.lever).trim() !== "" ? `${String(f.lever).trim()}x` : ""]
      .filter(Boolean)
      .join(" / "),
  );
  setOkxPanelText("okx-position-text", options.footnote || `${formatOkxPositionLine(r)} ｜ ${formatPendingOrdersSummaryLine(pendingOrders, pendingAlgoOrders)}`);
  bar.title = JSON.stringify(
    options.titlePayload ?? {
      position: r?.fields ?? null,
      pending_orders: pendingOrders,
      pending_algo_orders: pendingAlgoOrders,
    },
    null,
    2,
  );
}

async function refreshOkxPositionBar() {
  const bar = document.getElementById("okx-position-bar");
  const sel = document.getElementById("symbol-select");
  if (!bar || !sel) return;
  const sym = sel.value?.trim() || "";
  if (!sym.startsWith("OKX:")) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  // Stale-while-revalidate：不清空上一轮文案，仅用边框表示刷新中。
  setOkxHeroTone("loading");
  if (!window.argus || typeof window.argus.getOkxSwapPosition !== "function") {
    renderOkxPositionSnapshot(null, {
      sourceText: "实时查询",
      footnote: "当前环境不支持 OKX 查询。",
      titlePayload: "当前环境不支持 OKX 查询。",
    });
    return;
  }
  try {
    const r = asOkxSwapPositionSnapshot(await window.argus.getOkxSwapPosition(sym));
    renderOkxPositionSnapshot(r, { sourceText: "实时查询" });
  } catch (e) {
    renderOkxPositionSnapshot(
      {
        ok: false,
        simulated: true,
        message: e instanceof Error ? e.message : String(e),
      },
      {
        sourceText: "实时查询",
        footnote: e instanceof Error ? e.message : String(e),
        titlePayload: e instanceof Error ? e.stack || e.message : String(e),
      },
    );
  }
}

/**
 * @param {{ position?: object, tvSymbol?: string, simulated?: boolean }} payload
 */
function applyOkxPositionFromPayload(payload) {
  const bar = document.getElementById("okx-position-bar");
  const sel = document.getElementById("symbol-select");
  if (!bar || !payload?.position) return;
  const cur = sel?.value?.trim() || "";
  if (payload.tvSymbol && cur && cur !== payload.tvSymbol) {
    void refreshOkxPositionBar();
    return;
  }
  if (!cur.startsWith("OKX:")) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const r = {
    ok: true,
    simulated: payload.simulated !== false,
    ...payload.position,
  };
  renderOkxPositionSnapshot(r, {
    sourceText: "成交推送",
    footnote: formatOkxPositionLine(r),
    titlePayload: payload.position.fields ?? payload.position,
  });
}

function initOkxPositionBar() {
  const btn = document.getElementById("okx-position-refresh");
  if (btn) {
    btn.addEventListener("click", () => {
      void refreshOkxPositionBar();
    });
  }
}

function bindOkxSwapStatus() {
  if (typeof window.argus === "undefined" || typeof window.argus.onOkxSwapStatus !== "function") {
    return;
  }
  window.argus.onOkxSwapStatus((payload) => {
    if (payload?.message) {
      setLlmStatus(payload.ok ? `OKX：${payload.message}` : `OKX 错误：${payload.message}`);
    }
    if (payload?.position) {
      applyOkxPositionFromPayload(payload);
    } else {
      void refreshOkxPositionBar();
    }
  });
}

let __argusRendererInitPromise = null;

/** 由 React 根组件挂载后调用；可安全重复调用（只初始化一次）。 */
export function initArgusApp() {
  if (__argusRendererInitPromise) return __argusRendererInitPromise;
  __argusRendererInitPromise = (async () => {
    initPromptStrategiesChangedListener();
    const cfg = await loadAppConfig();
    initTradingViewAutoLayout();
    applySymbolSelect(cfg);
    /* `#symbol-select` 由 React 挂载；若首帧时尚未进 DOM，补跑一次以派发 symbol-select-sync */
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        applySymbolSelect(cfg);
      });
    });
    applyChartIntervalSelect(
      cfg.promptStrategyDecisionIntervalTv ?? FALLBACK_APP_CONFIG.promptStrategyDecisionIntervalTv,
    );
    applyPromptStrategySelect(cfg);
    const sym = cfg.defaultSymbol || cfg.symbols[0]?.value || "OKX:BTCUSDT";
    createTradingViewWidget(sym, chartInterval, {
      chartIndicators:
        cfg.promptStrategyChartIndicators ?? FALLBACK_APP_CONFIG.promptStrategyChartIndicators,
    });
    if (window.argus && typeof window.argus.setMarketContext === "function") {
      window.argus.setMarketContext(sym);
    }
    initSymbolSelect();
    initChartIntervalSelect();
    initPromptStrategySelect();
    initChartCaptureBridge();
    initLocalChartTestListener();
    initConfigCenter();
    initDashboardModal();
    initStrategyCenter();
    initDevToolsButton();
    initFishMode();
    initLlmChartPreview();
    initLlmSessionDetailModal();
    await reloadLlmHistoryFromStore();

    bindMarketBarClose();
    bindLlmStream();
    bindMarketStatus();
    bindOkxSwapStatus();
    initOkxPositionBar();
    refreshExchangeContextBarFromCache();
    void refreshOkxPositionBar();
  })();
  return __argusRendererInitPromise;
}
