/**
 * 左侧 TradingView 品种 → 加密(Binance / OKX WS) / 长桥(订阅推送) 分流。
 */

function inferFeed(value, explicit) {
  if (explicit === "crypto" || explicit === "longbridge") return explicit;
  const v = String(value || "").trim();
  if (v.startsWith("BINANCE:") || v.startsWith("OKX:")) return "crypto";
  return "longbridge";
}

/**
 * TradingView 代码 → 长桥标的（如 QQQ.US、700.HK）。无法推断时需配置 longPortSymbol。
 */
function tvSymbolToLongPort(tv) {
  const t = String(tv || "").trim();
  if (!t) return null;
  if (/^\d+\.HK$/i.test(t)) return t.toUpperCase();
  const m = /^(\w+):(.+)$/.exec(t);
  if (!m) {
    if (/\.(US|HK)$/i.test(t)) return t.toUpperCase();
    return null;
  }
  const ex = m[1].toUpperCase();
  let sym = m[2].toUpperCase();
  if (ex === "NASDAQ" || ex === "NYSE" || ex === "AMEX" || ex === "ARCA" || ex === "NYSEARCA") {
    return `${sym}.US`;
  }
  if (ex === "HKEX") {
    const n = sym.replace(/^0+/, "") || sym;
    return `${n}.HK`;
  }
  return null;
}

function resolveLongPortSymbol(symEntry, tvValue) {
  if (symEntry?.longPortSymbol && String(symEntry.longPortSymbol).trim()) {
    return String(symEntry.longPortSymbol).trim();
  }
  return tvSymbolToLongPort(tvValue);
}

module.exports = { inferFeed, tvSymbolToLongPort, resolveLongPortSymbol };
