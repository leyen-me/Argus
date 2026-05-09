CREATE INDEX `idx_session_messages_bar` ON `agent_session_messages` (`bar_close_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_sessions_list` ON `agent_sessions` (`tv_symbol`,`interval`,`captured_at`,`bar_close_id`);--> statement-breakpoint
CREATE INDEX `idx_dashboard_equity_captured` ON `dashboard_equity_samples` (`captured_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_kv_namespace` ON `kv_store` (`namespace`);--> statement-breakpoint
CREATE INDEX `idx_prompt_strategies_sort` ON `prompt_strategies` (`sort_order`,`id`);