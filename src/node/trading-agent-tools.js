/**
 * 交易 Agent：仅对接 OKX 永续 REST（OpenAI Chat Completions tools）。
 */

const TRADING_AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "open_position",
      description:
        "开仓：市价或限价。须在配置中启用 OKX 永续并填写 API。杠杆、保证金占比、逐仓/全仓由你根据本轮风险与仓位管理自行指定。限价单提交后未成交则持仓不变；下根 K 线可从挂单列表再判断。建议同时填写止盈/止损触发价：主单全部成交后 OKX 按触发价挂市价平仓（attachAlgoOrds）。",
      parameters: {
        type: "object",
        properties: {
          side: { type: "string", enum: ["long", "short"] },
          order_type: { type: "string", enum: ["market", "limit"] },
          leverage: {
            type: "integer",
            description: "杠杆倍数（1–125）。名义 ≈ 保证金 × 杠杆；保证金 = 可用 USDT × margin_fraction。",
          },
          margin_fraction: {
            type: "number",
            description: "占用当前 USDT 可用权益的比例（建议 0.01–1），用于计算保证金与张数。",
          },
          margin_mode: {
            type: "string",
            enum: ["isolated", "cross"],
            description: "isolated=逐仓；cross=全仓（与 OKX tdMode 一致）。",
          },
          limit_price: { type: "number", description: "order_type=limit 时必填" },
          take_profit_trigger_price: {
            type: "number",
            description: "止盈触发价（可选）。多头须高于入场参考价，空头须低于。触发后市价平仓。",
          },
          stop_loss_trigger_price: {
            type: "number",
            description: "止损触发价（可选）。多头须低于参考价，空头须高于。触发后市价平仓。",
          },
          tp_sl_trigger_price_type: {
            type: "string",
            enum: ["last", "mark", "index"],
            description: "止盈/止损触发基准，默认 last（最新价）",
          },
        },
        required: ["side", "order_type", "leverage", "margin_fraction", "margin_mode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_position",
      description:
        "平仓：市价或限价全平当前合约方向持仓（reduce-only）。市价会等待成交；限价仅挂单。",
      parameters: {
        type: "object",
        properties: {
          order_type: { type: "string", enum: ["market", "limit"] },
          limit_price: { type: "number", description: "order_type=limit 时必填" },
        },
        required: ["order_type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_order",
      description: "撤销当前合约未成交的普通委托（ordId）。",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "OKX ordId" },
        },
        required: ["order_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "amend_order",
      description: "修改未成交挂单的价格或张数（至少改一项）。",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string" },
          new_price: { type: "number", description: "新限价（可选）" },
          new_size: { type: "number", description: "新张数（可选）" },
        },
        required: ["order_id"],
      },
    },
  },
];

module.exports = { TRADING_AGENT_TOOLS };
