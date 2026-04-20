/**
 * 左侧 TradingView 品种 → 仅支持 Binance / OKX WS 加密 K 线。
 * @returns {"crypto" | null} 可订阅行情时为 crypto，否则为 null
 */
function inferFeed(value, explicit) {
  if (explicit === "crypto") return "crypto";
  const v = String(value || "").trim();
  if (v.startsWith("BINANCE:") || v.startsWith("OKX:")) return "crypto";
  return null;
}

module.exports = { inferFeed };
