/**
 * OKX USDT 永续（SWAP）REST：Agent 工具与快照，仅处理 OKX: 前缀品种。
 * 使用账户可用 USDT 的 okxSwapMarginFraction（默认 25%）作为保证金，
 * 名义约 = 保证金 × 杠杆；合约张数按行情价与 ctVal 换算。
 */
const crypto = require("crypto");
const https = require("https");
const { inferFeed } = require("./market");

const OKX_REST = "https://www.okx.com";

/**
 * OKX 失败时顶层 `msg` 常为「All operations failed」，具体原因在 `data[].sCode` / `data[].sMsg`。
 * @param {object} json
 */
function formatOkxErrorBody(json) {
  const msg = typeof json.msg === "string" ? json.msg : "";
  const rows = Array.isArray(json.data) ? json.data : [];
  const details = rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const sc = row.sCode != null ? String(row.sCode) : "";
      const sm = typeof row.sMsg === "string" ? row.sMsg : "";
      if (!sc && !sm) return null;
      return sc && sm ? `[${sc}] ${sm}` : sc || sm;
    })
    .filter(Boolean);
  if (details.length) return [msg, ...details].filter(Boolean).join(" | ");
  if (msg) return msg;
  try {
    return JSON.stringify(json);
  } catch {
    return String(json);
  }
}

/**
 * 单笔下单：顶层 code 为 0 时仍可能在 data[0].sCode 返回失败（常见于「All operations failed」类响应）。
 * @param {object} json
 */
function assertOkxTradeOrderAccepted(json) {
  const row = json?.data?.[0];
  if (!row || typeof row !== "object") {
    throw new Error("OKX 下单无返回 data[0]");
  }
  const sc = row.sCode != null ? String(row.sCode) : "";
  if (sc && sc !== "0") {
    const sm = typeof row.sMsg === "string" ? row.sMsg : "";
    throw new Error(`OKX 下单失败 [${sc}] ${sm}`.trim());
  }
}

/**
 * 与 crypto-scheduler 中 OKX 现货 instId 规则一致（避免 require crypto-scheduler → bar-close 循环依赖）。
 * @param {string} tv
 * @returns {string | null}
 */
function okxSpotInstIdFromTv(tv) {
  const v = String(tv || "").trim();
  if (!v.startsWith("OKX:")) return null;
  const rest = v.slice("OKX:".length).trim().toUpperCase();
  if (!rest) return null;
  if (rest.includes("-")) return rest;
  const m = /^(.+)(USDT|USDC|DAI|BUSD|EUR|USD|BTC|ETH)$/.exec(rest);
  if (m) return `${m[1]}-${m[2]}`;
  return null;
}

/**
 * @param {string} tvSymbol
 * @returns {string | null}
 */
function tvSymbolToSwapInstId(tv) {
  const spotLike = okxSpotInstIdFromTv(tv);
  if (!spotLike) return null;
  return `${spotLike}-SWAP`;
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.secretKey
 * @param {string} opts.passphrase
 * @param {boolean} [opts.simulated]
 */
function createOkxClient(opts) {
  const { apiKey, secretKey, passphrase, simulated } = opts;

  function sign(timestamp, method, requestPath, body) {
    return crypto.createHmac("sha256", secretKey).update(timestamp + method + requestPath + body).digest("base64");
  }

  /**
   * @param {string} method
   * @param {string} requestPath path + query e.g. /api/v5/account/balance?ccy=USDT
   * @param {string} bodyStr
   */
  function request(method, requestPath, bodyStr = "") {
    const timestamp = new Date().toISOString();
    const sig = sign(timestamp, method, requestPath, bodyStr);
    const url = new URL(OKX_REST + requestPath);
    /** @type {import("https").RequestOptions} */
    const reqOpts = {
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": sig,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": passphrase,
      },
    };
    if (simulated) reqOpts.headers["x-simulated-trading"] = "1";

    return new Promise((resolve, reject) => {
      const req = https.request(reqOpts, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = JSON.parse(raw);
          } catch {
            reject(new Error(`OKX 非 JSON 响应 ${res.statusCode}: ${raw.slice(0, 200)}`));
            return;
          }
          if (String(json.code) !== "0") {
            reject(new Error(`OKX ${json.code}: ${formatOkxErrorBody(json)}`));
            return;
          }
          resolve(json);
        });
      });
      req.on("error", reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  return { request };
}

function publicGet(pathWithQuery) {
  const url = new URL(OKX_REST + pathWithQuery);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "GET",
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (String(json.code) !== "0") {
              reject(new Error(`OKX ${json.code}: ${formatOkxErrorBody(json)}`));
              return;
            }
            resolve(json);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * @param {string} instId
 */
async function fetchSwapInstrument(instId) {
  const j = await publicGet(`/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(instId)}`);
  const row = j.data?.[0];
  if (!row) throw new Error(`未找到 SWAP 合约 ${instId}`);
  const ctVal = parseFloat(row.ctVal);
  const lotSz = parseFloat(row.lotSz);
  const minSz = parseFloat(row.minSz);
  if (!Number.isFinite(ctVal) || ctVal <= 0) throw new Error(`${instId} ctVal 无效`);
  if (!Number.isFinite(lotSz) || lotSz <= 0) throw new Error(`${instId} lotSz 无效`);
  const tickSz = parseFloat(row.tickSz);
  if (!Number.isFinite(tickSz) || tickSz <= 0) throw new Error(`${instId} tickSz 无效`);
  return { instId: row.instId, ctVal, lotSz, minSz, tickSz };
}

/**
 * @param {string} instId
 */
async function fetchTickerLast(instId) {
  const j = await publicGet(`/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`);
  const row = j.data?.[0];
  const px = parseFloat(row?.last || row?.markPx || row?.idxPx || "");
  if (!Number.isFinite(px) || px <= 0) throw new Error(`${instId} 无有效行情价`);
  return px;
}

/**
 * @param {ReturnType<createOkxClient>} client
 */
async function fetchAccountPosMode(client) {
  try {
    const j = await client.request("GET", "/api/v5/account/config", "");
    const mode = j.data?.[0]?.posMode;
    if (mode === "long_short_mode") return "hedge";
    if (mode === "net_mode") return "net";
  } catch {
    /* 回退单向持仓 */
  }
  return "net";
}

/**
 * @param {ReturnType<createOkxClient>} client
 */
async function fetchUsdtAvailEq(client) {
  const j = await client.request("GET", "/api/v5/account/balance?ccy=USDT", "");
  const detail = j.data?.[0]?.details?.find((d) => d.ccy === "USDT");
  if (!detail) {
    const eq = parseFloat(j.data?.[0]?.adjEq ?? "");
    if (Number.isFinite(eq) && eq > 0) return eq;
    return 0;
  }
  const avail = parseFloat(detail.availEq ?? detail.availBal ?? detail.eq ?? "");
  return Number.isFinite(avail) && avail > 0 ? avail : 0;
}

/**
 * 持仓接口同时返回 pos / availPos（见 OKX GET /api/v5/account/positions 响应字段说明）。
 * @param {object} r
 */
function swapPositionRowAbsContracts(r) {
  const p = parseFloat(r.pos);
  const a = parseFloat(r.availPos);
  const ap = Number.isFinite(Math.abs(p)) ? Math.abs(p) : 0;
  const aa = Number.isFinite(Math.abs(a)) ? Math.abs(a) : 0;
  return Math.max(ap, aa);
}

/**
 * @param {object} r
 */
function effectiveSwapPosNum(r) {
  const p = parseFloat(r.pos);
  if (Number.isFinite(p) && p !== 0) return p;
  const a = parseFloat(r.availPos);
  if (!Number.isFinite(a) || a === 0) return 0;
  const ps = String(r.posSide || "net");
  if (ps === "short") return -Math.abs(a);
  return Math.abs(a);
}

/**
 * @param {object[]} rows
 * @returns {{ detail: { posNum: number, absPos: number, posSide: string }, row: object | null }}
 */
function pickBestSwapPositionRowData(rows) {
  let row = null;
  let bestAbs = 0;
  for (const r of rows) {
    const absPos = swapPositionRowAbsContracts(r);
    if (Number.isFinite(absPos) && absPos > bestAbs) {
      bestAbs = absPos;
      row = r;
    }
  }
  if (!row || bestAbs <= 0) {
    return { detail: { posNum: 0, absPos: 0, posSide: "net" }, row: null };
  }
  const posNum = effectiveSwapPosNum(row);
  const absPos = Math.abs(posNum);
  const posSide = String(row.posSide || "net");
  return {
    detail: {
      posNum: Number.isFinite(posNum) ? posNum : 0,
      absPos: Number.isFinite(absPos) ? absPos : 0,
      posSide,
    },
    row,
  };
}

/**
 * @param {object} row
 * @returns {object | null}
 */
function serializeSwapPositionRow(row) {
  if (!row || typeof row !== "object") return null;
  /** @param {string} k */
  const pick = (k) => {
    const v = row[k];
    if (v == null) return undefined;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    return String(v);
  };
  return {
    instId: pick("instId"),
    posSide: pick("posSide"),
    pos: pick("pos"),
    availPos: pick("availPos"),
    avgPx: pick("avgPx"),
    markPx: pick("markPx"),
    last: pick("last"),
    upl: pick("upl"),
    uplRatio: pick("uplRatio"),
    lever: pick("lever"),
    margin: pick("margin"),
    mgnMode: pick("mgnMode"),
    notionalUsd: pick("notionalUsd"),
    liqPx: pick("liqPx"),
    ccy: pick("ccy"),
  };
}

/**
 * @param {ReturnType<createOkxClient>} client
 * @param {string} instId
 */
async function fetchSwapPositionRows(client, instId) {
  const j = await client.request(
    "GET",
    `/api/v5/account/positions?instType=SWAP&instId=${encodeURIComponent(instId)}`,
    "",
  );
  let rows = Array.isArray(j.data) ? j.data : [];
  if (!rows.length) {
    const jAll = await client.request("GET", "/api/v5/account/positions?instType=SWAP", "");
    rows = (Array.isArray(jAll.data) ? jAll.data : []).filter((r) => r.instId === instId);
  }
  return rows;
}

/**
 * @param {ReturnType<createOkxClient>} client
 * @param {string} instId
 */
async function fetchSwapPositionSnapshot(client, instId) {
  const rows = await fetchSwapPositionRows(client, instId);
  const { detail, row } = pickBestSwapPositionRowData(rows);
  return {
    instId,
    hasPosition: detail.absPos > 0,
    posSide: detail.posSide,
    posNum: detail.posNum,
    absContracts: detail.absPos,
    fields: row ? serializeSwapPositionRow(row) : null,
  };
}

/**
 * 主进程 / IPC：按当前配置拉取某图表品种对应永续持仓（供界面展示）。
 * @param {object} cfg
 * @param {string} tvSymbol
 */
async function getOkxSwapPositionSnapshot(cfg, tvSymbol) {
  if (!cfg || cfg.okxSwapTradingEnabled !== true) {
    return { ok: true, skipped: true, reason: "okx_swap_disabled" };
  }
  if (inferFeed(tvSymbol) !== "crypto") {
    return { ok: true, skipped: true, reason: "not_okx_chart" };
  }
  const instId = tvSymbolToSwapInstId(tvSymbol);
  if (!instId) {
    return { ok: false, message: "无效 OKX 品种代码" };
  }
  const apiKey = typeof cfg.okxApiKey === "string" ? cfg.okxApiKey.trim() : "";
  const secretKey = typeof cfg.okxSecretKey === "string" ? cfg.okxSecretKey.trim() : "";
  const passphrase = typeof cfg.okxPassphrase === "string" ? cfg.okxPassphrase.trim() : "";
  if (!apiKey || !secretKey || !passphrase) {
    return { ok: false, message: "OKX API 未配置完整" };
  }
  const simulated = cfg.okxSimulated !== false;
  const client = createOkxClient({ apiKey, secretKey, passphrase, simulated });
  const snapshot = await fetchSwapPositionSnapshot(client, instId);
  return { ok: true, simulated, ...snapshot };
}

/**
 * GET /api/v5/trade/order — 用于确认成交（state、accFillSz），见 OKX 文档「Get order」。
 * @param {ReturnType<createOkxClient>} client
 * @param {string} instId
 * @param {string} ordId
 */
async function fetchSwapOrderRow(client, instId, ordId) {
  const j = await client.request(
    "GET",
    `/api/v5/trade/order?instId=${encodeURIComponent(instId)}&ordId=${encodeURIComponent(ordId)}`,
    "",
  );
  return j.data?.[0] ?? null;
}

/**
 * 下单响应里 sCode=0 只表示「请求处理完成」，是否成交要看订单 state / accFillSz（OKX「Place order」「Get order」说明）。
 * @param {ReturnType<createOkxClient>} client
 * @param {string} instId
 * @param {string} ordId
 */
async function waitSwapOrderFilled(client, instId, ordId) {
  const terminalBad = new Set(["canceled", "mmp_canceled"]);
  let last = null;
  const maxTry = 45;
  const stepMs = 400;
  for (let i = 0; i < maxTry; i++) {
    last = await fetchSwapOrderRow(client, instId, ordId);
    if (!last) {
      throw new Error(`OKX GET /trade/order 无数据 ordId=${ordId}`);
    }
    const st = String(last.state || "");
    const acc = parseFloat(last.accFillSz || "0");
    if (st === "filled" || (acc > 0 && (st === "partially_filled" || st === "filled"))) {
      return last;
    }
    if (terminalBad.has(st)) {
      const why = typeof last.cancelSourceReason === "string" ? last.cancelSourceReason : "";
      throw new Error(
        `OKX 订单未成交即结束：state=${st} accFillSz=${last.accFillSz ?? ""}${why ? ` ${why}` : ""}。`,
      );
    }
    await delay(stepMs);
  }
  throw new Error(
    `OKX 订单在 ${(maxTry * stepMs) / 1000}s 内未变为已成交：最后 state=${last?.state} accFillSz=${last?.accFillSz ?? ""}。请用网页或 GET /api/v5/trade/order 核对订单状态。`,
  );
}

/**
 * @param {ReturnType<createOkxClient>} client
 * @param {string} instId
 */
async function fetchSwapPositionDetail(client, instId) {
  const rows = await fetchSwapPositionRows(client, instId);
  return pickBestSwapPositionRowData(rows).detail;
}

function floorToLot(sz, lotSz) {
  if (!Number.isFinite(sz) || !Number.isFinite(lotSz) || lotSz <= 0) return 0;
  const n = Math.floor(sz / lotSz) * lotSz;
  const decimals = (String(lotSz).split(".")[1] || "").length;
  return Math.round(n * 10 ** decimals) / 10 ** decimals;
}

/**
 * @param {"hedge" | "net"} posMode
 * @param {{ posNum: number, absPos: number, posSide: string }} detail
 */
function resolveCloseParams(posMode, detail) {
  const ps = detail.posSide;
  if (posMode === "hedge") {
    if (ps === "long") return { closeSide: "sell", orderPosSide: "long" };
    if (ps === "short") return { closeSide: "buy", orderPosSide: "short" };
  }
  /** 单向(net)：下单 API 不传 posSide；由 buy/sell + reduceOnly 表达方向 */
  if (detail.posNum > 0) return { closeSide: "sell", orderPosSide: null };
  if (detail.posNum < 0) return { closeSide: "buy", orderPosSide: null };
  return { closeSide: "sell", orderPosSide: null };
}

/**
 * @param {ReturnType<createOkxClient>} client
 * @param {object} p
 * @param {string} p.instId
 * @param {string} p.mgnMode
 * @param {string} p.lever
 * @param {string} p.posSide net | long | short
 */
async function setLeverageSafe(client, p) {
  const body = JSON.stringify({
    instId: p.instId,
    lever: p.lever,
    mgnMode: p.mgnMode,
    posSide: p.posSide,
  });
  await client.request("POST", "/api/v5/account/set-leverage", body);
}

/**
 * @param {object} p
 * @param {string} p.instId
 * @param {string} p.tdMode
 * @param {string} p.side buy | sell
 * @param {string} p.sz
 * @param {boolean} p.reduceOnly
 * @param {string | undefined} p.posSide 双向持仓时为 long|short；单向(net)时不要传（勿传 "net"）
 * @param {string} p.clOrdId
 */
async function placeMarket(client, p) {
  /** 永续：双向持仓须 posSide=long|short；单向(net) 须省略 posSide，传 "net" 会报 51000 */
  const bodyObj = {
    instId: p.instId,
    tdMode: p.tdMode,
    side: p.side,
    ordType: "market",
    sz: p.sz,
    reduceOnly: p.reduceOnly,
    clOrdId: p.clOrdId,
  };
  if (p.posSide === "long" || p.posSide === "short") {
    bodyObj.posSide = p.posSide;
  }
  const json = await client.request("POST", "/api/v5/trade/order", JSON.stringify(bodyObj));
  assertOkxTradeOrderAccepted(json);
  return json;
}

/** @param {unknown} err */
function isOkx51000PosSide(err) {
  const m = err instanceof Error ? err.message : String(err);
  return m.includes("51000") && m.includes("posSide");
}

/**
 * 永续 posSide：net 与 hedge 在接口上互斥，且 account/config 偶发不可靠。
 * 顺序：先按单向(不传 posSide)，若仅 51000 Parameter posSide 再带 long/short。
 * @param {{ instId: string, tdMode: string, side: string, sz: string, reduceOnly: boolean }} base
 * @param {Array<"long"|"short"|undefined>} attempts
 */
async function placeSwapMarketPosSideFallback(client, base, attempts) {
  let last;
  for (let i = 0; i < attempts.length; i++) {
    const ps = attempts[i];
    try {
      return await placeMarket(client, {
        ...base,
        posSide: ps,
        clOrdId: clOrdIdFrom(crypto.randomUUID(), `r${i}`),
      });
    } catch (e) {
      last = e;
      if (i === attempts.length - 1 || !isOkx51000PosSide(e)) throw e;
    }
  }
  throw last ?? new Error("placeSwapMarketPosSideFallback: empty attempts");
}

/**
 * @param {object} p
 * @param {string} p.instId
 * @param {string} p.tdMode
 * @param {string} p.side buy | sell
 * @param {string} p.sz
 * @param {string} p.px
 * @param {boolean} p.reduceOnly
 * @param {string | undefined} p.posSide
 * @param {string} p.clOrdId
 */
async function placeLimit(client, p) {
  const bodyObj = {
    instId: p.instId,
    tdMode: p.tdMode,
    side: p.side,
    ordType: "limit",
    sz: p.sz,
    px: p.px,
    reduceOnly: p.reduceOnly,
    clOrdId: p.clOrdId,
  };
  if (p.posSide === "long" || p.posSide === "short") {
    bodyObj.posSide = p.posSide;
  }
  const json = await client.request("POST", "/api/v5/trade/order", JSON.stringify(bodyObj));
  assertOkxTradeOrderAccepted(json);
  return json;
}

/**
 * @param {{ instId: string, tdMode: string, side: string, sz: string, reduceOnly: boolean }} base
 * @param {string} px
 * @param {Array<"long"|"short"|undefined>} attempts
 */
async function placeSwapLimitPosSideFallback(client, base, px, attempts) {
  let last;
  for (let i = 0; i < attempts.length; i++) {
    const ps = attempts[i];
    try {
      return await placeLimit(client, {
        ...base,
        posSide: ps,
        px,
        clOrdId: clOrdIdFrom(crypto.randomUUID(), `l${i}`),
      });
    } catch (e) {
      last = e;
      if (i === attempts.length - 1 || !isOkx51000PosSide(e)) throw e;
    }
  }
  throw last ?? new Error("placeSwapLimitPosSideFallback: empty attempts");
}

/** @param {boolean} isLong */
function posSideAttemptsOpen(isLong) {
  return [undefined, isLong ? "long" : "short"];
}

/** @param {"buy"|"sell"} closeSide */
function posSideAttemptsClose(closeSide) {
  return closeSide === "sell" ? [undefined, "long"] : [undefined, "short"];
}

function clOrdIdFrom(barCloseId, tag) {
  const t = String(tag).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 4) || "x";
  const u = String(barCloseId).replace(/-/g, "");
  return (`a${t}${u}`).slice(0, 32);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 按合约 tick 格式化价格字符串（限价单 px）。
 * @param {number} px
 * @param {number} tickSz
 */
function formatOkxPx(px, tickSz) {
  if (!Number.isFinite(px) || !Number.isFinite(tickSz) || tickSz <= 0) {
    throw new Error("formatOkxPx: 无效参数");
  }
  const dec = (String(tickSz).split(".")[1] || "").length;
  const factor = 10 ** dec;
  const tick = Math.round(tickSz * factor);
  const p = Math.round((px * factor) / tick) * tick;
  return (p / factor).toFixed(dec);
}

/**
 * 吃单侧限价：买则价高于盘口、卖则价低于盘口（相对 last 偏移），便于尽快成交。
 * @param {"buy"|"sell"} side
 * @param {number} last
 * @param {number} tickSz
 */
function aggressiveLimitPxForSide(side, last, tickSz) {
  const slip = 0.005;
  const raw = side === "buy" ? last * (1 + slip) : last * (1 - slip);
  return formatOkxPx(raw, tickSz);
}

/** @param {unknown} err */
function isOkx51010AccountMode(err) {
  const m = err instanceof Error ? err.message : String(err);
  return m.includes("51010") || m.includes("current account mode");
}

/**
 * OKX 51010：当前账户模式不允许该请求（常见于仅现货、或需在网页/APP 切换为多币种保证金等支持合约的模式）。
 */
const OKX_51010_ACCOUNT_MODE_HINT =
  "【51010】当前交易账户模式不支持该操作。请到 OKX 网页或 App：交易设置 / 账户模式，切换为支持合约与杠杆的模式（如「多币种保证金」「合约模式」等，以界面为准）；模拟盘请在「模拟交易」环境内检查是否已开通合约。也可尝试环境变量 OKX_TD_MODE=isolated。";

/**
 * 冒烟：开多（最小张）。开仓固定为市价，避免限价挂单残留等副作用；opts.pxType 若传入会被忽略。
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.secretKey
 * @param {string} opts.passphrase
 * @param {boolean} [opts.simulated=true]
 * @param {string} [opts.instId="BTC-USDT-SWAP"]
 * @param {"cross"|"isolated"} [opts.tdMode="isolated"]
 * @param {number} [opts.lever=10]
 */
async function smokeSwapOpenLong(opts) {
  const {
    apiKey,
    secretKey,
    passphrase,
    simulated = true,
    instId = "BTC-USDT-SWAP",
    tdMode = "isolated",
    lever = 10,
  } = opts;

  if (!apiKey || !secretKey || !passphrase) {
    throw new Error("缺少 apiKey / secretKey / passphrase");
  }

  const mgn = tdMode === "isolated" ? "isolated" : "cross";
  const client = createOkxClient({ apiKey, secretKey, passphrase, simulated });
  if (simulated) {
    console.warn(
      "[Argus/OKX] 当前为模拟盘（x-simulated-trading）。市价单通常瞬间成交，「当前委托」里常为 0 条，请到「订单历史/成交记录」里按时间或 ordId 查；主站实盘合约页看不到。",
    );
  }
  const posMode = await fetchAccountPosMode(client);

  let existing;
  try {
    existing = await fetchSwapPositionDetail(client, instId);
  } catch (e) {
    if (isOkx51010AccountMode(e)) {
      throw new Error(`${e instanceof Error ? e.message : String(e)}\n${OKX_51010_ACCOUNT_MODE_HINT}`);
    }
    throw e;
  }
  if (existing.absPos > 0) {
    throw new Error(`${instId} 已有持仓，请先手动平仓后再跑开仓冒烟测试`);
  }

  const inst = await fetchSwapInstrument(instId);
  const openSz = String(inst.minSz);
  const levStr = String(Math.min(125, Math.max(1, Math.floor(Number(lever) || 10))));

  try {
    if (posMode === "hedge") {
      await setLeverageSafe(client, {
        instId,
        mgnMode: mgn,
        lever: levStr,
        posSide: "long",
      });
    } else {
      await setLeverageSafe(client, {
        instId,
        mgnMode: mgn,
        lever: levStr,
        posSide: "net",
      });
    }
  } catch (e) {
    if (isOkx51010AccountMode(e)) {
      console.warn(
        "[Argus] OKX set-leverage 返回 51010，已跳过设杠杆并继续尝试下单（使用账户当前杠杆）。",
        OKX_51010_ACCOUNT_MODE_HINT,
      );
    } else {
      throw e;
    }
  }

  const openBase = {
    instId,
    tdMode: mgn,
    side: "buy",
    sz: openSz,
    reduceOnly: false,
  };
  const attempts = posSideAttemptsOpen(true);

  const openBody = await placeSwapMarketPosSideFallback(client, openBase, attempts);

  const openOrdId = openBody.data?.[0]?.ordId ?? "";
  const openClOrdId = openBody.data?.[0]?.clOrdId ?? "";
  if (!openOrdId) {
    throw new Error("OKX 下单未返回 ordId，无法用 GET /trade/order 校验是否成交（请查响应 data[0]）");
  }

  const filledOpen = await waitSwapOrderFilled(client, instId, openOrdId);

  return {
    instId,
    openSz,
    openOrdId,
    openClOrdId,
    accFillSz: filledOpen.accFillSz != null ? String(filledOpen.accFillSz).trim() : "",
    pxType: "market",
    simulated: !!simulated,
    seeOrdersOnPhoneHint: simulated
      ? "模拟盘：进「模拟交易」后看「历史订单/成交」；市价开平后当前委托常为空。实盘页看不到。"
      : "实盘：在合约委托或持仓中查看（须与 API Key 所属账户一致）。",
  };
}

/**
 * 冒烟：全平当前合约持仓。模拟盘若 GET /positions 为 0，可传入上一笔开仓返回的 openAccFillSz。
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.secretKey
 * @param {string} opts.passphrase
 * @param {boolean} [opts.simulated=true]
 * @param {string} [opts.instId="BTC-USDT-SWAP"]
 * @param {"cross"|"isolated"} [opts.tdMode="isolated"]
 * @param {"market"|"limit"} [opts.pxType="market"]
 * @param {string} [opts.openAccFillSz] 与 smokeSwapOpenLong 返回的 accFillSz 一致时用于持仓不同步
 */
async function smokeSwapClosePosition(opts) {
  const {
    apiKey,
    secretKey,
    passphrase,
    simulated = true,
    instId = "BTC-USDT-SWAP",
    tdMode = "isolated",
    pxType: pxTypeRaw,
    openAccFillSz,
  } = opts;

  const pxKind = pxTypeRaw === "limit" ? "limit" : "market";

  if (!apiKey || !secretKey || !passphrase) {
    throw new Error("缺少 apiKey / secretKey / passphrase");
  }

  const mgn = tdMode === "isolated" ? "isolated" : "cross";
  const client = createOkxClient({ apiKey, secretKey, passphrase, simulated });
  if (simulated) {
    console.warn(
      "[Argus/OKX] 当前为模拟盘（x-simulated-trading）。市价单通常瞬间成交，「当前委托」里常为 0 条，请到「订单历史/成交记录」里按时间或 ordId 查；主站实盘合约页看不到。",
    );
  }

  const posMode = await fetchAccountPosMode(client);

  let detail;
  try {
    detail = await fetchSwapPositionDetail(client, instId);
  } catch (e) {
    if (isOkx51010AccountMode(e)) {
      throw new Error(`${e instanceof Error ? e.message : String(e)}\n${OKX_51010_ACCOUNT_MODE_HINT}`);
    }
    throw e;
  }

  let positionFromOrderFill = false;
  if (detail.absPos <= 0 && openAccFillSz != null && String(openAccFillSz).trim() !== "") {
    const accFill = parseFloat(String(openAccFillSz).trim());
    if (Number.isFinite(accFill) && accFill > 0) {
      positionFromOrderFill = true;
      console.warn(
        "[Argus/OKX] GET /account/positions 未返回持仓，使用 openAccFillSz 平仓（多见于模拟盘）。",
      );
      detail =
        posMode === "hedge"
          ? { posNum: accFill, absPos: accFill, posSide: "long" }
          : { posNum: accFill, absPos: accFill, posSide: "net" };
    }
  }

  if (detail.absPos <= 0) {
    throw new Error(`${instId} 无持仓，无法平仓；请先运行开仓测试或手动开仓`);
  }

  const { closeSide } = resolveCloseParams(posMode, detail);
  const closeSz = String(detail.absPos);

  const closeBase = {
    instId,
    tdMode: mgn,
    side: closeSide,
    sz: closeSz,
    reduceOnly: true,
  };
  const attemptsClose = posSideAttemptsClose(closeSide);

  let closeBody;
  if (pxKind === "market") {
    closeBody = await placeSwapMarketPosSideFallback(client, closeBase, attemptsClose);
  } else {
    const inst = await fetchSwapInstrument(instId);
    const last = await fetchTickerLast(instId);
    const pxStr = aggressiveLimitPxForSide(closeSide, last, inst.tickSz);
    closeBody = await placeSwapLimitPosSideFallback(client, closeBase, pxStr, attemptsClose);
  }

  const closeOrdId = closeBody.data?.[0]?.ordId ?? "";
  const closeClOrdId = closeBody.data?.[0]?.clOrdId ?? "";

  if (closeOrdId) {
    await waitSwapOrderFilled(client, instId, closeOrdId);
  }

  return {
    instId,
    closeSz,
    closeOrdId,
    closeClOrdId,
    pxType: pxKind,
    simulated: !!simulated,
    seeOrdersOnPhoneHint: simulated
      ? "模拟盘：进「模拟交易」后看「历史订单/成交」；市价开平后当前委托常为空。实盘页看不到。"
      : "实盘：在合约委托或持仓中查看（须与 API Key 所属账户一致）。",
    usedAccFillSzForClose: positionFromOrderFill,
  };
}

/**
 * 集成冒烟：开多（最小张）再全平。等价于依次调用 smokeSwapOpenLong 与 smokeSwapClosePosition。
 * 开仓始终市价；平仓价格类型由 pxType / closePxType 决定。
 *
 * @param {object} opts
 * @param {"market"|"limit"} [opts.pxType] 仅作用于平仓（可被 closePxType 覆盖）
 * @param {"market"|"limit"} [opts.closePxType]
 */
async function smokeSwapOpenLongThenClose(opts) {
  const closePx = opts.closePxType ?? opts.pxType ?? "market";
  const openR = await smokeSwapOpenLong(opts);
  const closeR = await smokeSwapClosePosition({
    ...opts,
    pxType: closePx,
    openAccFillSz: openR.accFillSz,
  });
  return {
    instId: openR.instId,
    openSz: openR.openSz,
    openOrdId: openR.openOrdId,
    openClOrdId: openR.openClOrdId,
    closeOrdId: closeR.closeOrdId,
    closeClOrdId: closeR.closeClOrdId,
    simulated: openR.simulated,
    seeOrdersOnPhoneHint: openR.seeOrdersOnPhoneHint,
    usedAccFillSzForClose: closeR.usedAccFillSzForClose,
  };
}

/**
 * 当前挂单（普通委托，不含历史）。
 * @param {ReturnType<createOkxClient>} client
 * @param {string} instId
 */
async function fetchSwapPendingOrders(client, instId) {
  const j = await client.request(
    "GET",
    `/api/v5/trade/orders-pending?instType=SWAP&instId=${encodeURIComponent(instId)}`,
    "",
  );
  return Array.isArray(j.data) ? j.data : [];
}

/**
 * @param {object} row
 */
function serializePendingSwapOrder(row) {
  if (!row || typeof row !== "object") return null;
  /** @param {string} k */
  const pick = (k) => {
    const v = row[k];
    if (v == null) return undefined;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    return String(v);
  };
  return {
    ordId: pick("ordId"),
    clOrdId: pick("clOrdId"),
    side: pick("side"),
    posSide: pick("posSide"),
    ordType: pick("ordType"),
    state: pick("state"),
    px: pick("px"),
    sz: pick("sz"),
    accFillSz: pick("accFillSz"),
    reduceOnly: pick("reduceOnly"),
    lever: pick("lever"),
    tdMode: pick("tdMode"),
    cTime: pick("cTime"),
    tpTriggerPx: pick("tpTriggerPx"),
    slTriggerPx: pick("slTriggerPx"),
    tpOrdPx: pick("tpOrdPx"),
    slOrdPx: pick("slOrdPx"),
  };
}

/**
 * @param {ReturnType<createOkxClient>} client
 * @param {string} instId
 * @param {string} ordId
 */
async function cancelSwapOrder(client, instId, ordId) {
  const body = JSON.stringify({ instId, ordId: String(ordId) });
  const json = await client.request("POST", "/api/v5/trade/cancel-order", body);
  assertOkxTradeOrderAccepted(json);
  return json;
}

/**
 * @param {ReturnType<createOkxClient>} client
 * @param {{ instId: string, ordId: string, newPx?: string | number, newSz?: string | number }} p
 */
async function amendSwapOrder(client, p) {
  const bodyObj = { instId: p.instId, ordId: String(p.ordId) };
  if (p.newPx != null && String(p.newPx).trim() !== "") bodyObj.newPx = String(p.newPx);
  if (p.newSz != null && String(p.newSz).trim() !== "") bodyObj.newSz = String(p.newSz);
  const json = await client.request("POST", "/api/v5/trade/amend-order", JSON.stringify(bodyObj));
  assertOkxTradeOrderAccepted(json);
  return json;
}

/**
 * K 线收盘：拉取交易所持仓 + 挂单摘要，供 Agent 用户消息注入。
 * @param {object} cfg
 * @param {string} tvSymbol
 */
async function getOkxExchangeContextForBar(cfg, tvSymbol) {
  if (!cfg || cfg.okxSwapTradingEnabled !== true) {
    return { ok: true, enabled: false, reason: "okx_swap_disabled" };
  }
  if (inferFeed(tvSymbol) !== "crypto") {
    return { ok: true, enabled: false, reason: "not_crypto_chart" };
  }
  const instId = tvSymbolToSwapInstId(tvSymbol);
  if (!instId) {
    return { ok: false, enabled: false, message: "无效 OKX 品种代码" };
  }
  const apiKey = typeof cfg.okxApiKey === "string" ? cfg.okxApiKey.trim() : "";
  const secretKey = typeof cfg.okxSecretKey === "string" ? cfg.okxSecretKey.trim() : "";
  const passphrase = typeof cfg.okxPassphrase === "string" ? cfg.okxPassphrase.trim() : "";
  if (!apiKey || !secretKey || !passphrase) {
    return { ok: false, enabled: true, message: "OKX API 未配置完整" };
  }
  const simulated = cfg.okxSimulated !== false;
  try {
    const client = createOkxClient({ apiKey, secretKey, passphrase, simulated });
    const position = await fetchSwapPositionSnapshot(client, instId);
    const rawPending = await fetchSwapPendingOrders(client, instId);
    const pending_orders = rawPending.map(serializePendingSwapOrder).filter(Boolean);
    return {
      ok: true,
      enabled: true,
      simulated,
      instId,
      position,
      pending_orders,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, enabled: true, message: msg };
  }
}

/**
 * Agent：市价/限价开仓（按配置保证金比例与张数规则）。
 * @param {object} cfg
 * @param {{ tvSymbol: string, side: "long"|"short", orderType: "market"|"limit", limitPrice?: number, barCloseId: string }} args
 */
async function executeAgentPerpOpen(cfg, args) {
  const { tvSymbol, side, orderType, limitPrice, barCloseId } = args;
  const isLong = side === "long";
  if (!cfg || cfg.okxSwapTradingEnabled !== true) {
    return { ok: false, skipped: true, message: "OKX 永续未启用" };
  }
  if (inferFeed(tvSymbol) !== "crypto") {
    return { ok: false, message: "非加密图表，跳过 OKX" };
  }
  const instId = tvSymbolToSwapInstId(tvSymbol);
  if (!instId) return { ok: false, message: "无效 OKX 品种" };

  const apiKey = typeof cfg.okxApiKey === "string" ? cfg.okxApiKey.trim() : "";
  const secretKey = typeof cfg.okxSecretKey === "string" ? cfg.okxSecretKey.trim() : "";
  const passphrase = typeof cfg.okxPassphrase === "string" ? cfg.okxPassphrase.trim() : "";
  if (!apiKey || !secretKey || !passphrase) {
    return { ok: false, message: "OKX API 未配置完整" };
  }

  const simulated = cfg.okxSimulated !== false;
  const tdMode = cfg.okxTdMode === "cross" ? "cross" : "isolated";
  let lever = Number(cfg.okxSwapLeverage);
  if (!Number.isFinite(lever) || lever < 1) lever = 10;
  lever = Math.min(125, Math.max(1, Math.floor(lever)));
  let marginFrac = Number(cfg.okxSwapMarginFraction);
  if (!Number.isFinite(marginFrac) || marginFrac <= 0) marginFrac = 0.25;
  marginFrac = Math.min(1, Math.max(0.01, marginFrac));

  const client = createOkxClient({ apiKey, secretKey, passphrase, simulated });
  const posMode = await fetchAccountPosMode(client);
  const existing = await fetchSwapPositionDetail(client, instId);
  if (existing.absPos > 0) {
    return { ok: false, message: `${instId} 已有持仓，拒绝重复开仓` };
  }

  const avail = await fetchUsdtAvailEq(client);
  if (avail <= 0) return { ok: false, message: "USDT 可用权益为 0" };

  const margin = avail * marginFrac;
  const notional = margin * lever;
  const inst = await fetchSwapInstrument(instId);
  const px = await fetchTickerLast(instId);
  let sz = notional / (inst.ctVal * px);
  sz = floorToLot(sz, inst.lotSz);
  if (sz < inst.minSz) {
    return {
      ok: false,
      message: `计算张数 ${sz} 低于最小下单 ${inst.minSz}`,
    };
  }

  const levStr = String(lever);
  try {
    if (posMode === "hedge") {
      await setLeverageSafe(client, {
        instId,
        mgnMode: tdMode,
        lever: levStr,
        posSide: isLong ? "long" : "short",
      });
    } else {
      await setLeverageSafe(client, {
        instId,
        mgnMode: tdMode,
        lever: levStr,
        posSide: "net",
      });
    }
  } catch (e) {
    if (!isOkx51010AccountMode(e)) throw e;
  }

  const tradeSide = isLong ? "buy" : "sell";
  const openBase = {
    instId,
    tdMode,
    side: tradeSide,
    sz: String(sz),
    reduceOnly: false,
  };
  const attempts = posSideAttemptsOpen(isLong);
  let ord;
  if (orderType === "limit") {
    const lp = Number(limitPrice);
    if (!Number.isFinite(lp) || lp <= 0) {
      return { ok: false, message: "限价开仓需要有效 limit_price" };
    }
    const pxStr = formatOkxPx(lp, inst.tickSz);
    ord = await placeSwapLimitPosSideFallback(client, openBase, pxStr, attempts);
  } else {
    ord = await placeSwapMarketPosSideFallback(client, openBase, attempts);
  }

  const ordId = ord.data?.[0]?.ordId ?? "";
  let filled = null;
  if (orderType === "market" && ordId) {
    try {
      filled = await waitSwapOrderFilled(client, instId, ordId);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e), ordId };
    }
  }

  const snap = await fetchSwapPositionSnapshot(client, instId);
  const avgPx = snap.fields?.avgPx != null ? parseFloat(String(snap.fields.avgPx)) : null;
  return {
    ok: true,
    ordId,
    instId,
    sz: String(sz),
    orderType: orderType || "market",
    accFillSz: filled?.accFillSz != null ? String(filled.accFillSz) : "",
    avgPx: Number.isFinite(avgPx) ? avgPx : null,
    position: snap,
  };
}

/**
 * Agent：市价/限价全平。
 * @param {object} cfg
 * @param {{ tvSymbol: string, orderType: "market"|"limit", limitPrice?: number }} args
 */
async function executeAgentPerpClose(cfg, args) {
  const { tvSymbol, orderType, limitPrice } = args;
  if (!cfg || cfg.okxSwapTradingEnabled !== true) {
    return { ok: false, skipped: true, message: "OKX 永续未启用" };
  }
  const instId = tvSymbolToSwapInstId(tvSymbol);
  if (!instId) return { ok: false, message: "无效 OKX 品种" };

  const apiKey = typeof cfg.okxApiKey === "string" ? cfg.okxApiKey.trim() : "";
  const secretKey = typeof cfg.okxSecretKey === "string" ? cfg.okxSecretKey.trim() : "";
  const passphrase = typeof cfg.okxPassphrase === "string" ? cfg.okxPassphrase.trim() : "";
  if (!apiKey || !secretKey || !passphrase) {
    return { ok: false, message: "OKX API 未配置完整" };
  }

  const simulated = cfg.okxSimulated !== false;
  const tdMode = cfg.okxTdMode === "cross" ? "cross" : "isolated";
  const client = createOkxClient({ apiKey, secretKey, passphrase, simulated });
  const posMode = await fetchAccountPosMode(client);
  const detail = await fetchSwapPositionDetail(client, instId);
  if (detail.absPos <= 0) {
    return { ok: false, message: `${instId} 无持仓可平` };
  }

  const { closeSide } = resolveCloseParams(posMode, detail);
  const closeBase = {
    instId,
    tdMode,
    side: closeSide,
    sz: String(detail.absPos),
    reduceOnly: true,
  };
  const attemptsClose = posSideAttemptsClose(closeSide);
  let closeBody;
  if (orderType === "limit") {
    const lp = Number(limitPrice);
    if (!Number.isFinite(lp) || lp <= 0) {
      return { ok: false, message: "限价平仓需要有效 limit_price" };
    }
    const inst = await fetchSwapInstrument(instId);
    const pxStr = formatOkxPx(lp, inst.tickSz);
    closeBody = await placeSwapLimitPosSideFallback(client, closeBase, pxStr, attemptsClose);
  } else {
    closeBody = await placeSwapMarketPosSideFallback(client, closeBase, attemptsClose);
  }

  const ordId = closeBody.data?.[0]?.ordId ?? "";
  if (ordId && orderType !== "limit") {
    try {
      await waitSwapOrderFilled(client, instId, ordId);
    } catch {
      /* 平仓市价失败时仍返回 ordId */
    }
  }
  return { ok: true, ordId, instId, closeSz: String(detail.absPos), orderType: orderType || "market" };
}

module.exports = {
  tvSymbolToSwapInstId,
  createOkxClient,
  fetchSwapPendingOrders,
  serializePendingSwapOrder,
  cancelSwapOrder,
  amendSwapOrder,
  getOkxExchangeContextForBar,
  executeAgentPerpOpen,
  executeAgentPerpClose,
  getOkxSwapPositionSnapshot,
  fetchTickerLast,
  fetchSwapInstrument,
  formatOkxPx,
  smokeSwapOpenLong,
  smokeSwapClosePosition,
  smokeSwapOpenLongThenClose,
};
