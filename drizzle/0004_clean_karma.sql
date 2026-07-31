CREATE TABLE IF NOT EXISTS `reference_session` (
	`session_date` text PRIMARY KEY NOT NULL,
	`first_observed_at` text NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
