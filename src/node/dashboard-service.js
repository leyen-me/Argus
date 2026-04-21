const okxPerp = require("./okx-perp");
const dashboardStore = require("./dashboard-store");

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
 * 与 Agent 统计、平仓胜率共用同一时间戳：仅保留该时点及之后的权益采样。
 * @param {{ t: string, equity: number }[]} series
 * @param {string | null} sinceIso `dashboardAgentToolStatsSince`
 */
function filterEquitySeriesFromStatsSince(series, sinceIso) {
  if (!Array.isArray(series) || !sinceIso || typeof sinceIso !== "string") return series;
  const t0 = Date.parse(sinceIso.trim());
  if (!Number.isFinite(t0)) return series;
  return series.filter((p) => typeof p.t === "string" && Date.parse(p.t) >= t0);
}

/**
 * @param {{ t: string, equity: number }[]} series
 */
function capEquitySeriesTail(series, maxPoints = EQUITY_CHART_MAX_POINTS) {
  if (series.length <= maxPoints) return series;
  return series.slice(-maxPoints);
}

/**
 * @param {string | null} sinceIso
 */
function equitySamplePullLimit(sinceIso) {
  if (!sinceIso || typeof sinceIso !== "string" || !Number.isFinite(Date.parse(sinceIso.trim()))) {
    return EQUITY_CHART_MAX_POINTS;
  }
  return 2000;
}

/**
 * @param {string | null} sinceIso
 */
function buildEquitySeriesForDashboard(sinceIso) {
  const raw = dashboardStore.listRecentEquitySamples(equitySamplePullLimit(sinceIso));
  const filtered = filterEquitySeriesFromStatsSince(raw, sinceIso);
  return capEquitySeriesTail(filtered);
}

/**
 * @param {object} cfg loadAppConfig()
 */
async function getDashboardSnapshot(cfg) {
  const baselineRaw = cfg?.dashboardBaselineEquityUsdt;
  const baselineEquityUsdt =
    typeof baselineRaw === "number" && Number.isFinite(baselineRaw) && baselineRaw >= 0
      ? baselineRaw
      : null;

  const statsSinceRaw = cfg?.dashboardAgentToolStatsSince;
  const dashboardAgentToolStatsSince =
    typeof statsSinceRaw === "string" && statsSinceRaw.trim() && Number.isFinite(Date.parse(statsSinceRaw.trim()))
      ? statsSinceRaw.trim()
      : null;

  const metaPack = { dashboardAgentToolStatsSince };

  const emptySeries = buildEquitySeriesForDashboard(dashboardAgentToolStatsSince);

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

    if (equityUsdt != null) {
      dashboardStore.appendEquitySampleIfNeeded(equityUsdt);
    }

    const equitySeries = buildEquitySeriesForDashboard(dashboardAgentToolStatsSince);

    let pnlVsBaseline = null;
    if (baselineEquityUsdt != null && equityUsdt != null) {
      pnlVsBaseline = equityUsdt - baselineEquityUsdt;
    }

    const sinceMs =
      dashboardAgentToolStatsSince && Number.isFinite(Date.parse(dashboardAgentToolStatsSince.trim()))
        ? Date.parse(dashboardAgentToolStatsSince.trim())
        : NaN;
    /** @type {Awaited<ReturnType<typeof okxPerp.aggregateSwapCloseFillStats>> | null} */
    let swapCloseFillStats = null;
    if (Number.isFinite(sinceMs)) {
      try {
        swapCloseFillStats = await okxPerp.aggregateSwapCloseFillStats(client, {
          beginMs: sinceMs,
          maxPages: 25,
        });
      } catch {
        swapCloseFillStats = null;
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
      swapCloseFillStats,
      ...metaPack,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      message: msg,
      baselineEquityUsdt,
      equitySeries: buildEquitySeriesForDashboard(dashboardAgentToolStatsSince),
      ...metaPack,
    };
  }
}

module.exports = { getDashboardSnapshot };
