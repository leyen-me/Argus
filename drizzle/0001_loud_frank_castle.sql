CREATE TABLE `trade_reviews` (
	`id` varchar(64) NOT NULL,
	`tv_symbol` varchar(64) NOT NULL,
	`interval` varchar(16) NOT NULL,
	`strategy_id` varchar(64),
	`entry_bar_close_id` varchar(64) NOT NULL,
	`exit_bar_close_id` varchar(64) NOT NULL,
	`entry_at` varchar(64) NOT NULL,
	`exit_at` varchar(64) NOT NULL,
	`side` varchar(16),
	`entry_price` double,
	`exit_price` double,
	`pnl` double,
	`exit_type` varchar(48) NOT NULL DEFAULT 'unknown',
	`exit_reason_source` varchar(48) NOT NULL DEFAULT 'inferred',
	`context_summary_json` longtext NOT NULL,
	`review_text` longtext,
	`attribution` varchar(64),
	`lessons_json` longtext,
	`source_session_ids_json` longtext NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'pending',
	`error` longtext,
	`created_at` varchar(32) NOT NULL,
	`updated_at` varchar(32) NOT NULL,
	CONSTRAINT `trade_reviews_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_trade_reviews_list` ON `trade_reviews` (`tv_symbol`,`interval`,`exit_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_trade_reviews_entry_exit` ON `trade_reviews` (`entry_bar_close_id`,`exit_bar_close_id`);--> statement-breakpoint
CREATE INDEX `idx_trade_reviews_status` ON `trade_reviews` (`status`,`updated_at`);