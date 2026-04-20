/**
 * 交易 Agent：仅对接 OKX 永续 REST（OpenAI Chat Completions tools）。
 */

const TRADING_AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "open_position",
      description:
        "开仓：市价或限价。须在配置中启用 OKX 永续并填写 API。限价单提交后未成交则持仓不变；下根 K 线可从挂单列表再判断。",
      parameters: {
        type: "object",
        properties: {
          side: { type: "string", enum: ["long", "short"] },
          order_type: { type: "string", enum: ["market", "limit"] },
          limit_price: { type: "number", description: "order_type=limit 时必填" },
        },
        required: ["side", "order_type"],
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
