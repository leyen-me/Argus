/**
 * 交易 Agent 工具执行：桥接 OKX REST 与 trading-state 模拟纪律。
 */
const {
  createOkxClient,
  tvSymbolToSwapInstId,
  cancelSwapOrder,
  amendSwapOrder,
  executeAgentPerpOpen,
  executeAgentPerpClose,
} = require("./okx-perp");
const {
  agentPrepareWatch,
  agentCancelWatch,
  agentCanOpen,
  applyAgentOpenFilled,
  applyAgentClose,
  applyAgentDisciplineRisk,
} = require("./trading-state");

/**
 * @param {object} ctx
 * @param {string} ctx.convKey
 * @param {object} ctx.candle
 * @param {object} ctx.cfg
 * @param {string} ctx.tvSymbol
 * @param {string} ctx.barCloseId
 * @param {import("electron").BrowserWindow | null} [ctx.win]
 */
function createTradingToolExecutor(ctx) {
  const { convKey, candle, cfg, tvSymbol, barCloseId, win } = ctx;

  const sendOkxStatus = (payload) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send("okx-swap-status", { ...payload, tvSymbol });
    }
  };

  const okxClientTriplet = () => {
    const apiKey = typeof cfg.okxApiKey === "string" ? cfg.okxApiKey.trim() : "";
    const secretKey = typeof cfg.okxSecretKey === "string" ? cfg.okxSecretKey.trim() : "";
    const passphrase = typeof cfg.okxPassphrase === "string" ? cfg.okxPassphrase.trim() : "";
    if (!apiKey || !secretKey || !passphrase) return null;
    const simulated = cfg.okxSimulated !== false;
    return { client: createOkxClient({ apiKey, secretKey, passphrase, simulated }), simulated };
  };

  /**
   * @param {string} name
   * @param {Record<string, unknown>} args
   */
  return async function executeTradingTool(name, args) {
    const now = Date.now();
    const a = args && typeof args === "object" ? args : {};

    try {
      switch (name) {
        case "prepare_watch": {
          const direction = String(a.direction || "").toLowerCase() === "short" ? "SHORT" : "LONG";
          const r = agentPrepareWatch(
            convKey,
            {
              direction,
              keyLevel: a.key_level,
              stopLoss: a.stop_loss,
              takeProfit: a.take_profit,
              confidence: a.confidence,
            },
            now,
          );
          return { ok: r.ok, trade_state: r.tradeState, message: r.reason || "ok" };
        }
        case "cancel_watch": {
          const r = agentCancelWatch(convKey, now);
          return { ok: r.ok, trade_state: r.tradeState, message: r.reason || "ok" };
        }
        case "open_position": {
          const side = String(a.side || "").toLowerCase() === "short" ? "SHORT" : "LONG";
          const orderType = String(a.order_type || "market").toLowerCase() === "limit" ? "limit" : "market";
          const can = agentCanOpen(
            convKey,
            candle,
            {
              side,
              confidence: a.confidence,
              keyLevel: a.key_level,
            },
            now,
          );
          if (!can.ok) {
            return { ok: false, message: can.reason || "不可开仓" };
          }

          const openOpts = {
            side,
            stopLoss: a.stop_loss,
            takeProfit: a.take_profit,
            keyLevel: can.ref,
          };

          if (cfg.okxSwapTradingEnabled === true) {
            const ex = await executeAgentPerpOpen(cfg, {
              tvSymbol,
              side: side.toLowerCase(),
              orderType,
              limitPrice: a.limit_price,
              barCloseId,
            });
            if (!ex.ok) {
              sendOkxStatus({ ok: false, message: ex.message || "开仓失败" });
              return { ok: false, message: ex.message || "OKX 开仓失败" };
            }
            sendOkxStatus({ ok: true, message: `Agent 开仓 ${orderType} ordId=${ex.ordId || ""}` });

            if (orderType === "market") {
              const entry = Number.isFinite(Number(ex.avgPx)) ? Number(ex.avgPx) : Number(candle?.close);
              const fill = applyAgentOpenFilled(convKey, candle, {
                ...openOpts,
                entryPrice: entry,
              }, now);
              return {
                ok: fill.ok,
                trade_state: fill.tradeState,
                message: fill.ok ? `市价开仓已成交，均价约 ${entry}` : fill.reason,
                exchange: { ordId: ex.ordId, sz: ex.sz },
              };
            }
            return {
              ok: true,
              message:
                "限价开仓单已提交；模拟仓本轮不入账，请在下根 K 线根据 pending_orders / 成交再决策。",
              exchange: { ordId: ex.ordId, sz: ex.sz },
            };
          }

          const fill = applyAgentOpenFilled(
            convKey,
            candle,
            { ...openOpts, entryPrice: candle?.close },
            now,
          );
          return {
            ok: fill.ok,
            trade_state: fill.tradeState,
            message: fill.ok ? "模拟市价开仓（未接 OKX）" : fill.reason,
          };
        }
        case "close_position": {
          const orderType = String(a.order_type || "market").toLowerCase() === "limit" ? "limit" : "market";
          const confidence = a.confidence;

          if (cfg.okxSwapTradingEnabled === true) {
            const ex = await executeAgentPerpClose(cfg, {
              tvSymbol,
              orderType,
              limitPrice: a.limit_price,
            });
            if (ex.ok && orderType === "market") {
              const sim = applyAgentClose(convKey, { confidence }, now);
              sendOkxStatus({ ok: true, message: `Agent 平仓市价 ordId=${ex.ordId || ""}` });
              return {
                ok: sim.ok,
                trade_state: sim.tradeState,
                message: sim.ok ? "交易所市价平仓与模拟仓已同步" : sim.reason,
                exchange: { ordId: ex.ordId },
              };
            }
            if (!ex.ok && /无持仓/.test(String(ex.message || ""))) {
              const sim = applyAgentClose(convKey, { confidence }, now);
              sendOkxStatus({ ok: true, message: "交易所无仓，已尝试仅更新模拟仓" });
              return {
                ok: sim.ok,
                trade_state: sim.tradeState,
                message: sim.ok ? "仅模拟仓平仓" : sim.reason,
              };
            }
            if (ex.ok && orderType === "limit") {
              sendOkxStatus({ ok: true, message: `Agent 平仓限价 ordId=${ex.ordId || ""}` });
              return {
                ok: true,
                message: "限价平仓单已挂；模拟仓冷静期未触发，待成交后再管理风险。",
                exchange: { ordId: ex.ordId },
              };
            }
            sendOkxStatus({ ok: false, message: ex.message || "平仓失败" });
            return { ok: false, message: ex.message || "OKX 平仓失败" };
          }

          const sim = applyAgentClose(convKey, { confidence }, now);
          return {
            ok: sim.ok,
            trade_state: sim.tradeState,
            message: sim.ok ? "模拟平仓" : sim.reason,
          };
        }
        case "cancel_order": {
          const triplet = okxClientTriplet();
          if (!triplet) return { ok: false, message: "OKX 未配置" };
          const instId = tvSymbolToSwapInstId(tvSymbol);
          if (!instId) return { ok: false, message: "无效品种" };
          await cancelSwapOrder(triplet.client, instId, String(a.order_id));
          sendOkxStatus({ ok: true, message: `撤单 ordId=${a.order_id}` });
          return { ok: true, message: `已撤单 ${a.order_id}` };
        }
        case "amend_order": {
          const triplet = okxClientTriplet();
          if (!triplet) return { ok: false, message: "OKX 未配置" };
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
        case "set_stop_take": {
          const r = applyAgentDisciplineRisk(
            convKey,
            {
              stopLoss: a.stop_loss,
              takeProfit: a.take_profit,
              confidence: a.confidence,
            },
            now,
          );
          return { ok: r.ok, trade_state: r.tradeState, message: r.reason || "ok" };
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

module.exports = { createTradingToolExecutor };
