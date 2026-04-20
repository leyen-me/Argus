const TradingState = Object.freeze({
  IDLE: "IDLE",
  LOOKING_LONG: "LOOKING_LONG",
  LOOKING_SHORT: "LOOKING_SHORT",
  HOLDING_LONG: "HOLDING_LONG",
  HOLDING_SHORT: "HOLDING_SHORT",
  COOLDOWN: "COOLDOWN",
});

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const EARLY_EXIT_COOLDOWN_MS = 60 * 1000;
const MIN_LOOK_CONFIDENCE = 80;
const MIN_ENTER_CONFIDENCE = 80;
const MIN_EXIT_CONFIDENCE = 90;
/** 持仓 intent 为 HOLD 时，用 JSON 中的止损/止盈更新纪律价位的最低置信度 */
const MIN_HOLD_RISK_ADJUST_CONFIDENCE = 80;

let store = Object.create(null);

function blankState() {
  return {
    state: TradingState.IDLE,
    pendingDirection: null,
    positionSide: null,
    keyLevel: null,
    entryPrice: null,
    stopLoss: null,
    takeProfit: null,
    cooldownUntil: 0,
    lastTransitionAt: 0,
    lastTransitionReason: null,
    lastDecisionIntent: null,
  };
}

function roundPrice(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e6) / 1e6;
}

function toPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return roundPrice(n);
}

function cloneState(state) {
  return {
    state: state.state,
    pendingDirection: state.pendingDirection,
    positionSide: state.positionSide,
    keyLevel: state.keyLevel,
    entryPrice: state.entryPrice,
    stopLoss: state.stopLoss,
    takeProfit: state.takeProfit,
    cooldownUntil: state.cooldownUntil,
    lastTransitionAt: state.lastTransitionAt,
    lastTransitionReason: state.lastTransitionReason,
    lastDecisionIntent: state.lastDecisionIntent,
  };
}

function getMutableState(key) {
  const k = String(key || "").trim();
  if (!k) return blankState();
  if (!store[k]) store[k] = blankState();
  return store[k];
}

function getTradingState(key) {
  return cloneState(getMutableState(key));
}

function clearPositionFields(state) {
  state.pendingDirection = null;
  state.positionSide = null;
  state.keyLevel = null;
  state.entryPrice = null;
  state.stopLoss = null;
  state.takeProfit = null;
}

function touchTransition(state, now, reason, intent) {
  state.lastTransitionAt = now;
  state.lastTransitionReason = reason || null;
  state.lastDecisionIntent = intent || null;
}

function resetToIdle(state, now, reason, intent) {
  clearPositionFields(state);
  state.cooldownUntil = 0;
  state.state = TradingState.IDLE;
  touchTransition(state, now, reason, intent);
}

function enterCooldown(state, now, reason, cooldownMs, intent) {
  clearPositionFields(state);
  state.cooldownUntil = now + cooldownMs;
  state.state = TradingState.COOLDOWN;
  touchTransition(state, now, reason, intent);
}

function getAllowedIntentsForState(currentState) {
  switch (currentState) {
    case TradingState.IDLE:
      return ["WAIT", "LOOK_LONG", "LOOK_SHORT"];
    case TradingState.LOOKING_LONG:
      return ["WAIT", "CANCEL_LOOKING", "ENTER_LONG"];
    case TradingState.LOOKING_SHORT:
      return ["WAIT", "CANCEL_LOOKING", "ENTER_SHORT"];
    case TradingState.HOLDING_LONG:
      return ["HOLD", "EXIT_LONG"];
    case TradingState.HOLDING_SHORT:
      return ["HOLD", "EXIT_SHORT"];
    case TradingState.COOLDOWN:
      return ["WAIT"];
    default:
      return ["WAIT"];
  }
}

function expireCooldownIfNeeded(state, now) {
  if (state.state !== TradingState.COOLDOWN) return false;
  if (!state.cooldownUntil || now < state.cooldownUntil) return false;
  resetToIdle(state, now, "cooldown_elapsed", "WAIT");
  return true;
}

function defaultStopLoss(side, entryPrice) {
  if (!Number.isFinite(entryPrice)) return null;
  return roundPrice(side === "LONG" ? entryPrice * 0.995 : entryPrice * 1.005);
}

function defaultTakeProfit(side, entryPrice) {
  if (!Number.isFinite(entryPrice)) return null;
  return roundPrice(side === "LONG" ? entryPrice * 1.01 : entryPrice * 0.99);
}

function normalizeStopLoss(side, candidate, entryPrice) {
  const value = toPrice(candidate);
  if (value == null) return defaultStopLoss(side, entryPrice);
  if (side === "LONG") return value < entryPrice ? value : defaultStopLoss(side, entryPrice);
  return value > entryPrice ? value : defaultStopLoss(side, entryPrice);
}

function normalizeTakeProfit(side, candidate, entryPrice) {
  const value = toPrice(candidate);
  if (value == null) return defaultTakeProfit(side, entryPrice);
  if (side === "LONG") return value > entryPrice ? value : defaultTakeProfit(side, entryPrice);
  return value < entryPrice ? value : defaultTakeProfit(side, entryPrice);
}

function confirmEntry(side, closePrice, referenceLevel) {
  const close = toPrice(closePrice);
  const level = toPrice(referenceLevel);
  if (close == null) return false;
  if (level == null) return true;
  if (side === "LONG") return close >= level;
  return close <= level;
}

function syncTradingStateBeforeLlm(key, candle, now = Date.now()) {
  const state = getMutableState(key);
  expireCooldownIfNeeded(state, now);

  if (state.state === TradingState.COOLDOWN) {
    return {
      tradeState: cloneState(state),
      skipLlm: true,
      skipReason: `冷静期中，结束时间 ${new Date(state.cooldownUntil).toLocaleTimeString("zh-CN", {
        hour12: false,
      })}`,
      hardExit: null,
    };
  }

  const high = toPrice(candle?.high);
  const low = toPrice(candle?.low);

  if (state.state === TradingState.HOLDING_LONG) {
    if (state.stopLoss != null && low != null && low <= state.stopLoss) {
      const exitPrice = state.stopLoss;
      enterCooldown(state, now, "stop_loss_hit", DEFAULT_COOLDOWN_MS, "EXIT_LONG");
      return {
        tradeState: cloneState(state),
        skipLlm: true,
        skipReason: `多单硬止损已触发 @ ${exitPrice}`,
        hardExit: { type: "STOP_LOSS", side: "LONG", exitPrice },
      };
    }
    if (state.takeProfit != null && high != null && high >= state.takeProfit) {
      const exitPrice = state.takeProfit;
      enterCooldown(state, now, "take_profit_hit", DEFAULT_COOLDOWN_MS, "EXIT_LONG");
      return {
        tradeState: cloneState(state),
        skipLlm: true,
        skipReason: `多单止盈已触发 @ ${exitPrice}`,
        hardExit: { type: "TAKE_PROFIT", side: "LONG", exitPrice },
      };
    }
  }

  if (state.state === TradingState.HOLDING_SHORT) {
    if (state.stopLoss != null && high != null && high >= state.stopLoss) {
      const exitPrice = state.stopLoss;
      enterCooldown(state, now, "stop_loss_hit", DEFAULT_COOLDOWN_MS, "EXIT_SHORT");
      return {
        tradeState: cloneState(state),
        skipLlm: true,
        skipReason: `空单硬止损已触发 @ ${exitPrice}`,
        hardExit: { type: "STOP_LOSS", side: "SHORT", exitPrice },
      };
    }
    if (state.takeProfit != null && low != null && low <= state.takeProfit) {
      const exitPrice = state.takeProfit;
      enterCooldown(state, now, "take_profit_hit", DEFAULT_COOLDOWN_MS, "EXIT_SHORT");
      return {
        tradeState: cloneState(state),
        skipLlm: true,
        skipReason: `空单止盈已触发 @ ${exitPrice}`,
        hardExit: { type: "TAKE_PROFIT", side: "SHORT", exitPrice },
      };
    }
  }

  return {
    tradeState: cloneState(state),
    skipLlm: false,
    skipReason: null,
    hardExit: null,
  };
}

function applyTradingDecision(key, candle, decision, now = Date.now()) {
  const state = getMutableState(key);
  expireCooldownIfNeeded(state, now);

  if (!decision || typeof decision !== "object") {
    return {
      applied: false,
      ignoredReason: "缺少结构化交易决策",
      tradeState: cloneState(state),
    };
  }

  if (state.state === TradingState.COOLDOWN) {
    return {
      applied: false,
      ignoredReason: "冷静期内忽略 LLM 决策",
      tradeState: cloneState(state),
    };
  }

  const close = toPrice(candle?.close);
  const confidence = Number.isFinite(Number(decision.confidence))
    ? Math.max(0, Math.min(100, Math.round(Number(decision.confidence))))
    : 0;
  const intent = String(decision.intent || "").trim().toUpperCase();
  const keyLevel = toPrice(decision.keyLevel);
  const stopLoss = toPrice(decision.stopLoss);
  const takeProfit = toPrice(decision.takeProfit);

  switch (state.state) {
    case TradingState.IDLE:
      if (intent === "WAIT") {
        touchTransition(state, now, "idle_wait", intent);
        return { applied: true, transition: "IDLE->IDLE", tradeState: cloneState(state) };
      }
      if (intent === "LOOK_LONG" && confidence >= MIN_LOOK_CONFIDENCE) {
        state.state = TradingState.LOOKING_LONG;
        state.pendingDirection = "LONG";
        state.positionSide = null;
        state.keyLevel = keyLevel;
        state.entryPrice = null;
        state.stopLoss = stopLoss;
        state.takeProfit = takeProfit;
        state.cooldownUntil = 0;
        touchTransition(state, now, "llm_watch_long", intent);
        return { applied: true, transition: "IDLE->LOOKING_LONG", tradeState: cloneState(state) };
      }
      if (intent === "LOOK_SHORT" && confidence >= MIN_LOOK_CONFIDENCE) {
        state.state = TradingState.LOOKING_SHORT;
        state.pendingDirection = "SHORT";
        state.positionSide = null;
        state.keyLevel = keyLevel;
        state.entryPrice = null;
        state.stopLoss = stopLoss;
        state.takeProfit = takeProfit;
        state.cooldownUntil = 0;
        touchTransition(state, now, "llm_watch_short", intent);
        return { applied: true, transition: "IDLE->LOOKING_SHORT", tradeState: cloneState(state) };
      }
      return {
        applied: false,
        ignoredReason: "IDLE 状态仅接受高置信度 LOOK_LONG / LOOK_SHORT",
        tradeState: cloneState(state),
      };

    case TradingState.LOOKING_LONG:
      if (intent === "ENTER_LONG" && confidence >= MIN_ENTER_CONFIDENCE) {
        const ref = keyLevel ?? state.keyLevel;
        if (!confirmEntry("LONG", close, ref)) {
          resetToIdle(state, now, "long_entry_not_confirmed", intent);
          return {
            applied: true,
            transition: "LOOKING_LONG->IDLE",
            tradeState: cloneState(state),
          };
        }
        state.state = TradingState.HOLDING_LONG;
        state.pendingDirection = null;
        state.positionSide = "LONG";
        state.keyLevel = ref;
        state.entryPrice = close;
        state.stopLoss = normalizeStopLoss("LONG", stopLoss ?? state.stopLoss, close);
        state.takeProfit = normalizeTakeProfit("LONG", takeProfit ?? state.takeProfit, close);
        state.cooldownUntil = 0;
        touchTransition(state, now, "llm_enter_long", intent);
        return {
          applied: true,
          transition: "LOOKING_LONG->HOLDING_LONG",
          tradeState: cloneState(state),
        };
      }
      if (intent === "WAIT" || intent === "CANCEL_LOOKING") {
        resetToIdle(state, now, "looking_long_cancelled", intent);
        return {
          applied: true,
          transition: "LOOKING_LONG->IDLE",
          tradeState: cloneState(state),
        };
      }
      return {
        applied: false,
        ignoredReason: "LOOKING_LONG 状态仅接受 ENTER_LONG / CANCEL_LOOKING / WAIT",
        tradeState: cloneState(state),
      };

    case TradingState.LOOKING_SHORT:
      if (intent === "ENTER_SHORT" && confidence >= MIN_ENTER_CONFIDENCE) {
        const ref = keyLevel ?? state.keyLevel;
        if (!confirmEntry("SHORT", close, ref)) {
          resetToIdle(state, now, "short_entry_not_confirmed", intent);
          return {
            applied: true,
            transition: "LOOKING_SHORT->IDLE",
            tradeState: cloneState(state),
          };
        }
        state.state = TradingState.HOLDING_SHORT;
        state.pendingDirection = null;
        state.positionSide = "SHORT";
        state.keyLevel = ref;
        state.entryPrice = close;
        state.stopLoss = normalizeStopLoss("SHORT", stopLoss ?? state.stopLoss, close);
        state.takeProfit = normalizeTakeProfit("SHORT", takeProfit ?? state.takeProfit, close);
        state.cooldownUntil = 0;
        touchTransition(state, now, "llm_enter_short", intent);
        return {
          applied: true,
          transition: "LOOKING_SHORT->HOLDING_SHORT",
          tradeState: cloneState(state),
        };
      }
      if (intent === "WAIT" || intent === "CANCEL_LOOKING") {
        resetToIdle(state, now, "looking_short_cancelled", intent);
        return {
          applied: true,
          transition: "LOOKING_SHORT->IDLE",
          tradeState: cloneState(state),
        };
      }
      return {
        applied: false,
        ignoredReason: "LOOKING_SHORT 状态仅接受 ENTER_SHORT / CANCEL_LOOKING / WAIT",
        tradeState: cloneState(state),
      };

    case TradingState.HOLDING_LONG:
      if (intent === "EXIT_LONG" && confidence >= MIN_EXIT_CONFIDENCE) {
        enterCooldown(state, now, "llm_exit_long", EARLY_EXIT_COOLDOWN_MS, intent);
        return {
          applied: true,
          transition: "HOLDING_LONG->COOLDOWN",
          tradeState: cloneState(state),
        };
      }
      if (intent === "HOLD") {
        const entry = toPrice(state.entryPrice);
        let riskAdjusted = false;
        if (confidence >= MIN_HOLD_RISK_ADJUST_CONFIDENCE && entry != null) {
          if (stopLoss != null) {
            state.stopLoss = normalizeStopLoss("LONG", stopLoss, entry);
            riskAdjusted = true;
          }
          if (takeProfit != null) {
            state.takeProfit = normalizeTakeProfit("LONG", takeProfit, entry);
            riskAdjusted = true;
          }
        }
        touchTransition(
          state,
          now,
          riskAdjusted ? "holding_long_risk_adjust" : "holding_long_keep",
          intent,
        );
        return {
          applied: true,
          transition: riskAdjusted
            ? "HOLDING_LONG->HOLDING_LONG [risk]"
            : "HOLDING_LONG->HOLDING_LONG",
          tradeState: cloneState(state),
        };
      }
      return {
        applied: false,
        ignoredReason: "HOLDING_LONG 状态仅接受 HOLD / EXIT_LONG",
        tradeState: cloneState(state),
      };

    case TradingState.HOLDING_SHORT:
      if (intent === "EXIT_SHORT" && confidence >= MIN_EXIT_CONFIDENCE) {
        enterCooldown(state, now, "llm_exit_short", EARLY_EXIT_COOLDOWN_MS, intent);
        return {
          applied: true,
          transition: "HOLDING_SHORT->COOLDOWN",
          tradeState: cloneState(state),
        };
      }
      if (intent === "HOLD") {
        const entry = toPrice(state.entryPrice);
        let riskAdjusted = false;
        if (confidence >= MIN_HOLD_RISK_ADJUST_CONFIDENCE && entry != null) {
          if (stopLoss != null) {
            state.stopLoss = normalizeStopLoss("SHORT", stopLoss, entry);
            riskAdjusted = true;
          }
          if (takeProfit != null) {
            state.takeProfit = normalizeTakeProfit("SHORT", takeProfit, entry);
            riskAdjusted = true;
          }
        }
        touchTransition(
          state,
          now,
          riskAdjusted ? "holding_short_risk_adjust" : "holding_short_keep",
          intent,
        );
        return {
          applied: true,
          transition: riskAdjusted
            ? "HOLDING_SHORT->HOLDING_SHORT [risk]"
            : "HOLDING_SHORT->HOLDING_SHORT",
          tradeState: cloneState(state),
        };
      }
      return {
        applied: false,
        ignoredReason: "HOLDING_SHORT 状态仅接受 HOLD / EXIT_SHORT",
        tradeState: cloneState(state),
      };

    default:
      return {
        applied: false,
        ignoredReason: "未知状态，未应用交易决策",
        tradeState: cloneState(state),
      };
  }
}

function wipeTradingStateStore() {
  store = Object.create(null);
}

/**
 * Agent：进入观察方向（等价 LOOK_LONG / LOOK_SHORT）。
 * @param {string} key
 * @param {{ direction: "LONG"|"SHORT", keyLevel?: number | null, stopLoss?: number | null, takeProfit?: number | null, confidence: number }} spec
 */
function agentPrepareWatch(key, spec, now = Date.now()) {
  const state = getMutableState(key);
  expireCooldownIfNeeded(state, now);
  if (state.state === TradingState.COOLDOWN) {
    return { ok: false, reason: "冷静期内不可新建观察", tradeState: cloneState(state) };
  }
  const confidence = Number.isFinite(Number(spec?.confidence))
    ? Math.max(0, Math.min(100, Math.round(Number(spec.confidence))))
    : 0;
  if (confidence < MIN_LOOK_CONFIDENCE) {
    return { ok: false, reason: `置信度需 ≥ ${MIN_LOOK_CONFIDENCE} 才能进入观察`, tradeState: cloneState(state) };
  }
  const dir = String(spec?.direction || "").toUpperCase();
  if (dir !== "LONG" && dir !== "SHORT") {
    return { ok: false, reason: "direction 须为 LONG 或 SHORT", tradeState: cloneState(state) };
  }
  if (
    state.state === TradingState.HOLDING_LONG ||
    state.state === TradingState.HOLDING_SHORT
  ) {
    return { ok: false, reason: "持仓中请先平仓再重新观察", tradeState: cloneState(state) };
  }
  const keyLevel = toPrice(spec?.keyLevel);
  const stopLoss = toPrice(spec?.stopLoss);
  const takeProfit = toPrice(spec?.takeProfit);
  if (dir === "LONG") {
    state.state = TradingState.LOOKING_LONG;
    state.pendingDirection = "LONG";
    state.positionSide = null;
    state.keyLevel = keyLevel;
    state.entryPrice = null;
    state.stopLoss = stopLoss;
    state.takeProfit = takeProfit;
    state.cooldownUntil = 0;
    touchTransition(state, now, "agent_watch_long", "LOOK_LONG");
  } else {
    state.state = TradingState.LOOKING_SHORT;
    state.pendingDirection = "SHORT";
    state.positionSide = null;
    state.keyLevel = keyLevel;
    state.entryPrice = null;
    state.stopLoss = stopLoss;
    state.takeProfit = takeProfit;
    state.cooldownUntil = 0;
    touchTransition(state, now, "agent_watch_short", "LOOK_SHORT");
  }
  return { ok: true, tradeState: cloneState(state) };
}

/** Agent：放弃观察，回到 IDLE。 */
function agentCancelWatch(key, now = Date.now()) {
  const state = getMutableState(key);
  expireCooldownIfNeeded(state, now);
  if (state.state !== TradingState.LOOKING_LONG && state.state !== TradingState.LOOKING_SHORT) {
    return { ok: false, reason: "当前不在观察状态", tradeState: cloneState(state) };
  }
  resetToIdle(state, now, "agent_cancel_watch", "CANCEL_LOOKING");
  return { ok: true, tradeState: cloneState(state) };
}

/**
 * Agent：校验是否允许在本根 K 线上执行「开仓」动作（不含下单）。
 * @param {string} key
 * @param {object} candle
 * @param {{ side: "LONG"|"SHORT", confidence: number, keyLevel?: number | null }} spec
 */
function agentCanOpen(key, candle, spec, now = Date.now()) {
  const state = getMutableState(key);
  expireCooldownIfNeeded(state, now);
  const confidence = Number.isFinite(Number(spec?.confidence))
    ? Math.max(0, Math.min(100, Math.round(Number(spec.confidence))))
    : 0;
  const side = String(spec?.side || "").toUpperCase();
  if (side !== "LONG" && side !== "SHORT") {
    return { ok: false, reason: "side 须为 LONG 或 SHORT" };
  }
  if (state.state === TradingState.COOLDOWN) {
    return { ok: false, reason: "冷静期内不可开仓" };
  }
  if (state.state === TradingState.HOLDING_LONG || state.state === TradingState.HOLDING_SHORT) {
    return { ok: false, reason: "已有模拟持仓，请先平仓" };
  }
  if (confidence < MIN_ENTER_CONFIDENCE) {
    return { ok: false, reason: `开仓置信度需 ≥ ${MIN_ENTER_CONFIDENCE}` };
  }
  const keyLevel = toPrice(spec?.keyLevel);
  const close = toPrice(candle?.close);

  if (state.state === TradingState.LOOKING_LONG) {
    if (side !== "LONG") return { ok: false, reason: "当前观察做多，只能开多" };
    const ref = keyLevel ?? state.keyLevel;
    if (!confirmEntry("LONG", close, ref)) {
      return { ok: false, reason: "收盘价未确认做多触发/关键位" };
    }
    return { ok: true, ref };
  }
  if (state.state === TradingState.LOOKING_SHORT) {
    if (side !== "SHORT") return { ok: false, reason: "当前观察做空，只能开空" };
    const ref = keyLevel ?? state.keyLevel;
    if (!confirmEntry("SHORT", close, ref)) {
      return { ok: false, reason: "收盘价未确认做空触发/关键位" };
    }
    return { ok: true, ref };
  }
  if (state.state === TradingState.IDLE) {
    return { ok: true, ref: keyLevel };
  }
  return { ok: false, reason: `当前状态 ${state.state} 不允许开仓` };
}

/**
 * Agent：成交后写入模拟持仓（纪律型止损止盈由后续工具或本轮参数更新）。
 */
function applyAgentOpenFilled(key, candle, spec, now = Date.now()) {
  const state = getMutableState(key);
  expireCooldownIfNeeded(state, now);
  const side = String(spec?.side || "").toUpperCase();
  const entryPrice = toPrice(spec?.entryPrice ?? candle?.close);
  if (side !== "LONG" && side !== "SHORT") {
    return { ok: false, reason: "side 无效", tradeState: cloneState(state) };
  }
  if (entryPrice == null) {
    return { ok: false, reason: "缺少有效成交价", tradeState: cloneState(state) };
  }
  const ref = toPrice(spec?.keyLevel ?? spec?.ref) ?? state.keyLevel;
  const stopLoss = toPrice(spec?.stopLoss);
  const takeProfit = toPrice(spec?.takeProfit);

  if (side === "LONG") {
    state.state = TradingState.HOLDING_LONG;
    state.pendingDirection = null;
    state.positionSide = "LONG";
    state.keyLevel = ref;
    state.entryPrice = entryPrice;
    state.stopLoss = normalizeStopLoss("LONG", stopLoss ?? state.stopLoss, entryPrice);
    state.takeProfit = normalizeTakeProfit("LONG", takeProfit ?? state.takeProfit, entryPrice);
    state.cooldownUntil = 0;
    touchTransition(state, now, "agent_open_long", "ENTER_LONG");
  } else {
    state.state = TradingState.HOLDING_SHORT;
    state.pendingDirection = null;
    state.positionSide = "SHORT";
    state.keyLevel = ref;
    state.entryPrice = entryPrice;
    state.stopLoss = normalizeStopLoss("SHORT", stopLoss ?? state.stopLoss, entryPrice);
    state.takeProfit = normalizeTakeProfit("SHORT", takeProfit ?? state.takeProfit, entryPrice);
    state.cooldownUntil = 0;
    touchTransition(state, now, "agent_open_short", "ENTER_SHORT");
  }
  return { ok: true, tradeState: cloneState(state) };
}

/** Agent：平仓进入冷静期（与 LLM EXIT_* 一致）。 */
function applyAgentClose(key, spec, now = Date.now()) {
  const state = getMutableState(key);
  expireCooldownIfNeeded(state, now);
  const confidence = Number.isFinite(Number(spec?.confidence))
    ? Math.max(0, Math.min(100, Math.round(Number(spec.confidence))))
    : 0;
  if (state.state === TradingState.HOLDING_LONG) {
    if (confidence < MIN_EXIT_CONFIDENCE) {
      return {
        ok: false,
        reason: `平仓置信度需 ≥ ${MIN_EXIT_CONFIDENCE}`,
        tradeState: cloneState(state),
      };
    }
    enterCooldown(state, now, "agent_exit_long", EARLY_EXIT_COOLDOWN_MS, "EXIT_LONG");
    return { ok: true, tradeState: cloneState(state) };
  }
  if (state.state === TradingState.HOLDING_SHORT) {
    if (confidence < MIN_EXIT_CONFIDENCE) {
      return {
        ok: false,
        reason: `平仓置信度需 ≥ ${MIN_EXIT_CONFIDENCE}`,
        tradeState: cloneState(state),
      };
    }
    enterCooldown(state, now, "agent_exit_short", EARLY_EXIT_COOLDOWN_MS, "EXIT_SHORT");
    return { ok: true, tradeState: cloneState(state) };
  }
  return { ok: false, reason: "当前无模拟持仓可平", tradeState: cloneState(state) };
}

/** Agent：仅更新纪律型止损止盈（须持仓 + 置信度）。 */
function applyAgentDisciplineRisk(key, spec, now = Date.now()) {
  const state = getMutableState(key);
  expireCooldownIfNeeded(state, now);
  const confidence = Number.isFinite(Number(spec?.confidence))
    ? Math.max(0, Math.min(100, Math.round(Number(spec.confidence))))
    : 0;
  if (state.state !== TradingState.HOLDING_LONG && state.state !== TradingState.HOLDING_SHORT) {
    return { ok: false, reason: "仅持仓时可调整止损止盈", tradeState: cloneState(state) };
  }
  if (confidence < MIN_HOLD_RISK_ADJUST_CONFIDENCE) {
    return {
      ok: false,
      reason: `调整止损止盈置信度需 ≥ ${MIN_HOLD_RISK_ADJUST_CONFIDENCE}`,
      tradeState: cloneState(state),
    };
  }
  const side = state.state === TradingState.HOLDING_LONG ? "LONG" : "SHORT";
  const entry = toPrice(state.entryPrice);
  if (entry == null) {
    return { ok: false, reason: "缺少入场价", tradeState: cloneState(state) };
  }
  const stopLoss = toPrice(spec?.stopLoss);
  const takeProfit = toPrice(spec?.takeProfit);
  let changed = false;
  if (stopLoss != null) {
    state.stopLoss = normalizeStopLoss(side, stopLoss, entry);
    changed = true;
  }
  if (takeProfit != null) {
    state.takeProfit = normalizeTakeProfit(side, takeProfit, entry);
    changed = true;
  }
  if (!changed) {
    return { ok: false, reason: "请至少提供 stop_loss 或 take_profit 之一", tradeState: cloneState(state) };
  }
  touchTransition(state, now, `agent_risk_${side.toLowerCase()}`, "HOLD");
  return { ok: true, tradeState: cloneState(state) };
}

module.exports = {
  TradingState,
  DEFAULT_COOLDOWN_MS,
  EARLY_EXIT_COOLDOWN_MS,
  MIN_HOLD_RISK_ADJUST_CONFIDENCE,
  MIN_LOOK_CONFIDENCE,
  MIN_ENTER_CONFIDENCE,
  MIN_EXIT_CONFIDENCE,
  getAllowedIntentsForState,
  getTradingState,
  syncTradingStateBeforeLlm,
  applyTradingDecision,
  agentPrepareWatch,
  agentCancelWatch,
  agentCanOpen,
  applyAgentOpenFilled,
  applyAgentClose,
  applyAgentDisciplineRisk,
  wipeTradingStateStore,
};
