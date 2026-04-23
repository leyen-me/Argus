/**
 * 交易 Agent：仅对接 OKX 永续 REST（OpenAI Chat Completions tools）。
 */

const TRADING_AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "preview_open_size",
      description:
        "仅做预估，不会下单。基于当前 OKX 账户可用权益、最新价格和给定风险参数，计算预估可开张数、保证金、名义价值及是否满足最小下单张数。适合在开仓前复核 sizing；省略 leverage、margin_fraction、margin_mode 时会回退到内置默认值。",
      parameters: {
        type: "object",
        properties: {
          leverage: {
            type: "integer",
            description: "可选，杠杆倍数，范围 1-125；省略时回退到内置默认值。",
          },
          margin_fraction: {
            type: "number",
            description: "可选，占用当前可用 USDT 权益的比例，建议范围 0.01-1；省略时回退到内置默认值。",
          },
          margin_mode: {
            type: "string",
            enum: ["isolated", "cross"],
            description: "可选，保证金模式；isolated=逐仓，cross=全仓。省略时回退到内置默认值。",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_position",
      description:
        "提交开仓单，支持市价和限价。调用前应先完成方向、杠杆、仓位和保证金模式判断；建议先用 preview_open_size 复核 sizing。限价单提交后可能处于未成交状态；若同时提供止盈止损触发价，主单成交后会由 OKX 创建对应的平仓算法单。",
      parameters: {
        type: "object",
        properties: {
          side: {
            type: "string",
            enum: ["long", "short"],
            description: "开仓方向；long=做多，short=做空。",
          },
          order_type: {
            type: "string",
            enum: ["market", "limit"],
            description: "委托类型；market=市价立即成交，limit=按指定价格挂限价单。",
          },
          leverage: {
            type: "integer",
            description: "杠杆倍数，范围 1-125。预估名义价值约等于保证金乘以杠杆。",
          },
          margin_fraction: {
            type: "number",
            description:
              "占用当前可用 USDT 权益的比例，建议范围 0.01-1。请结合 account_snapshot 控制风险；最终下单张数由程序按交易所规则计算。",
          },
          margin_mode: {
            type: "string",
            enum: ["isolated", "cross"],
            description: "保证金模式；isolated=逐仓，cross=全仓（与 OKX tdMode 一致）。",
          },
          limit_price: {
            type: "number",
            description: "限价价格；当 order_type=limit 时必填。",
          },
          take_profit_trigger_price: {
            type: "number",
            description: "可选，止盈触发价。做多时通常应高于入场参考价，做空时通常应低于入场参考价；触发后按市价平仓。",
          },
          stop_loss_trigger_price: {
            type: "number",
            description: "可选，止损触发价。做多时通常应低于入场参考价，做空时通常应高于入场参考价；触发后按市价平仓。",
          },
          tp_sl_trigger_price_type: {
            type: "string",
            enum: ["last", "mark", "index"],
            description: "可选，止盈止损的触发价格基准；last=最新价，mark=标记价，index=指数价。默认值为 last。",
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
        "平掉当前合约方向的现有持仓，只做 reduce-only，不会反手开仓。支持市价和限价；市价单会等待成交，限价单只提交挂单。",
      parameters: {
        type: "object",
        properties: {
          order_type: {
            type: "string",
            enum: ["market", "limit"],
            description: "委托类型；market=市价平仓，limit=按指定价格挂限价平仓单。",
          },
          limit_price: {
            type: "number",
            description: "限价价格；当 order_type=limit 时必填。",
          },
        },
        required: ["order_type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_order",
      description: "撤销当前合约上尚未成交的普通委托单。仅适用于普通委托，不用于止盈止损等算法单。",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "OKX 普通委托的 ordId。" },
        },
        required: ["order_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "amend_order",
      description: "修改尚未成交的限价挂单，可调整价格、数量，或两者同时调整；至少提供 new_price、new_size 之一。",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "待修改委托的 OKX ordId。" },
          new_price: { type: "number", description: "可选，新的限价价格。" },
          new_size: { type: "number", description: "可选，新的委托张数。" },
        },
        required: ["order_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "amend_tp_sl",
      description:
        "修改当前合约上未触发的止盈止损/条件类算法单（用户快照里的 pending_algo_orders，使用其中的 algoId）。对接 OKX amend-algos。至少提供 new_size、take_profit_trigger_price、stop_loss_trigger_price、take_profit_order_price、stop_loss_order_price 之一。触发价基准默认 last，可与开仓时一致选 mark/index。说明：交易所文档载明不支持移动止损、冰山、TWAP、Trailing 等算法类型；删除止盈/止损腿时可将对应触发价或委托价设为 0（以 OKX 文档为准）。",
      parameters: {
        type: "object",
        properties: {
          algo_id: { type: "string", description: "待修改算法单的 OKX algoId。" },
          new_size: { type: "number", description: "可选，修改后的委托张数（newSz）。" },
          take_profit_trigger_price: {
            type: "number",
            description: "可选，新的止盈触发价；与 stop_loss_trigger_price 等同向参考当前持仓方向填写。",
          },
          stop_loss_trigger_price: { type: "number", description: "可选，新的止损触发价。" },
          take_profit_order_price: {
            type: "number",
            description: "可选，止盈触发后的委托价；-1 表示触发后市价成交（与 OKX 约定一致）。",
          },
          stop_loss_order_price: {
            type: "number",
            description: "可选，止损触发后的委托价；-1 表示触发后市价成交。",
          },
          tp_sl_trigger_price_type: {
            type: "string",
            enum: ["last", "mark", "index"],
            description: "可选，止盈/止损触发价基准；last=最新价，mark=标记价，index=指数价。默认 last。",
          },
        },
        required: ["algo_id"],
      },
    },
  },
];

module.exports = { TRADING_AGENT_TOOLS };
