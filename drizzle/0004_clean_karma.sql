CREATE TABLE `reference_session` (
	`session_date` text PRIMARY KEY NOT NULL,
	`first_observed_at` text NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER `reference_session_date_valid_insert` BEFORE INSERT ON `reference_session`
WHEN length(NEW.`session_date`) <> 10 OR date(NEW.`session_date`) IS NOT NEW.`session_date`
BEGIN SELECT RAISE(ABORT, 'invalid_session_date'); END;
