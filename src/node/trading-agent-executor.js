/**
 * 交易 Agent 工具：仅执行 OKX 永续 REST，无本地模拟仓。
 */
const okxPerp = require("./okx-perp");

/** 供单测注入 mock；生产路径使用默认实现。 */
const TRADING_EXECUTOR_DEFAULT_DEPS = Object.freeze({
  createOkxClient: okxPerp.createOkxClient,
  tvSymbolToSwapInstId: okxPerp.tvSymbolToSwapInstId,
  cancelSwapOrder: okxPerp.cancelSwapOrder,
  amendSwapOrder: okxPerp.amendSwapOrder,
  executeAgentPerpOpen: okxPerp.executeAgentPerpOpen,
  executeAgentPerpClose: okxPerp.executeAgentPerpClose,
});

function requireOkx(cfg) {
  if (!cfg || cfg.okxSwapTradingEnabled !== true) {
    return { ok: false, message: "请在配置中心启用「OKX 永续」并填写 API Key / Secret / Passphrase。" };
  }
  const apiKey = typeof cfg.okxApiKey === "string" ? cfg.okxApiKey.trim() : "";
  const secretKey = typeof cfg.okxSecretKey === "string" ? cfg.okxSecretKey.trim() : "";
  const passphrase = typeof cfg.okxPassphrase === "string" ? cfg.okxPassphrase.trim() : "";
  if (!apiKey || !secretKey || !passphrase) {
    return { ok: false, message: "OKX API 未配置完整。" };
  }
  return { ok: true };
}

/**
 * @param {object} ctx
 * @param {object} ctx.cfg
 * @param {string} ctx.tvSymbol
 * @param {string} ctx.barCloseId
 * @param {import("electron").BrowserWindow | null} [ctx.win]
 * @param {typeof TRADING_EXECUTOR_DEFAULT_DEPS} [deps]
 */
function createTradingToolExecutor(ctx, deps = TRADING_EXECUTOR_DEFAULT_DEPS) {
  const { cfg, tvSymbol, barCloseId, win } = ctx;
  const {
    createOkxClient,
    tvSymbolToSwapInstId,
    cancelSwapOrder,
    amendSwapOrder,
    executeAgentPerpOpen,
    executeAgentPerpClose,
  } = deps;

  const sendOkxStatus = (payload) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send("okx-swap-status", { ...payload, tvSymbol });
    }
  };

  const makeClient = () => {
    const gate = requireOkx(cfg);
    if (!gate.ok) return gate;
    const apiKey = cfg.okxApiKey.trim();
    const secretKey = cfg.okxSecretKey.trim();
    const passphrase = cfg.okxPassphrase.trim();
    const simulated = cfg.okxSimulated !== false;
    return {
      ok: true,
      client: createOkxClient({ apiKey, secretKey, passphrase, simulated }),
      simulated,
    };
  };

  return async function executeTradingTool(name, args) {
    const a = args && typeof args === "object" ? args : {};

    try {
      switch (name) {
        case "open_position": {
          const gate = requireOkx(cfg);
          if (!gate.ok) return { ok: false, message: gate.message };
          const side = String(a.side || "").toLowerCase() === "short" ? "short" : "long";
          const orderType = String(a.order_type || "market").toLowerCase() === "limit" ? "limit" : "market";
          const pickPx = (v) => {
            if (v == null) return undefined;
            const n = Number(v);
            return Number.isFinite(n) ? n : undefined;
          };
          const tpTriggerPx = pickPx(a.take_profit_trigger_price ?? a.tp_trigger_price);
          const slTriggerPx = pickPx(a.stop_loss_trigger_price ?? a.sl_trigger_price);
          let tpSlTriggerPxType = String(a.tp_sl_trigger_price_type || "last").toLowerCase();
          if (tpSlTriggerPxType !== "mark" && tpSlTriggerPxType !== "index") {
            tpSlTriggerPxType = "last";
          }
          const ex = await executeAgentPerpOpen(cfg, {
            tvSymbol,
            side,
            orderType,
            limitPrice: a.limit_price,
            barCloseId,
            tpTriggerPx,
            slTriggerPx,
            tpSlTriggerPxType,
          });
          if (!ex.ok) {
            sendOkxStatus({ ok: false, message: ex.message || "开仓失败" });
            return { ok: false, message: ex.message || "开仓失败" };
          }
          sendOkxStatus({ ok: true, message: `Agent 开仓 ${orderType} ordId=${ex.ordId || ""}` });
          return {
            ok: true,
            message:
              orderType === "market"
                ? `市价开仓已提交，ordId=${ex.ordId}，均价约 ${ex.avgPx ?? "（见持仓）"}`
                : `限价开仓已提交，ordId=${ex.ordId}，请留意挂单是否成交`,
            exchange: { ordId: ex.ordId, sz: ex.sz, avgPx: ex.avgPx },
          };
        }
        case "close_position": {
          const gate = requireOkx(cfg);
          if (!gate.ok) return { ok: false, message: gate.message };
          const orderType = String(a.order_type || "market").toLowerCase() === "limit" ? "limit" : "market";
          const ex = await executeAgentPerpClose(cfg, {
            tvSymbol,
            orderType,
            limitPrice: a.limit_price,
          });
          if (!ex.ok) {
            sendOkxStatus({ ok: false, message: ex.message || "平仓失败" });
            return { ok: false, message: ex.message || "平仓失败" };
          }
          sendOkxStatus({ ok: true, message: `Agent 平仓 ${orderType} ordId=${ex.ordId || ""}` });
          return {
            ok: true,
            message: `平仓单已提交，ordId=${ex.ordId}`,
            exchange: { ordId: ex.ordId, closeSz: ex.closeSz },
          };
        }
        case "cancel_order": {
          const triplet = makeClient();
          if (!triplet.ok) return { ok: false, message: triplet.message };
          const instId = tvSymbolToSwapInstId(tvSymbol);
          if (!instId) return { ok: false, message: "无效品种" };
          await cancelSwapOrder(triplet.client, instId, String(a.order_id));
          sendOkxStatus({ ok: true, message: `撤单 ordId=${a.order_id}` });
          return { ok: true, message: `已撤单 ${a.order_id}` };
        }
        case "amend_order": {
          const triplet = makeClient();
          if (!triplet.ok) return { ok: false, message: triplet.message };
          const instId = tvSymbolToSwapInstId(tvSymbol);
          if (!instId) return { ok: false, message: "无效品种" };
          if (a.new_price == null && a.new_size == null) {
            return { ok: false, message: "amend_order 需要提供 new_price 或 new_size" };
          }
          const patch = { instId, ordId: String(a.order_id) };
          if (a.new_price != null) patch.newPx = a.new_price;
          if (a.new_size != null) patch.newSz = a.new_size;
          await amendSwapOrder(triplet.client, patch);
          sendOkxStatus({ ok: true, message: `改单 ordId=${a.order_id}` });
          return { ok: true, message: "改单已提交" };
        }
        default:
          return { ok: false, message: `未知工具：${name}` };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendOkxStatus({ ok: false, message: msg });
      return { ok: false, message: msg };
    }
  };
}

module.exports = {
  createTradingToolExecutor,
  TRADING_EXECUTOR_DEFAULT_DEPS,
  requireOkx,
};
