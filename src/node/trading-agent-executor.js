/**
 * 交易 Agent 工具：仅执行 OKX 永续 REST，无本地模拟仓。
 */
const okxPerp = require("./okx-perp");
const { notifyTradePositionIfNeeded } = require("./trade-notify-email");
const orderIntents = require("./order-intents-store");

/** 供单测注入 mock；生产路径使用默认实现。 */
const TRADING_EXECUTOR_DEFAULT_DEPS = Object.freeze({
  createOkxClient: okxPerp.createOkxClient,
  tvSymbolToSwapInstId: okxPerp.tvSymbolToSwapInstId,
  cancelSwapOrder: okxPerp.cancelSwapOrder,
  amendSwapOrder: okxPerp.amendSwapOrder,
  amendSwapAlgoOrder: okxPerp.amendSwapAlgoOrder,
  executeAgentPerpOpen: okxPerp.executeAgentPerpOpen,
  executeAgentPerpPreviewOpen: okxPerp.executeAgentPerpPreviewOpen,
  executeAgentPerpClose: okxPerp.executeAgentPerpClose,
  upsertOrderIntent: orderIntents.upsertOrderIntent,
  updateOrderIntent: orderIntents.updateOrderIntent,
  markOrderIntentStatus: orderIntents.markOrderIntentStatus,
  summarizeIntentText: orderIntents.summarizeIntentText,
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
 * @param {string} [ctx.interval] TradingView 周期（邮件正文）
 * @param {import("electron").BrowserWindow | null} [ctx.win]
 * @param {typeof TRADING_EXECUTOR_DEFAULT_DEPS} [deps]
 */
function createTradingToolExecutor(ctx, deps = TRADING_EXECUTOR_DEFAULT_DEPS) {
  const { cfg, tvSymbol, barCloseId, win, interval: ctxInterval } = ctx;
  const {
    createOkxClient,
    tvSymbolToSwapInstId,
    cancelSwapOrder,
    amendSwapOrder,
    amendSwapAlgoOrder,
    executeAgentPerpOpen,
    executeAgentPerpPreviewOpen,
    executeAgentPerpClose,
    upsertOrderIntent,
    updateOrderIntent,
    markOrderIntentStatus,
    summarizeIntentText,
  } = deps;

  const sendOkxStatus = (payload) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send("okx-swap-status", { ...payload, tvSymbol });
    }
  };

  const intervalLabel = typeof ctxInterval === "string" ? ctxInterval : "";

  const scheduleTradeNotify = (detail) => {
    void notifyTradePositionIfNeeded(cfg, { ...detail, interval: intervalLabel }).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[Argus] 交易邮件通知失败: ${msg}`);
    });
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

  return async function executeTradingTool(name, args, meta = {}) {
    const a = args && typeof args === "object" ? args : {};
    const assistantPreview =
      meta && typeof meta.assistantPreview === "string" ? meta.assistantPreview : "";
    const summarizeForIntent = (fallback) => summarizeIntentText("", fallback);
    const rememberIntent = (payload) => {
      try {
        upsertOrderIntent(payload);
      } catch (e) {
        console.warn("[Argus] 订单意图写入失败:", e);
      }
    };
    const patchIntent = (entityType, entityId, patch, fallbackPayload) => {
      try {
        const ok = updateOrderIntent(entityType, entityId, patch);
        if (!ok && fallbackPayload) upsertOrderIntent(fallbackPayload);
      } catch (e) {
        console.warn("[Argus] 订单意图更新失败:", e);
      }
    };
    const changeIntentStatus = (entityType, entityId, status, inactiveReason, extra) => {
      try {
        markOrderIntentStatus(entityType, entityId, status, inactiveReason, extra);
      } catch (e) {
        console.warn("[Argus] 订单意图状态更新失败:", e);
      }
    };

    try {
      switch (name) {
        case "preview_open_size": {
          const gate = requireOkx(cfg);
          if (!gate.ok) return { ok: false, message: gate.message };
          return executeAgentPerpPreviewOpen(cfg, {
            tvSymbol,
            leverage: a.leverage,
            margin_fraction: a.margin_fraction,
            margin_mode: a.margin_mode,
          });
        }
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
            leverage: a.leverage,
            margin_fraction: a.margin_fraction,
            margin_mode: a.margin_mode,
          });
          if (!ex.ok) {
            sendOkxStatus({ ok: false, message: ex.message || "开仓失败" });
            return { ok: false, message: ex.message || "开仓失败" };
          }
          const resolvedOpenOrderType = ex.orderType || orderType;
          const shouldNotifyOpen =
            resolvedOpenOrderType === "market" || (ex.position && ex.position.hasPosition === true);
          if (shouldNotifyOpen) {
            scheduleTradeNotify({
              tvSymbol,
              prevState: { state: "COOLDOWN" },
              nextState: { state: side === "long" ? "HOLDING_LONG" : "HOLDING_SHORT" },
              transition: "开仓",
              atIso: new Date().toISOString(),
            });
          }
          sendOkxStatus({ ok: true, message: `Agent 开仓 ${orderType} ordId=${ex.ordId || ""}` });
          if (orderType === "limit" && ex.ordId) {
            rememberIntent({
              entityType: "order",
              entityId: ex.ordId,
              tvSymbol,
              interval: ctxInterval,
              barCloseId,
              action: side === "short" ? "open_short_limit" : "open_long_limit",
              side,
              summary: summarizeForIntent(
                `在 ${a.limit_price} 挂${side === "short" ? "空" : "多"}限价单，等待更优位置成交。`,
              ),
              thesis: assistantPreview,
              limitPrice: a.limit_price,
              size: ex.sz,
              takeProfitTriggerPrice: tpTriggerPx,
              stopLossTriggerPrice: slTriggerPx,
              status: "active",
              rawArgs: a,
            });
          }
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
          if (ex.preCloseHoldingState) {
            scheduleTradeNotify({
              tvSymbol,
              prevState: { state: ex.preCloseHoldingState },
              nextState: { state: "COOLDOWN" },
              transition: "平仓",
              atIso: new Date().toISOString(),
            });
          }
          sendOkxStatus({ ok: true, message: `Agent 平仓 ${orderType} ordId=${ex.ordId || ""}` });
          const closedSide =
            ex.preCloseHoldingState === "HOLDING_SHORT"
              ? "short"
              : ex.preCloseHoldingState === "HOLDING_LONG"
                ? "long"
                : null;
          if (orderType === "limit" && ex.ordId) {
            rememberIntent({
              entityType: "order",
              entityId: ex.ordId,
              tvSymbol,
              interval: ctxInterval,
              barCloseId,
              action: "close_position_limit",
              side: closedSide,
              summary: summarizeForIntent(
                `在 ${a.limit_price} 挂限价平仓单，等待更优价格离场。`,
              ),
              thesis: assistantPreview,
              limitPrice: a.limit_price,
              size: ex.closeSz,
              status: "active",
              rawArgs: a,
            });
          }
          return {
            ok: true,
            message: `平仓单已提交，ordId=${ex.ordId}`,
            exchange: { ordId: ex.ordId, closeSz: ex.closeSz },
            closedSide,
          };
        }
        case "cancel_order": {
          const triplet = makeClient();
          if (!triplet.ok) return { ok: false, message: triplet.message };
          const instId = tvSymbolToSwapInstId(tvSymbol);
          if (!instId) return { ok: false, message: "无效品种" };
          await cancelSwapOrder(triplet.client, instId, String(a.order_id));
          changeIntentStatus("order", String(a.order_id), "cancelled", "cancel_order", {
            thesis: assistantPreview || undefined,
          });
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
          patchIntent(
            "order",
            String(a.order_id),
            {
              tvSymbol,
              interval: ctxInterval,
              barCloseId,
              action: "amend_order",
              summary: summarizeForIntent("调整普通限价挂单参数。"),
              thesis: assistantPreview || undefined,
              limitPrice: a.new_price ?? undefined,
              size: a.new_size ?? undefined,
              status: "active",
              inactiveReason: null,
              rawArgs: a,
            },
            {
              entityType: "order",
              entityId: String(a.order_id),
              tvSymbol,
              interval: ctxInterval,
              barCloseId,
              action: "amend_order",
              summary: summarizeForIntent("调整普通限价挂单参数。"),
              thesis: assistantPreview,
              limitPrice: a.new_price,
              size: a.new_size,
              status: "active",
              rawArgs: a,
            },
          );
          sendOkxStatus({ ok: true, message: `改单 ordId=${a.order_id}` });
          return { ok: true, message: "改单已提交" };
        }
        case "amend_tp_sl": {
          const triplet = makeClient();
          if (!triplet.ok) return { ok: false, message: triplet.message };
          const instId = tvSymbolToSwapInstId(tvSymbol);
          if (!instId) return { ok: false, message: "无效品种" };
          const algoId = a.algo_id != null ? String(a.algo_id).trim() : "";
          if (!algoId) {
            return { ok: false, message: "amend_tp_sl 需要提供 algo_id（见 pending_algo_orders）" };
          }
          /** @param {unknown} v */
          const pickNum = (v) => {
            if (v === undefined || v === null) return undefined;
            if (typeof v === "string" && v.trim() === "") return undefined;
            const n = Number(v);
            return Number.isFinite(n) ? n : undefined;
          };
          const newSz = pickNum(a.new_size);
          const newTpTriggerPx = pickNum(a.take_profit_trigger_price);
          const newSlTriggerPx = pickNum(a.stop_loss_trigger_price);
          const newTpOrdPx = pickNum(a.take_profit_order_price);
          const newSlOrdPx = pickNum(a.stop_loss_order_price);
          if (
            newSz === undefined &&
            newTpTriggerPx === undefined &&
            newSlTriggerPx === undefined &&
            newTpOrdPx === undefined &&
            newSlOrdPx === undefined
          ) {
            return {
              ok: false,
              message:
                "amend_tp_sl 至少需要 new_size、take_profit_trigger_price、stop_loss_trigger_price、take_profit_order_price、stop_loss_order_price 之一",
            };
          }
          let tpSlTriggerPxType = String(a.tp_sl_trigger_price_type || "last").toLowerCase();
          if (tpSlTriggerPxType !== "mark" && tpSlTriggerPxType !== "index") {
            tpSlTriggerPxType = "last";
          }
          const patch = { instId, algoId, tpSlTriggerPxType };
          if (newSz !== undefined) patch.newSz = newSz;
          if (newTpTriggerPx !== undefined) patch.newTpTriggerPx = newTpTriggerPx;
          if (newSlTriggerPx !== undefined) patch.newSlTriggerPx = newSlTriggerPx;
          if (newTpOrdPx !== undefined) patch.newTpOrdPx = newTpOrdPx;
          if (newSlOrdPx !== undefined) patch.newSlOrdPx = newSlOrdPx;
          await amendSwapAlgoOrder(triplet.client, patch);
          patchIntent(
            "algo",
            algoId,
            {
              tvSymbol,
              interval: ctxInterval,
              barCloseId,
              action: "amend_tp_sl",
              summary: summarizeForIntent("调整止盈止损算法单。"),
              thesis: assistantPreview || undefined,
              size: newSz ?? undefined,
              takeProfitTriggerPrice: newTpTriggerPx ?? undefined,
              stopLossTriggerPrice: newSlTriggerPx ?? undefined,
              status: "active",
              inactiveReason: null,
              rawArgs: a,
            },
            {
              entityType: "algo",
              entityId: algoId,
              tvSymbol,
              interval: ctxInterval,
              barCloseId,
              action: "amend_tp_sl",
              summary: summarizeForIntent("调整止盈止损算法单。"),
              thesis: assistantPreview,
              size: newSz,
              takeProfitTriggerPrice: newTpTriggerPx,
              stopLossTriggerPrice: newSlTriggerPx,
              status: "active",
              rawArgs: a,
            },
          );
          sendOkxStatus({ ok: true, message: `改算法止盈止损 algoId=${algoId}` });
          return { ok: true, message: `止盈止损算法单已提交修改 algoId=${algoId}` };
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
