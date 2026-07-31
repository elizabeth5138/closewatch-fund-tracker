CREATE TABLE `ingestion_expectation` (
	`run_id` text NOT NULL,
	`session_date` text NOT NULL,
	`fund_id` text NOT NULL,
	PRIMARY KEY(`run_id`, `session_date`, `fund_id`),
	FOREIGN KEY (`run_id`) REFERENCES `ingestion_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fund_id`) REFERENCES `fund`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ingestion_expectation_session_idx` ON `ingestion_expectation` (`session_date`);
--> statement-breakpoint
CREATE TRIGGER `ingestion_expectation_date_valid_insert` BEFORE INSERT ON `ingestion_expectation`
WHEN length(NEW.`session_date`) <> 10 OR date(NEW.`session_date`) IS NOT NEW.`session_date`
BEGIN SELECT RAISE(ABORT, 'invalid_session_date'); END;
