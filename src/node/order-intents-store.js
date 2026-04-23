const { getDatabase } = require("./local-db");

function cleanText(v, maxLen = 280) {
  const s = String(v || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  return s.length > maxLen ? `${s.slice(0, Math.max(0, maxLen - 3))}...` : s;
}

function cleanId(v) {
  return String(v || "").trim();
}

function cleanMaybe(v) {
  const s = cleanId(v);
  return s || null;
}

function entityTypeFrom(v) {
  return String(v || "").toLowerCase() === "algo" ? "algo" : "order";
}

function summarizeIntentText(text, fallback) {
  const compact = cleanText(text, 240);
  if (compact) return compact;
  return cleanText(fallback, 240);
}

function rawArgsJsonOf(v) {
  if (!v || typeof v !== "object") return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

/**
 * @param {object} row
 * @param {"order"|"algo"} row.entityType
 * @param {string} row.entityId
 * @param {string} row.tvSymbol
 * @param {string} row.interval
 * @param {string} [row.barCloseId]
 * @param {string} [row.action]
 * @param {string | null} [row.side]
 * @param {string | null} [row.summary]
 * @param {string | null} [row.thesis]
 * @param {string | number | null} [row.limitPrice]
 * @param {string | number | null} [row.size]
 * @param {string | number | null} [row.takeProfitTriggerPrice]
 * @param {string | number | null} [row.stopLossTriggerPrice]
 * @param {string | null} [row.status]
 * @param {string | null} [row.inactiveReason]
 * @param {object | null} [row.rawArgs]
 */
function upsertOrderIntent(row) {
  const entityType = entityTypeFrom(row.entityType);
  const entityId = cleanId(row.entityId);
  if (!entityId) return false;
  const db = getDatabase();
  const status = cleanId(row.status) || "active";
  db.prepare(
    `INSERT INTO order_intents (
      entity_type, entity_id, tv_symbol, interval, bar_close_id,
      action, side, summary, thesis, limit_price, size,
      take_profit_trigger_price, stop_loss_trigger_price,
      status, inactive_reason, raw_args_json, created_at, updated_at, resolved_at
    ) VALUES (
      @entity_type, @entity_id, @tv_symbol, @interval, @bar_close_id,
      @action, @side, @summary, @thesis, @limit_price, @size,
      @take_profit_trigger_price, @stop_loss_trigger_price,
      @status, @inactive_reason, @raw_args_json, datetime('now'), datetime('now'), @resolved_at
    )
    ON CONFLICT(entity_type, entity_id) DO UPDATE SET
      tv_symbol = excluded.tv_symbol,
      interval = excluded.interval,
      bar_close_id = excluded.bar_close_id,
      action = excluded.action,
      side = excluded.side,
      summary = excluded.summary,
      thesis = excluded.thesis,
      limit_price = excluded.limit_price,
      size = excluded.size,
      take_profit_trigger_price = excluded.take_profit_trigger_price,
      stop_loss_trigger_price = excluded.stop_loss_trigger_price,
      status = excluded.status,
      inactive_reason = excluded.inactive_reason,
      raw_args_json = excluded.raw_args_json,
      updated_at = datetime('now'),
      resolved_at = excluded.resolved_at`,
  ).run({
    entity_type: entityType,
    entity_id: entityId,
    tv_symbol: cleanId(row.tvSymbol),
    interval: cleanId(row.interval),
    bar_close_id: cleanId(row.barCloseId),
    action: cleanId(row.action),
    side: cleanMaybe(row.side),
    summary: cleanText(row.summary),
    thesis: cleanText(row.thesis, 1000),
    limit_price: cleanMaybe(row.limitPrice),
    size: cleanMaybe(row.size),
    take_profit_trigger_price: cleanMaybe(row.takeProfitTriggerPrice),
    stop_loss_trigger_price: cleanMaybe(row.stopLossTriggerPrice),
    status,
    inactive_reason: cleanMaybe(row.inactiveReason),
    raw_args_json: rawArgsJsonOf(row.rawArgs),
    resolved_at: status !== "active" ? new Date().toISOString() : null,
  });
  return true;
}

function updateOrderIntent(entityTypeRaw, entityIdRaw, patch = {}) {
  const entityType = entityTypeFrom(entityTypeRaw);
  const entityId = cleanId(entityIdRaw);
  if (!entityId) return false;
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT entity_type, entity_id, tv_symbol, interval, bar_close_id,
              action, side, summary, thesis, limit_price, size,
              take_profit_trigger_price, stop_loss_trigger_price, status, inactive_reason, raw_args_json
       FROM order_intents
       WHERE entity_type = ? AND entity_id = ?
       LIMIT 1`,
    )
    .get(entityType, entityId);
  if (!row) return false;
  return upsertOrderIntent({
    entityType,
    entityId,
    tvSymbol: patch.tvSymbol ?? row.tv_symbol,
    interval: patch.interval ?? row.interval,
    barCloseId: patch.barCloseId ?? row.bar_close_id,
    action: patch.action ?? row.action,
    side: patch.side ?? row.side,
    summary: patch.summary ?? row.summary,
    thesis: patch.thesis ?? row.thesis,
    limitPrice: patch.limitPrice ?? row.limit_price,
    size: patch.size ?? row.size,
    takeProfitTriggerPrice: patch.takeProfitTriggerPrice ?? row.take_profit_trigger_price,
    stopLossTriggerPrice: patch.stopLossTriggerPrice ?? row.stop_loss_trigger_price,
    status: patch.status ?? row.status,
    inactiveReason: patch.inactiveReason ?? row.inactive_reason,
    rawArgs: patch.rawArgs ?? (() => {
      if (typeof row.raw_args_json !== "string" || !row.raw_args_json.trim()) return null;
      try {
        return JSON.parse(row.raw_args_json);
      } catch {
        return null;
      }
    })(),
  });
}

function markOrderIntentStatus(entityType, entityId, status, inactiveReason, extra = {}) {
  return updateOrderIntent(entityType, entityId, {
    ...extra,
    status,
    inactiveReason: inactiveReason || null,
  });
}

/**
 * @param {object} args
 * @param {string} args.tvSymbol
 * @param {string} args.interval
 * @param {Array<object>} args.pendingOrders
 * @param {Array<object>} args.pendingAlgoOrders
 */
function reconcileAndListActiveOrderIntents(args) {
  const tvSymbol = cleanId(args.tvSymbol);
  const interval = cleanId(args.interval);
  const pendingOrders = Array.isArray(args.pendingOrders) ? args.pendingOrders : [];
  const pendingAlgoOrders = Array.isArray(args.pendingAlgoOrders) ? args.pendingAlgoOrders : [];
  const activeOrderIds = new Set(
    pendingOrders.map((o) => cleanId(o?.ordId)).filter(Boolean),
  );
  const activeAlgoIds = new Set(
    pendingAlgoOrders.map((o) => cleanId(o?.algoId)).filter(Boolean),
  );
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT
         entity_type, entity_id, tv_symbol, interval, bar_close_id, action, side,
         summary, thesis, limit_price, size, take_profit_trigger_price, stop_loss_trigger_price,
         status, inactive_reason, created_at, updated_at, resolved_at
       FROM order_intents
       WHERE tv_symbol = ? AND interval = ? AND status = 'active'
       ORDER BY updated_at DESC, entity_id DESC`,
    )
    .all(tvSymbol, interval);

  const markInactive = db.prepare(
    `UPDATE order_intents
     SET status = 'inactive',
         inactive_reason = ?,
         updated_at = datetime('now'),
         resolved_at = COALESCE(resolved_at, datetime('now'))
     WHERE entity_type = ? AND entity_id = ?`,
  );

  const run = db.transaction(() => {
    for (const row of rows) {
      const alive =
        row.entity_type === "algo"
          ? activeAlgoIds.has(cleanId(row.entity_id))
          : activeOrderIds.has(cleanId(row.entity_id));
      if (!alive) {
        markInactive.run("not_present_in_pending_snapshot", row.entity_type, row.entity_id);
      }
    }
  });
  run();

  const liveOrdersById = new Map(
    pendingOrders.map((o) => [cleanId(o?.ordId), o]).filter(([id]) => id),
  );
  const liveAlgosById = new Map(
    pendingAlgoOrders.map((o) => [cleanId(o?.algoId), o]).filter(([id]) => id),
  );

  const stillActive = db
    .prepare(
      `SELECT
         entity_type, entity_id, tv_symbol, interval, bar_close_id, action, side,
         summary, thesis, limit_price, size, take_profit_trigger_price, stop_loss_trigger_price,
         status, inactive_reason, created_at, updated_at, resolved_at
       FROM order_intents
       WHERE tv_symbol = ? AND interval = ? AND status = 'active'
       ORDER BY updated_at DESC, entity_id DESC`,
    )
    .all(tvSymbol, interval);

  return stillActive.map((row) => {
    const live = row.entity_type === "algo" ? liveAlgosById.get(row.entity_id) : liveOrdersById.get(row.entity_id);
    return {
      entityType: row.entity_type,
      entityId: row.entity_id,
      tvSymbol: row.tv_symbol,
      interval: row.interval,
      barCloseId: row.bar_close_id,
      action: row.action,
      side: row.side,
      summary: row.summary,
      thesis: row.thesis,
      limitPrice: row.limit_price,
      size: row.size,
      takeProfitTriggerPrice: row.take_profit_trigger_price,
      stopLossTriggerPrice: row.stop_loss_trigger_price,
      status: row.status,
      inactiveReason: row.inactive_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
      live: live || null,
    };
  });
}

module.exports = {
  summarizeIntentText,
  upsertOrderIntent,
  updateOrderIntent,
  markOrderIntentStatus,
  reconcileAndListActiveOrderIntents,
};
