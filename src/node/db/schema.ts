import {
  customType,
  double,
  index,
  int,
  longtext,
  mysqlTable,
  primaryKey,
  tinyint,
  varchar,
} from "drizzle-orm/mysql-core";

/** MySQL LONGBLOB，映射为 `Buffer | null` */
const longBlob = customType<{ data: Buffer | null; driverData: Buffer | null }>({
  dataType() {
    return "longblob";
  },
});

/** 应用 KV（如 app/settings） */
export const kvStore = mysqlTable(
  "kv_store",
  {
    namespace: varchar("namespace", { length: 64 }).notNull(),
    key: varchar("key", { length: 127 }).notNull(),
    value: longtext("value").notNull(),
    updatedAt: varchar("updated_at", { length: 32 }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.namespace, t.key] }),
    namespaceIdx: index("idx_kv_namespace").on(t.namespace),
  }),
);

export const promptStrategies = mysqlTable(
  "prompt_strategies",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    label: varchar("label", { length: 512 }).notNull().default(""),
    body: longtext("body").notNull(),
    sortOrder: int("sort_order").notNull().default(0),
    decisionIntervalTv: varchar("decision_interval_tv", { length: 16 }).notNull().default("5"),
    extrasJson: longtext("extras_json").notNull().default("{}"),
    updatedAt: varchar("updated_at", { length: 32 }).notNull(),
  },
  (t) => ({
    sortIdx: index("idx_prompt_strategies_sort").on(t.sortOrder, t.id),
  }),
);

export const agentSessions = mysqlTable(
  "agent_sessions",
  {
    barCloseId: varchar("bar_close_id", { length: 64 }).primaryKey(),
    tvSymbol: varchar("tv_symbol", { length: 64 }).notNull(),
    interval: varchar("interval", { length: 16 }).notNull(),
    periodLabel: varchar("period_label", { length: 256 }).notNull().default(""),
    capturedAt: varchar("captured_at", { length: 64 }).notNull(),
    textForLlm: longtext("text_for_llm").notNull(),
    llmUserFullText: longtext("llm_user_full_text").notNull(),
    exchangeContextJson: longtext("exchange_context_json"),
    chartMime: varchar("chart_mime", { length: 128 }),
    chartPng: longBlob("chart_png"),
    chartCaptureError: longtext("chart_capture_error"),
    assistantText: longtext("assistant_text"),
    cardSummary: longtext("card_summary"),
    toolTraceJson: longtext("tool_trace_json"),
    exchangeAfterJson: longtext("exchange_after_json"),
    agentOk: tinyint("agent_ok").notNull().default(0),
    agentError: longtext("agent_error"),
    estimatedPromptTokens: int("estimated_prompt_tokens"),
    contextWindowTokens: int("context_window_tokens"),
    updatedAt: varchar("updated_at", { length: 32 }).notNull(),
    systemPromptText: longtext("system_prompt_text"),
    assistantReasoningText: longtext("assistant_reasoning_text"),
    assistantDecision: varchar("assistant_decision", { length: 32 }),
  },
  (t) => ({
    listIdx: index("idx_agent_sessions_list").on(t.tvSymbol, t.interval, t.capturedAt, t.barCloseId),
  }),
);

export const agentSessionMessages = mysqlTable(
  "agent_session_messages",
  {
    barCloseId: varchar("bar_close_id", { length: 64 }).notNull(),
    seq: int("seq").notNull(),
    role: varchar("role", { length: 32 }).notNull(),
    contentJson: longtext("content_json"),
    toolCallsJson: longtext("tool_calls_json"),
    toolCallId: varchar("tool_call_id", { length: 128 }),
    name: varchar("name", { length: 128 }),
    assistantDecision: varchar("assistant_decision", { length: 32 }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.barCloseId, t.seq] }),
    barIdx: index("idx_session_messages_bar").on(t.barCloseId),
  }),
);

export const dashboardEquitySamples = mysqlTable(
  "dashboard_equity_samples",
  {
    id: int("id").primaryKey().autoincrement(),
    capturedAt: varchar("captured_at", { length: 64 }).notNull(),
    equityUsdt: double("equity_usdt").notNull(),
  },
  (t) => ({
    capturedIdx: index("idx_dashboard_equity_captured").on(t.capturedAt, t.id),
  }),
);
