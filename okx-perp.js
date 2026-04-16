/**
 * OKX USDT 永续（SWAP）下单：与状态机转移对齐，仅处理 OKX: 前缀品种。
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
  return { instId: row.instId, ctVal, lotSz, minSz };
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
 * @param {ReturnType<createOkxClient>} client
 * @param {string} instId
 */
async function fetchSwapPositionDetail(client, instId) {
  const j = await client.request(
    "GET",
    `/api/v5/account/positions?instType=SWAP&instId=${encodeURIComponent(instId)}`,
    "",
  );
  const row = j.data?.[0];
  if (!row) return { posNum: 0, absPos: 0, posSide: "net" };
  const posNum = parseFloat(row.pos);
  const absPos = Math.abs(posNum);
  const posSide = String(row.posSide || "net");
  return {
    posNum: Number.isFinite(posNum) ? posNum : 0,
    absPos: Number.isFinite(absPos) ? absPos : 0,
    posSide,
  };
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
  if (detail.posNum > 0) return { closeSide: "sell", orderPosSide: "net" };
  if (detail.posNum < 0) return { closeSide: "buy", orderPosSide: "net" };
  return { closeSide: "sell", orderPosSide: "net" };
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
 * @param {string} p.posSide
 * @param {string} p.clOrdId
 */
async function placeMarket(client, p) {
  const body = JSON.stringify({
    instId: p.instId,
    tdMode: p.tdMode,
    side: p.side,
    ordType: "market",
    sz: p.sz,
    posSide: p.posSide,
    reduceOnly: p.reduceOnly,
    clOrdId: p.clOrdId,
  });
  return client.request("POST", "/api/v5/trade/order", body);
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
 * 集成冒烟：市价开多（最小张数）再全部平仓。用于 `tests/okx-swap-open-close.test.js` 或手动验证。
 * 需该合约无持仓、且账户有足够 USDT 可用保证金（模拟盘用模拟 API Key）。
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.secretKey
 * @param {string} opts.passphrase
 * @param {boolean} [opts.simulated=true]
 * @param {string} [opts.instId="BTC-USDT-SWAP"]
 * @param {"cross"|"isolated"} [opts.tdMode="cross"]
 * @param {number} [opts.lever=10]
 */
async function smokeSwapOpenLongThenClose(opts) {
  const {
    apiKey,
    secretKey,
    passphrase,
    simulated = true,
    instId = "BTC-USDT-SWAP",
    tdMode = "cross",
    lever = 10,
  } = opts;

  if (!apiKey || !secretKey || !passphrase) {
    throw new Error("缺少 apiKey / secretKey / passphrase");
  }

  const mgn = tdMode === "isolated" ? "isolated" : "cross";
  const client = createOkxClient({ apiKey, secretKey, passphrase, simulated });
  const posMode = await fetchAccountPosMode(client);

  const existing = await fetchSwapPositionDetail(client, instId);
  if (existing.absPos > 0) {
    throw new Error(`${instId} 已有持仓，请先手动平仓后再跑冒烟测试`);
  }

  const inst = await fetchSwapInstrument(instId);
  const openSz = String(inst.minSz);
  const levStr = String(Math.min(125, Math.max(1, Math.floor(Number(lever) || 10))));

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

  const hedge = posMode === "hedge";
  const openPosSide = hedge ? "long" : "net";

  const openBody = await placeMarket(client, {
    instId,
    tdMode: mgn,
    side: "buy",
    sz: openSz,
    reduceOnly: false,
    posSide: openPosSide,
    clOrdId: clOrdIdFrom(crypto.randomUUID(), "op"),
  });
  const openOrdId = openBody.data?.[0]?.ordId ?? "";
  const openClOrdId = openBody.data?.[0]?.clOrdId ?? "";

  await delay(2000);
  let detail = await fetchSwapPositionDetail(client, instId);
  if (detail.absPos <= 0) {
    await delay(2000);
    detail = await fetchSwapPositionDetail(client, instId);
  }
  if (detail.absPos <= 0) {
    throw new Error("开仓后未读到持仓：请检查权限（Trade）、资金、或稍后在网络稳定时重试");
  }

  const { closeSide, orderPosSide } = resolveCloseParams(posMode, detail);
  const closeBody = await placeMarket(client, {
    instId,
    tdMode: mgn,
    side: closeSide,
    sz: String(detail.absPos),
    reduceOnly: true,
    posSide: orderPosSide,
    clOrdId: clOrdIdFrom(crypto.randomUUID(), "cl"),
  });
  const closeOrdId = closeBody.data?.[0]?.ordId ?? "";
  const closeClOrdId = closeBody.data?.[0]?.clOrdId ?? "";

  return {
    instId,
    openSz,
    openOrdId,
    openClOrdId,
    closeOrdId,
    closeClOrdId,
    simulated: !!simulated,
  };
}

/**
 * @param {object} cfg
 * @param {object} args
 * @param {import("electron").BrowserWindow | null} args.win
 * @param {string} args.tvSymbol
 * @param {string} args.transition
 * @param {object | null} args.tradeStateBefore
 * @param {object | null} args.hardExit
 * @param {string} args.barCloseId
 */
async function maybeExecuteOkxSwapOrders(cfg, args) {
  const { win, tvSymbol, transition, tradeStateBefore, hardExit, barCloseId } = args;

  const sendStatus = (payload) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send("okx-swap-status", payload);
    }
  };

  if (!cfg || cfg.okxSwapTradingEnabled !== true) return;

  if (inferFeed(tvSymbol) !== "crypto" || !String(tvSymbol || "").startsWith("OKX:")) return;

  const instId = tvSymbolToSwapInstId(tvSymbol);
  if (!instId) {
    sendStatus({ ok: false, message: "无效 OKX 品种代码" });
    return;
  }

  const apiKey = typeof cfg.okxApiKey === "string" ? cfg.okxApiKey.trim() : "";
  const secretKey = typeof cfg.okxSecretKey === "string" ? cfg.okxSecretKey.trim() : "";
  const passphrase = typeof cfg.okxPassphrase === "string" ? cfg.okxPassphrase.trim() : "";
  if (!apiKey || !secretKey || !passphrase) {
    sendStatus({ ok: false, message: "OKX API 未配置完整（okxApiKey / okxSecretKey / okxPassphrase）" });
    return;
  }

  const simulated = cfg.okxSimulated !== false;
  const tdMode = cfg.okxTdMode === "isolated" ? "isolated" : "cross";
  let lever = Number(cfg.okxSwapLeverage);
  if (!Number.isFinite(lever) || lever < 1) lever = 10;
  lever = Math.min(125, Math.max(1, Math.floor(lever)));
  let marginFrac = Number(cfg.okxSwapMarginFraction);
  if (!Number.isFinite(marginFrac) || marginFrac <= 0) marginFrac = 0.25;
  marginFrac = Math.min(1, Math.max(0.01, marginFrac));

  const client = createOkxClient({ apiKey, secretKey, passphrase, simulated });

  const isOpenLong = transition === "LOOKING_LONG->HOLDING_LONG";
  const isOpenShort = transition === "LOOKING_SHORT->HOLDING_SHORT";
  const isExitCooldown =
    transition === "HOLDING_LONG->COOLDOWN" || transition === "HOLDING_SHORT->COOLDOWN";
  const isHard = transition === "HARD_EXIT" && hardExit && hardExit.side;

  try {
    const posMode = await fetchAccountPosMode(client);

    if (isHard) {
      const detail = await fetchSwapPositionDetail(client, instId);
      if (detail.absPos <= 0) {
        sendStatus({ ok: true, message: `${instId} 硬触发：交易所无持仓，跳过平仓` });
        return;
      }
      const { closeSide, orderPosSide } = resolveCloseParams(posMode, detail);
      const ord = await placeMarket(client, {
        instId,
        tdMode,
        side: closeSide,
        sz: String(detail.absPos),
        reduceOnly: true,
        posSide: orderPosSide,
        clOrdId: clOrdIdFrom(barCloseId, "hx"),
      });
      const oid = ord.data?.[0]?.ordId ?? "";
      sendStatus({
        ok: true,
        message: `OKX 平仓（${simulated ? "模拟" : "实盘"}）${instId} ordId=${oid}`,
      });
      return;
    }

    if (isExitCooldown && tradeStateBefore) {
      const side = String(tradeStateBefore.positionSide || "").toUpperCase();
      if (side !== "LONG" && side !== "SHORT") return;
      const detail = await fetchSwapPositionDetail(client, instId);
      if (detail.absPos <= 0) {
        sendStatus({ ok: true, message: `${instId} 状态机平仓：交易所无持仓，跳过` });
        return;
      }
      const { closeSide, orderPosSide } = resolveCloseParams(posMode, detail);
      const ord = await placeMarket(client, {
        instId,
        tdMode,
        side: closeSide,
        sz: String(detail.absPos),
        reduceOnly: true,
        posSide: orderPosSide,
        clOrdId: clOrdIdFrom(barCloseId, "ex"),
      });
      const oid = ord.data?.[0]?.ordId ?? "";
      sendStatus({
        ok: true,
        message: `OKX 平仓（${simulated ? "模拟" : "实盘"}）${instId} ${side} ordId=${oid}`,
      });
      return;
    }

    if (!isOpenLong && !isOpenShort) return;

    const existing = await fetchSwapPositionDetail(client, instId);
    if (existing.absPos > 0) {
      sendStatus({ ok: false, message: `${instId} 已有永续持仓，跳过开仓` });
      return;
    }

    const avail = await fetchUsdtAvailEq(client);
    if (avail <= 0) throw new Error("USDT 可用权益为 0，无法开仓");

    const margin = avail * marginFrac;
    const notional = margin * lever;
    const inst = await fetchSwapInstrument(instId);
    const px = await fetchTickerLast(instId);
    let sz = notional / (inst.ctVal * px);
    sz = floorToLot(sz, inst.lotSz);
    if (sz < inst.minSz) {
      throw new Error(
        `计算张数 ${sz} 低于最小下单 ${inst.minSz}（可用 USDT ${avail.toFixed(2)}、保证金比例 ${marginFrac}、${lever}x）`,
      );
    }

    const levStr = String(lever);
    if (posMode === "hedge") {
      await setLeverageSafe(client, {
        instId,
        mgnMode: tdMode,
        lever: levStr,
        posSide: isOpenLong ? "long" : "short",
      });
    } else {
      await setLeverageSafe(client, {
        instId,
        mgnMode: tdMode,
        lever: levStr,
        posSide: "net",
      });
    }

    const hedge = posMode === "hedge";
    const posSide = hedge ? (isOpenLong ? "long" : "short") : "net";
    const side = isOpenLong ? "buy" : "sell";

    const ord = await placeMarket(client, {
      instId,
      tdMode,
      side,
      sz: String(sz),
      reduceOnly: false,
      posSide,
      clOrdId: clOrdIdFrom(barCloseId, isOpenLong ? "el" : "es"),
    });
    const oid = ord.data?.[0]?.ordId ?? "";
    sendStatus({
      ok: true,
      message: `OKX 开仓（${simulated ? "模拟" : "实盘"}）${instId} ${isOpenLong ? "多" : "空"} sz=${sz} ordId=${oid}`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[Argus] OKX 永续:", msg);
    sendStatus({ ok: false, message: msg });
  }
}

module.exports = {
  tvSymbolToSwapInstId,
  maybeExecuteOkxSwapOrders,
  smokeSwapOpenLongThenClose,
};
