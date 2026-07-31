CREATE TABLE IF NOT EXISTS `ingestion_lease` (
	`id` integer PRIMARY KEY NOT NULL,
	`run_id` text,
	`acquired_at` text,
	`released_at` text,
	CONSTRAINT "ingestion_lease_singleton_check" CHECK("ingestion_lease"."id" = 1)
);
--> statement-breakpoint
INSERT OR IGNORE INTO `ingestion_lease` (`id`, `run_id`, `acquired_at`, `released_at`)
VALUES (1, NULL, NULL, NULL);
