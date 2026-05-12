import { mdTable } from "./llm.js";
import { tvSymbolToSwapInstId } from "./okx-perp.js";

const OKX_REST = "https://www.okx.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

const DEFAULT_CRYPTO_SYMBOLS = [
  "OKX:BTCUSDT",
  "OKX:ETHUSDT",
  "OKX:SOLUSDT",
  "OKX:DOGEUSDT",
  "OKX:OKBUSDT",
  "OKX:BNBUSDT",
  "OKX:ZECUSDT",
  "OKX:XRPUSDT",
  "OKX:TRUMPUSDT",
];

type MarketEnvironmentGroupKey = "crypto";

type QuoteRow = {
  label: string;
  price: number | null;
  changePct: number | null;
  changeAbs: number | null;
  source: string;
  updatedAt: string | null;
  error?: string | null;
};

type MarketEnvironmentGroup = {
  key: MarketEnvironmentGroupKey;
  title: string;
  rows: QuoteRow[];
  error?: string | null;
};

type MarketEnvironmentSnapshot = {
  groups: MarketEnvironmentGroup[];
};

type OkxTickerRow = {
  instId?: unknown;
  last?: unknown;
  sodUtc8?: unknown;
  ts?: unknown;
};

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((x) => String(x || "").trim()).filter(Boolean))];
}

function requestSignal(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, {
    method: "GET",
    headers,
    signal: requestSignal(),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoFromMs(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}

function calculateChange(last: number | null, base: number | null): { changeAbs: number | null; changePct: number | null } {
  if (last == null || base == null || base <= 0) return { changeAbs: null, changePct: null };
  const changeAbs = last - base;
  return { changeAbs, changePct: (changeAbs / base) * 100 };
}

function formatPrice(value: number | null): string {
  if (value == null) return "—";
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  return value.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

function formatSignedNumber(value: number | null): string {
  if (value == null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatPrice(value)}`;
}

function formatChange(changePct: number | null, changeAbs: number | null): string {
  if (changePct == null) return "—";
  const sign = changePct > 0 ? "+" : "";
  return `${sign}${changePct.toFixed(2)}%（${formatSignedNumber(changeAbs)}）`;
}

function compactIsoMinute(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(5, 16).replace("T", " ");
}

function formatErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error ?? "未知错误");
  return msg.replace(/\s+/g, " ").trim() || "未知错误";
}

function okxDisplayLabelFromInstId(instId: string): string {
  return instId.replace(/-USDT-SWAP$/i, "/USDT").replace(/-/g, "");
}

function okxInstIdsForPrompt(tvSymbol: string): string[] {
  const current = tvSymbolToSwapInstId(tvSymbol);
  const defaults = DEFAULT_CRYPTO_SYMBOLS.map((sym) => tvSymbolToSwapInstId(sym)).filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
  return uniqueStrings([...defaults, current || ""]);
}

function parseOkxTickerMap(json: unknown): Map<string, OkxTickerRow> {
  const obj = asRecord(json);
  if (String(obj?.code ?? "") !== "0") {
    throw new Error(`OKX ${String(obj?.code ?? "unknown")}: ${String(obj?.msg ?? "行情响应异常")}`);
  }
  const data = Array.isArray(obj?.data) ? obj.data : [];
  const out = new Map<string, OkxTickerRow>();
  for (const raw of data) {
    const row = asRecord(raw);
    const instId = typeof row?.instId === "string" ? row.instId : "";
    if (instId) out.set(instId, row as OkxTickerRow);
  }
  return out;
}

async function fetchCryptoGroup(tvSymbol: string): Promise<MarketEnvironmentGroup> {
  const instIds = okxInstIdsForPrompt(tvSymbol);
  try {
    const json = await fetchJson(`${OKX_REST}/api/v5/market/tickers?instType=SWAP`, {
      "Content-Type": "application/json",
    });
    const tickerMap = parseOkxTickerMap(json);
    const rows = instIds.map((instId): QuoteRow => {
      const ticker = tickerMap.get(instId);
      if (!ticker) {
        return {
          label: okxDisplayLabelFromInstId(instId),
          price: null,
          changePct: null,
          changeAbs: null,
          source: "OKX SWAP",
          updatedAt: null,
          error: "无数据",
        };
      }
      const price = asNumber(ticker.last);
      const openUtc8 = asNumber(ticker.sodUtc8);
      const change = calculateChange(price, openUtc8);
      return {
        label: okxDisplayLabelFromInstId(instId),
        price,
        changePct: change.changePct,
        changeAbs: change.changeAbs,
        source: "OKX SWAP",
        updatedAt: isoFromMs(ticker.ts),
      };
    });
    return { key: "crypto", title: "### 加密货币（OKX SWAP）", rows };
  } catch (e) {
    return {
      key: "crypto",
      title: "### 加密货币（OKX SWAP）",
      rows: [],
      error: formatErrorMessage(e),
    };
  }
}

async function fetchMarketEnvironment(tvSymbol: string): Promise<MarketEnvironmentSnapshot> {
  const crypto = await fetchCryptoGroup(tvSymbol);
  return { groups: [crypto] };
}

function formatMarketEnvironmentGroup(group: MarketEnvironmentGroup): string {
  if (group.error) {
    return [group.title, "", `（拉取失败：${group.error}）`].join("\n");
  }
  if (!group.rows.length) {
    return [group.title, "", "（无数据行）"].join("\n");
  }
  return [
    group.title,
    "",
    mdTable(
      ["标的", "最新价", "今日涨跌", "数据源", "更新时间"],
      group.rows.map((row) => [
        row.error ? `${row.label}（${row.error}）` : row.label,
        formatPrice(row.price),
        formatChange(row.changePct, row.changeAbs),
        row.source,
        compactIsoMinute(row.updatedAt),
      ]),
    ),
  ].join("\n");
}

function formatMarketEnvironmentForPrompt(snapshot: MarketEnvironmentSnapshot | null | undefined): string {
  if (!snapshot || !Array.isArray(snapshot.groups) || snapshot.groups.length === 0) {
    return ["## 市场环境", "", "（市场环境无数据。）"].join("\n");
  }
  return ["## 市场环境", ...snapshot.groups.map(formatMarketEnvironmentGroup)].join("\n\n");
}

async function buildMarketEnvironmentPromptBlock(tvSymbol: string): Promise<string> {
  return formatMarketEnvironmentForPrompt(await fetchMarketEnvironment(tvSymbol));
}

export {
  buildMarketEnvironmentPromptBlock,
  calculateChange,
  fetchMarketEnvironment,
  formatMarketEnvironmentForPrompt,
  okxInstIdsForPrompt,
  type MarketEnvironmentGroup,
  type MarketEnvironmentSnapshot,
  type QuoteRow,
};
