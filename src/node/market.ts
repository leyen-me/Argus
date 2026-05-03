/**
 * 左侧 TradingView 品种 → 仅 OKX: 前缀可订阅 WS K 线。
 * @returns {"crypto" | null} 可订阅时为 crypto（与主进程/合约模块约定），否则 null
 */
function inferFeed(value) {
  const v = String(value || "").trim();
  if (v.startsWith("OKX:")) return "crypto";
  return null;
}

export { inferFeed };
