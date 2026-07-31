PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ingestion_run` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`trigger_kind` text DEFAULT 'manual' NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`latest_session` text,
	`expected_count` integer DEFAULT 0 NOT NULL,
	`resolved_count` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ingestion_run_status_check" CHECK("status" IN ('running', 'succeeded', 'partial', 'failed')),
	CONSTRAINT "ingestion_run_trigger_check" CHECK("trigger_kind" IN ('scheduled', 'manual'))
);
--> statement-breakpoint
INSERT INTO `__new_ingestion_run`("id", "source", "trigger_kind", "started_at", "finished_at", "status", "latest_session", "expected_count", "resolved_count", "failure_count") SELECT "id", "source", 'manual', "started_at", "finished_at", "status", "latest_session", "expected_count", "resolved_count", "failure_count" FROM `ingestion_run`;--> statement-breakpoint
DROP TABLE `ingestion_run`;--> statement-breakpoint
ALTER TABLE `__new_ingestion_run` RENAME TO `ingestion_run`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
PRAGMA foreign_key_check;
--> statement-breakpoint
CREATE TRIGGER `ingestion_run_date_valid_insert` BEFORE INSERT ON `ingestion_run`
WHEN NEW.`latest_session` IS NOT NULL AND (length(NEW.`latest_session`) <> 10 OR date(NEW.`latest_session`) IS NOT NEW.`latest_session`)
BEGIN SELECT RAISE(ABORT, 'invalid_latest_session'); END;
--> statement-breakpoint
CREATE TRIGGER `ingestion_run_date_valid_update` BEFORE UPDATE OF `latest_session` ON `ingestion_run`
WHEN NEW.`latest_session` IS NOT NULL AND (length(NEW.`latest_session`) <> 10 OR date(NEW.`latest_session`) IS NOT NEW.`latest_session`)
BEGIN SELECT RAISE(ABORT, 'invalid_latest_session'); END;
