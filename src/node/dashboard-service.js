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

/**
 * @param {object} cfg loadAppConfig()
 */
async function getDashboardSnapshot(cfg) {
  const baselineRaw = cfg?.dashboardBaselineEquityUsdt;
  const baselineEquityUsdt =
    typeof baselineRaw === "number" && Number.isFinite(baselineRaw) && baselineRaw >= 0
      ? baselineRaw
      : null;

  const emptySeries = dashboardStore.listRecentEquitySamples(400);

  if (!cfg || cfg.okxSwapTradingEnabled !== true) {
    return {
      ok: true,
      skipped: true,
      reason: "okx_swap_disabled",
      baselineEquityUsdt,
      equitySeries: emptySeries,
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
    };
  }

  const simulated = cfg.okxSimulated !== false;
  const client = okxPerp.createOkxClient({ apiKey, secretKey, passphrase, simulated });

  try {
    const [metrics, positions, winStats] = await Promise.all([
      okxPerp.fetchUsdtAccountMetrics(client),
      okxPerp.fetchOpenSwapPositionsAll(client),
      okxPerp.fetchSwapPositionsHistoryWinStats(client, 100).catch(() => null),
    ]);

    const equityUsdt = pickDisplayEquityUsdt(metrics);
    const availEq = metrics?.usdtAvailEq ?? null;
    const marginUsedUsdt = pickMarginUsedUsdt(equityUsdt, availEq, metrics);

    if (equityUsdt != null) {
      dashboardStore.appendEquitySampleIfNeeded(equityUsdt);
    }

    const equitySeries = dashboardStore.listRecentEquitySamples(400);

    let pnlVsBaseline = null;
    if (baselineEquityUsdt != null && equityUsdt != null) {
      pnlVsBaseline = equityUsdt - baselineEquityUsdt;
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
      winStats,
      equitySeries,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      message: msg,
      baselineEquityUsdt,
      equitySeries: dashboardStore.listRecentEquitySamples(400),
    };
  }
}

module.exports = { getDashboardSnapshot };
