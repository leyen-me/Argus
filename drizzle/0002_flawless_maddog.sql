ALTER TABLE `agent_sessions` ADD `llm_prompt_tokens` int;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `llm_completion_tokens` int;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `llm_total_tokens` int;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `llm_started_at` varchar(32);--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `llm_ended_at` varchar(32);--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `llm_duration_ms` int;