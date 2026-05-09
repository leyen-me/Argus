CREATE TABLE IF NOT EXISTS `kv_store` (
	`namespace` varchar(64) NOT NULL,
	`key` varchar(127) NOT NULL,
	`value` longtext NOT NULL,
	`updated_at` varchar(32) NOT NULL,
	PRIMARY KEY (`namespace`,`key`)
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `prompt_strategies` (
	`id` varchar(64) NOT NULL,
	`label` varchar(512) NOT NULL DEFAULT '',
	`body` longtext NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	`decision_interval_tv` varchar(16) NOT NULL DEFAULT '5',
	`extras_json` longtext NOT NULL,
	`updated_at` varchar(32) NOT NULL,
	PRIMARY KEY (`id`)
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `agent_sessions` (
	`bar_close_id` varchar(64) NOT NULL,
	`tv_symbol` varchar(64) NOT NULL,
	`interval` varchar(16) NOT NULL,
	`period_label` varchar(256) NOT NULL DEFAULT '',
	`captured_at` varchar(64) NOT NULL,
	`text_for_llm` longtext NOT NULL,
	`llm_user_full_text` longtext NOT NULL,
	`exchange_context_json` longtext,
	`chart_mime` varchar(128),
	`chart_png` longblob,
	`chart_capture_error` longtext,
	`assistant_text` longtext,
	`card_summary` longtext,
	`tool_trace_json` longtext,
	`exchange_after_json` longtext,
	`agent_ok` tinyint NOT NULL DEFAULT 0,
	`agent_error` longtext,
	`estimated_prompt_tokens` int,
	`context_window_tokens` int,
	`updated_at` varchar(32) NOT NULL,
	`system_prompt_text` longtext,
	`assistant_reasoning_text` longtext,
	`assistant_decision` varchar(32),
	PRIMARY KEY (`bar_close_id`)
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `agent_session_messages` (
	`bar_close_id` varchar(64) NOT NULL,
	`seq` int NOT NULL,
	`role` varchar(32) NOT NULL,
	`content_json` longtext,
	`tool_calls_json` longtext,
	`tool_call_id` varchar(128),
	`name` varchar(128),
	`assistant_decision` varchar(32),
	PRIMARY KEY (`bar_close_id`,`seq`)
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `dashboard_equity_samples` (
	`id` int NOT NULL AUTO_INCREMENT,
	`captured_at` varchar(64) NOT NULL,
	`equity_usdt` double NOT NULL,
	PRIMARY KEY (`id`)
);--> statement-breakpoint

SET @__argus_drop_idx := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'kv_store'
        AND index_name = 'idx_kv_namespace'
    ),
    'DROP INDEX `idx_kv_namespace` ON `kv_store`',
    'SELECT 1'
  )
);--> statement-breakpoint
PREPARE __argus_stmt FROM @__argus_drop_idx;--> statement-breakpoint
EXECUTE __argus_stmt;--> statement-breakpoint
DEALLOCATE PREPARE __argus_stmt;--> statement-breakpoint
CREATE INDEX `idx_kv_namespace` ON `kv_store` (`namespace`);--> statement-breakpoint

SET @__argus_drop_idx := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'prompt_strategies'
        AND index_name = 'idx_prompt_strategies_sort'
    ),
    'DROP INDEX `idx_prompt_strategies_sort` ON `prompt_strategies`',
    'SELECT 1'
  )
);--> statement-breakpoint
PREPARE __argus_stmt FROM @__argus_drop_idx;--> statement-breakpoint
EXECUTE __argus_stmt;--> statement-breakpoint
DEALLOCATE PREPARE __argus_stmt;--> statement-breakpoint
CREATE INDEX `idx_prompt_strategies_sort` ON `prompt_strategies` (`sort_order`,`id`);--> statement-breakpoint

SET @__argus_drop_idx := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'agent_sessions'
        AND index_name = 'idx_agent_sessions_list'
    ),
    'DROP INDEX `idx_agent_sessions_list` ON `agent_sessions`',
    'SELECT 1'
  )
);--> statement-breakpoint
PREPARE __argus_stmt FROM @__argus_drop_idx;--> statement-breakpoint
EXECUTE __argus_stmt;--> statement-breakpoint
DEALLOCATE PREPARE __argus_stmt;--> statement-breakpoint
CREATE INDEX `idx_agent_sessions_list` ON `agent_sessions` (`tv_symbol`,`interval`,`captured_at`,`bar_close_id`);--> statement-breakpoint

SET @__argus_drop_idx := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'agent_session_messages'
        AND index_name = 'idx_session_messages_bar'
    ),
    'DROP INDEX `idx_session_messages_bar` ON `agent_session_messages`',
    'SELECT 1'
  )
);--> statement-breakpoint
PREPARE __argus_stmt FROM @__argus_drop_idx;--> statement-breakpoint
EXECUTE __argus_stmt;--> statement-breakpoint
DEALLOCATE PREPARE __argus_stmt;--> statement-breakpoint
CREATE INDEX `idx_session_messages_bar` ON `agent_session_messages` (`bar_close_id`);--> statement-breakpoint

SET @__argus_drop_idx := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'dashboard_equity_samples'
        AND index_name = 'idx_dashboard_equity_captured'
    ),
    'DROP INDEX `idx_dashboard_equity_captured` ON `dashboard_equity_samples`',
    'SELECT 1'
  )
);--> statement-breakpoint
PREPARE __argus_stmt FROM @__argus_drop_idx;--> statement-breakpoint
EXECUTE __argus_stmt;--> statement-breakpoint
DEALLOCATE PREPARE __argus_stmt;--> statement-breakpoint
CREATE INDEX `idx_dashboard_equity_captured` ON `dashboard_equity_samples` (`captured_at`,`id`);
