import * as okxPerp from "./okx-perp.js";
import * as dashboardStore from "./dashboard-store.js";

type OkxSwapCloseStats = Awaited<ReturnType<typeof okxPerp.aggregateSwapClosePositionStats>>;
type DashboardStatsSegment = { startedAt: string; endedAt: string | null };

const BACKGROUND_EQUITY_SAMPLE_INTERVAL_MS = 60_000;

/**
 * @param {object} metrics {@link okxPerp.fetchUsdtAccountMetrics}
 * @returns {number | null}
 */
function pickDisplayEquityUsdt(metrics) {
  if (!metrics || typeof metrics !== "object") return null;
  if (Number.isFinite(metrics.adjEq) && metrics.adjEq > 0) return metrics.adjEq;
  if (Number.isFinite(metrics.usdtEq) && metrics.usdtEq >= 0) return metrics.usdtEq;
  return null;
}

/**
 * @param {number | null} equityUsdt
 * @param {number | null} avail
 * @param {Awaited<ReturnType<typeof okxPerp.fetchUsdtAccountMetrics>> | null} metrics
 */
function pickMarginUsedUsdt(equityUsdt, avail, metrics) {
  if (metrics && Number.isFinite(metrics.imr) && metrics.imr >= 0) return metrics.imr;
  if (
    Number.isFinite(equityUsdt) &&
    Number.isFinite(avail) &&
    equityUsdt != null &&
    avail != null
  ) {
    const u = equityUsdt - avail;
    return Number.isFinite(u) ? Math.max(0, u) : null;
  }
  return null;
}

const EQUITY_CHART_MAX_POINTS = 400;

/**
 * 仅保留落在策略有效运行区间内的权益采样。
 * @param {{ t: string, equity: number }[]} series
 * @param {DashboardStatsSegment[]} segments
 */
function filterEquitySeriesBySegments(series, segments) {
  if (!Array.isArray(series) || !Array.isArray(segments) || segments.length === 0) return [];
  const normalized = normalizeStatsSegments(segments);
  if (!normalized.length) return [];
  return series.filter((p) => {
    if (typeof p.t !== "string") return false;
    const ms = Date.parse(p.t);
    return isTimeInStatsSegments(ms, normalized);
  });
}

/**
 * @param {{ t: string, equity: number }[]} series
 */
function capEquitySeriesTail(series, maxPoints = EQUITY_CHART_MAX_POINTS) {
  if (series.length <= maxPoints) return series;
  return series.slice(-maxPoints);
}

/**
 * @param {DashboardStatsSegment[]} segments
 */
function equitySamplePullLimit(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return EQUITY_CHART_MAX_POINTS;
  }
  return 2000;
}

/**
 * @param {DashboardStatsSegment[]} segments
 */
function buildEquitySeriesForDashboard(segments) {
  const normalized = normalizeStatsSegments(segments);
  if (!normalized.length) return [];
  const raw = dashboardStore.listRecentEquitySamples(equitySamplePullLimit(normalized));
  const filtered = filterEquitySeriesBySegments(raw, normalized);
  return capEquitySeriesTail(filtered);
}

function normalizeStatsSegments(segments: DashboardStatsSegment[] | null | undefined): DashboardStatsSegment[] {
  if (!Array.isArray(segments)) return [];
  return segments
    .map((seg) => {
      const startedAt =
        seg && typeof seg.startedAt === "string" && Number.isFinite(Date.parse(seg.startedAt.trim()))
          ? seg.startedAt.trim()
          : "";
      if (!startedAt) return null;
      const endedAt =
        seg && typeof seg.endedAt === "string" && Number.isFinite(Date.parse(seg.endedAt.trim()))
          ? seg.endedAt.trim()
          : null;
      return { startedAt, endedAt };
    })
    .filter((seg): seg is DashboardStatsSegment => Boolean(seg))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

function isTimeInStatsSegments(ms: number, segments: DashboardStatsSegment[]) {
  if (!Number.isFinite(ms)) return false;
  return segments.some((seg) => {
    const startMs = Date.parse(seg.startedAt);
    if (!Number.isFinite(startMs)) return false;
    const endMs = seg.endedAt ? Date.parse(seg.endedAt) : Number.POSITIVE_INFINITY;
    return ms >= startMs && ms <= endMs;
  });
}

function minStatsSegmentStartMs(segments: DashboardStatsSegment[]) {
  if (!segments.length) return NaN;
  return Math.min(...segments.map((seg) => Date.parse(seg.startedAt)).filter((n) => Number.isFinite(n)));
}

/**
 * 后台定时采样入口：仅拉取账户权益并按去重规则落库，不依赖任何前端界面。
 * @param {object} cfg loadAppConfig()
 */
async function sampleDashboardEquityOnce(cfg) {
  if (!cfg || cfg.okxSwapTradingEnabled !== true) {
    return { ok: true, skipped: true, reason: "okx_swap_disabled" };
  }
  const apiKey = typeof cfg.okxApiKey === "string" ? cfg.okxApiKey.trim() : "";
  const secretKey = typeof cfg.okxSecretKey === "string" ? cfg.okxSecretKey.trim() : "";
  const passphrase = typeof cfg.okxPassphrase === "string" ? cfg.okxPassphrase.trim() : "";
  if (!apiKey || !secretKey || !passphrase) {
    return { ok: true, skipped: true, reason: "okx_api_incomplete" };
  }

  const simulated = cfg.okxSimulated !== false;
  const client = okxPerp.createOkxClient({ apiKey, secretKey, passphrase, simulated });

  const metrics = await okxPerp.fetchUsdtAccountMetrics(client);
  const equityUsdt = pickDisplayEquityUsdt(metrics);
  if (equityUsdt != null) {
    dashboardStore.appendEquitySampleIfNeeded(equityUsdt);
  }
  return { ok: true, skipped: equityUsdt == null, equityUsdt: equityUsdt ?? null };
}

/**
 * @param {object} cfg loadAppConfig()
 */
async function getDashboardSnapshot(cfg) {
  const strategyId = typeof cfg?.promptStrategy === "string" ? cfg.promptStrategy.trim() : "";
  const activeRange =
    strategyId &&
    cfg?.dashboardStrategyRanges &&
    typeof cfg.dashboardStrategyRanges === "object" &&
    cfg.dashboardStrategyRanges[strategyId] &&
    typeof cfg.dashboardStrategyRanges[strategyId] === "object"
      ? cfg.dashboardStrategyRanges[strategyId]
      : null;

  const baselineRaw = activeRange?.baselineEquityUsdt ?? cfg?.dashboardBaselineEquityUsdt;
  const baselineEquityUsdt =
    typeof baselineRaw === "number" && Number.isFinite(baselineRaw) && baselineRaw >= 0
      ? baselineRaw
      : null;

  const statsSegments = normalizeStatsSegments(activeRange?.segments ?? null);
  const statsSinceRaw = statsSegments[0]?.startedAt ?? activeRange?.statsSince ?? cfg?.dashboardAgentToolStatsSince;
  const dashboardAgentToolStatsSince =
    typeof statsSinceRaw === "string" && statsSinceRaw.trim() && Number.isFinite(Date.parse(statsSinceRaw.trim()))
      ? statsSinceRaw.trim()
      : null;

  const metaPack = { dashboardAgentToolStatsSince };

  const emptySeries = buildEquitySeriesForDashboard(statsSegments);

  if (!cfg || cfg.okxSwapTradingEnabled !== true) {
    return {
      ok: true,
      skipped: true,
      reason: "okx_swap_disabled",
      baselineEquityUsdt,
      equitySeries: emptySeries,
      ...metaPack,
    };
  }

  const apiKey = typeof cfg.okxApiKey === "string" ? cfg.okxApiKey.trim() : "";
  const secretKey = typeof cfg.okxSecretKey === "string" ? cfg.okxSecretKey.trim() : "";
  const passphrase = typeof cfg.okxPassphrase === "string" ? cfg.okxPassphrase.trim() : "";
  if (!apiKey || !secretKey || !passphrase) {
    return {
      ok: false,
      message: "OKX API 未配置完整",
      baselineEquityUsdt,
      equitySeries: emptySeries,
      ...metaPack,
    };
  }

  const simulated = cfg.okxSimulated !== false;
  const client = okxPerp.createOkxClient({ apiKey, secretKey, passphrase, simulated });

  try {
    const [metrics, positions] = await Promise.all([
      okxPerp.fetchUsdtAccountMetrics(client),
      okxPerp.fetchOpenSwapPositionsAll(client),
    ]);

    const equityUsdt = pickDisplayEquityUsdt(metrics);
    const availEq = metrics?.usdtAvailEq ?? null;
    const marginUsedUsdt = pickMarginUsedUsdt(equityUsdt, availEq, metrics);

    const equitySeries = buildEquitySeriesForDashboard(statsSegments);

    let pnlVsBaseline: number | null = null;
    const statsEquityTail = equitySeries.length ? equitySeries[equitySeries.length - 1]?.equity : null;
    const pnlEquityUsdt =
      statsSegments.length > 0 && statsSegments[statsSegments.length - 1]?.endedAt ? statsEquityTail : equityUsdt;
    if (baselineEquityUsdt != null && pnlEquityUsdt != null) {
      pnlVsBaseline = pnlEquityUsdt - baselineEquityUsdt;
    }

    const sinceMs = minStatsSegmentStartMs(statsSegments);
    let swapClosePositionStats: OkxSwapCloseStats | null = null;
    if (Number.isFinite(sinceMs) && statsSegments.length > 0) {
      try {
        swapClosePositionStats = await okxPerp.aggregateSwapClosePositionStats(client, {
          beginMs: sinceMs,
          timeRanges: statsSegments.map((seg) => ({
            startMs: Date.parse(seg.startedAt),
            endMs: seg.endedAt ? Date.parse(seg.endedAt) : null,
          })),
          tvSymbol: cfg?.defaultSymbol,
          maxPages: 25,
        });
      } catch {
        swapClosePositionStats = null;
      }
    }

    return {
      ok: true,
      simulated,
      equityUsdt,
      availEqUsdt: availEq,
      marginUsedUsdt,
      uplUsdt: metrics?.usdtUpl ?? null,
      baselineEquityUsdt,
      pnlVsBaselineUsdt: pnlVsBaseline,
      positions,
      equitySeries,
      swapClosePositionStats,
      ...metaPack,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      message: msg,
      baselineEquityUsdt,
      equitySeries: buildEquitySeriesForDashboard(statsSegments),
      ...metaPack,
    };
  }
}

export {
  BACKGROUND_EQUITY_SAMPLE_INTERVAL_MS,
  buildEquitySeriesForDashboard,
  equitySamplePullLimit,
  filterEquitySeriesBySegments,
  getDashboardSnapshot,
  sampleDashboardEquityOnce,
};
