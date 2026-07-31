CREATE TABLE `daily_record` (
	`fund_id` text NOT NULL,
	`session_date` text NOT NULL,
	`status` text NOT NULL,
	`price` text,
	`volume` text,
	`source` text NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`fund_id`, `session_date`),
	FOREIGN KEY (`fund_id`) REFERENCES `fund`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "daily_record_status_check" CHECK("daily_record"."status" IN ('pending', 'priced', 'no_trade', 'suspended', 'not_listed', 'missing')),
	CONSTRAINT "daily_record_version_check" CHECK("daily_record"."version" > 0),
	CONSTRAINT "daily_record_price_check" CHECK("daily_record"."price" IS NULL OR (
        typeof("daily_record"."price") = 'text'
        AND instr("daily_record"."price", '.') > 1
        AND length("daily_record"."price") - instr("daily_record"."price", '.') = 6
        AND "daily_record"."price" NOT GLOB '*[^0-9.]*'
        AND substr("daily_record"."price", instr("daily_record"."price", '.') + 1) NOT GLOB '*[^0-9]*'
        AND (
          substr("daily_record"."price", 1, instr("daily_record"."price", '.') - 1) = '0' OR
          substr("daily_record"."price", 1, 1) <> '0'
        )
      )),
	CONSTRAINT "daily_record_volume_check" CHECK("daily_record"."volume" IS NULL OR (
        typeof("daily_record"."volume") = 'text'
        AND length("daily_record"."volume") > 0
        AND "daily_record"."volume" NOT GLOB '*[^0-9]*'
        AND ("daily_record"."volume" = '0' OR substr("daily_record"."volume", 1, 1) <> '0')
      )),
	CONSTRAINT "daily_record_state_shape_check" CHECK((
        ("daily_record"."status" = 'priced' AND "daily_record"."price" IS NOT NULL AND "daily_record"."volume" IS NOT NULL) OR
        ("daily_record"."status" = 'no_trade' AND "daily_record"."price" IS NOT NULL AND "daily_record"."volume" = '0') OR
        ("daily_record"."status" IN ('pending', 'suspended', 'not_listed', 'missing')
          AND "daily_record"."price" IS NULL AND "daily_record"."volume" IS NULL)
      ))
);
--> statement-breakpoint
CREATE INDEX `daily_record_session_idx` ON `daily_record` (`session_date`);--> statement-breakpoint
CREATE INDEX `daily_record_status_idx` ON `daily_record` (`status`);--> statement-breakpoint
CREATE TABLE `fetch_attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`ticker` text NOT NULL,
	`source` text NOT NULL,
	`attempted_at` text NOT NULL,
	`outcome` text NOT NULL,
	`detail` text,
	FOREIGN KEY (`run_id`) REFERENCES `ingestion_run`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "fetch_attempt_outcome_check" CHECK("fetch_attempt"."outcome" IN ('succeeded', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `fetch_attempt_run_idx` ON `fetch_attempt` (`run_id`);--> statement-breakpoint
CREATE TABLE `fund_ticker` (
	`fund_id` text NOT NULL,
	`ticker` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	PRIMARY KEY(`fund_id`, `valid_from`),
	FOREIGN KEY (`fund_id`) REFERENCES `fund`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "fund_ticker_validity_check" CHECK("fund_ticker"."valid_to" IS NULL OR "fund_ticker"."valid_to" >= "fund_ticker"."valid_from")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fund_ticker_identity_idx` ON `fund_ticker` (`ticker`,`valid_from`);--> statement-breakpoint
CREATE UNIQUE INDEX `fund_ticker_one_current_per_fund_idx` ON `fund_ticker` (`fund_id`) WHERE "fund_ticker"."valid_to" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `fund_ticker_one_current_assignment_idx` ON `fund_ticker` (`ticker`) WHERE "fund_ticker"."valid_to" IS NULL;--> statement-breakpoint
CREATE TABLE `fund` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`exchange` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`instrument_type` text NOT NULL,
	`inception_date` text,
	`delisted_date` text,
	`created_at` text NOT NULL,
	CONSTRAINT "fund_instrument_type_check" CHECK("fund"."instrument_type" IN ('ETF', 'CEF')),
	CONSTRAINT "fund_currency_check" CHECK("fund"."currency" = 'USD')
);
--> statement-breakpoint
CREATE TABLE `ingestion_expectation` (
	`run_id` text NOT NULL,
	`session_date` text NOT NULL,
	`fund_id` text NOT NULL,
	PRIMARY KEY(`run_id`, `session_date`, `fund_id`),
	FOREIGN KEY (`run_id`) REFERENCES `ingestion_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fund_id`) REFERENCES `fund`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ingestion_expectation_session_idx` ON `ingestion_expectation` (`session_date`);--> statement-breakpoint
CREATE TABLE `ingestion_lease` (
	`id` integer PRIMARY KEY NOT NULL,
	`run_id` text,
	`acquired_at` text,
	`released_at` text,
	CONSTRAINT "ingestion_lease_singleton_check" CHECK("ingestion_lease"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `ingestion_run` (
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
	CONSTRAINT "ingestion_run_status_check" CHECK("ingestion_run"."status" IN ('running', 'succeeded', 'partial', 'failed')),
	CONSTRAINT "ingestion_run_trigger_check" CHECK("ingestion_run"."trigger_kind" IN ('scheduled', 'manual'))
);
--> statement-breakpoint
CREATE TABLE `record_event` (
	`id` text PRIMARY KEY NOT NULL,
	`fund_id` text NOT NULL,
	`session_date` text NOT NULL,
	`from_version` integer NOT NULL,
	`to_version` integer NOT NULL,
	`event_type` text NOT NULL,
	`changes` text NOT NULL,
	`source` text NOT NULL,
	`detected_at` text NOT NULL,
	CONSTRAINT "record_event_json_check" CHECK(json_valid("record_event"."changes")),
	CONSTRAINT "record_event_version_step_check" CHECK("record_event"."to_version" = "record_event"."from_version" + 1),
	CONSTRAINT "record_event_type_check" CHECK((
        ("record_event"."from_version" = 0 AND "record_event"."event_type" = 'created') OR
        ("record_event"."from_version" > 0 AND "record_event"."event_type" = 'revised')
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `record_event_version_idx` ON `record_event` (`fund_id`,`session_date`,`to_version`);--> statement-breakpoint
CREATE INDEX `record_event_lookup_idx` ON `record_event` (`fund_id`,`session_date`);--> statement-breakpoint
CREATE TABLE `reference_session` (
	`session_date` text PRIMARY KEY NOT NULL,
	`first_observed_at` text NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `watchlist` (
	`fund_id` text PRIMARY KEY NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`added_at` text NOT NULL,
	FOREIGN KEY (`fund_id`) REFERENCES `fund`(`id`) ON UPDATE no action ON DELETE no action
);
