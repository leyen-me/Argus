/**
 * 交易 Agent：OpenAI Chat Completions `tools` 定义（函数名 snake_case 便于模型稳定调用）。
 */

/** OpenAI Chat Completions `tools` 项（兼容多数 OpenAI 兼容网关） */
const TRADING_AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "prepare_watch",
      description:
        "进入「观察」状态：等待更好的触发位再开仓。相当于先计划方向与关键位，不立即下单。空仓或已平仓后使用。",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["long", "short"], description: "计划做多或做空" },
          key_level: { type: "number", description: "触发/确认用的关键价位（可选）" },
          stop_loss: { type: "number", description: "预案止损价（可选）" },
          take_profit: { type: "number", description: "预案止盈价（可选）" },
          confidence: { type: "number", description: "0-100，进入观察的把握" },
        },
        required: ["direction", "confidence"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_watch",
      description: "取消当前观察计划，回到空仓观望（不触及交易所挂单）。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "open_position",
      description:
        "开仓：市价或限价。若已开启 OKX 永续且为市价，会尝试真实下单；限价单仅提交交易所委托，模拟仓通常等成交后再在后续 K 线反映。须满足当前模拟状态机允许开仓。",
      parameters: {
        type: "object",
        properties: {
          side: { type: "string", enum: ["long", "short"] },
          order_type: { type: "string", enum: ["market", "limit"] },
          limit_price: { type: "number", description: "限价单价格（order_type=limit 时必填）" },
          key_level: { type: "number", description: "与观察态关键位一致时可带" },
          stop_loss: { type: "number", description: "成交后纪律型止损（模拟触价离场）" },
          take_profit: { type: "number", description: "成交后纪律型止盈（模拟触价离场）" },
          confidence: { type: "number", description: "0-100" },
        },
        required: ["side", "order_type", "confidence"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_position",
      description:
        "平仓：市价或限价平掉当前方向持仓。市价会尝试 OKX 全平；限价仅挂 reduce-only 委托。模拟仓仅在市价成功或（未启用 OKX 时）直接记为平仓冷静期。",
      parameters: {
        type: "object",
        properties: {
          order_type: { type: "string", enum: ["market", "limit"] },
          limit_price: { type: "number", description: "限价平仓价（limit 时必填）" },
          confidence: { type: "number", description: "0-100，须足够高才会更新模拟仓冷静期" },
        },
        required: ["order_type", "confidence"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_order",
      description: "撤销交易所当前品种未成交的普通挂单（ordId）。",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "OKX 返回的 ordId" },
        },
        required: ["order_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "amend_order",
      description: "修改未成交挂单的价格或张数（按 OKX 规则）。",
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
  {
    type: "function",
    function: {
      name: "set_stop_take",
      description:
        "在模拟仓「持仓」状态下，更新纪律型止损/止盈触价（与 K 线 high/low 比较用于硬离场）。至少填一个价位。",
      parameters: {
        type: "object",
        properties: {
          stop_loss: { type: "number", description: "新止损（可选，至少填一项）" },
          take_profit: { type: "number", description: "新止盈（可选）" },
          confidence: { type: "number", description: "0-100" },
        },
        required: ["confidence"],
      },
    },
  },
];

module.exports = { TRADING_AGENT_TOOLS };
