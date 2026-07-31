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
CREATE TABLE `ingestion_run` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`latest_session` text,
	`expected_count` integer DEFAULT 0 NOT NULL,
	`resolved_count` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ingestion_run_status_check" CHECK("ingestion_run"."status" IN ('running', 'succeeded', 'partial', 'failed'))
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
CREATE TABLE `watchlist` (
	`fund_id` text PRIMARY KEY NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`added_at` text NOT NULL,
	FOREIGN KEY (`fund_id`) REFERENCES `fund`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TRIGGER `fund_ticker_no_overlap_insert`
BEFORE INSERT ON `fund_ticker`
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM `fund_ticker` existing
    WHERE (
      existing.`fund_id` = NEW.`fund_id` OR existing.`ticker` = NEW.`ticker`
    )
    AND NEW.`valid_from` <= COALESCE(existing.`valid_to`, '9999-12-31')
    AND existing.`valid_from` <= COALESCE(NEW.`valid_to`, '9999-12-31')
  ) THEN RAISE(ABORT, 'ticker_validity_overlap') END;
END;
--> statement-breakpoint
CREATE TRIGGER `fund_ticker_no_overlap_update`
BEFORE UPDATE ON `fund_ticker`
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM `fund_ticker` existing
    WHERE existing.`rowid` <> OLD.`rowid`
    AND (
      existing.`fund_id` = NEW.`fund_id` OR existing.`ticker` = NEW.`ticker`
    )
    AND NEW.`valid_from` <= COALESCE(existing.`valid_to`, '9999-12-31')
    AND existing.`valid_from` <= COALESCE(NEW.`valid_to`, '9999-12-31')
  ) THEN RAISE(ABORT, 'ticker_validity_overlap') END;
END;
--> statement-breakpoint
CREATE TRIGGER `fund_ticker_immutable_identity`
BEFORE UPDATE ON `fund_ticker`
WHEN NEW.`fund_id` <> OLD.`fund_id`
  OR NEW.`ticker` <> OLD.`ticker`
  OR NEW.`valid_from` <> OLD.`valid_from`
  OR (OLD.`valid_to` IS NOT NULL AND NEW.`valid_to` IS NOT OLD.`valid_to`)
BEGIN
  SELECT RAISE(ABORT, 'ticker_assignment_identity_is_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `fund_ticker_no_history_rewrite`
BEFORE UPDATE OF `valid_to` ON `fund_ticker`
WHEN OLD.`valid_to` IS NULL AND NEW.`valid_to` IS NOT NULL AND EXISTS (
  SELECT 1 FROM `daily_record`
  WHERE `fund_id` = OLD.`fund_id` AND `session_date` > NEW.`valid_to`
)
BEGIN
  SELECT RAISE(ABORT, 'ticker_change_would_rewrite_history');
END;
--> statement-breakpoint
CREATE TRIGGER `fund_ticker_no_delete`
BEFORE DELETE ON `fund_ticker`
BEGIN
  SELECT RAISE(ABORT, 'ticker_assignments_are_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER `fund_dates_valid_insert` BEFORE INSERT ON `fund`
WHEN (NEW.`inception_date` IS NOT NULL AND (length(NEW.`inception_date`) <> 10 OR date(NEW.`inception_date`) IS NOT NEW.`inception_date`))
  OR (NEW.`delisted_date` IS NOT NULL AND (length(NEW.`delisted_date`) <> 10 OR date(NEW.`delisted_date`) IS NOT NEW.`delisted_date`))
  OR (NEW.`inception_date` IS NOT NULL AND NEW.`delisted_date` IS NOT NULL AND NEW.`delisted_date` < NEW.`inception_date`)
BEGIN SELECT RAISE(ABORT, 'invalid_fund_lifecycle_date'); END;
--> statement-breakpoint
CREATE TRIGGER `fund_dates_valid_update` BEFORE UPDATE OF `inception_date`, `delisted_date` ON `fund`
WHEN (NEW.`inception_date` IS NOT NULL AND (length(NEW.`inception_date`) <> 10 OR date(NEW.`inception_date`) IS NOT NEW.`inception_date`))
  OR (NEW.`delisted_date` IS NOT NULL AND (length(NEW.`delisted_date`) <> 10 OR date(NEW.`delisted_date`) IS NOT NEW.`delisted_date`))
  OR (NEW.`inception_date` IS NOT NULL AND NEW.`delisted_date` IS NOT NULL AND NEW.`delisted_date` < NEW.`inception_date`)
BEGIN SELECT RAISE(ABORT, 'invalid_fund_lifecycle_date'); END;
--> statement-breakpoint
CREATE TRIGGER `fund_ticker_dates_valid_insert` BEFORE INSERT ON `fund_ticker`
WHEN length(NEW.`valid_from`) <> 10 OR date(NEW.`valid_from`) IS NOT NEW.`valid_from`
  OR (NEW.`valid_to` IS NOT NULL AND (length(NEW.`valid_to`) <> 10 OR date(NEW.`valid_to`) IS NOT NEW.`valid_to`))
BEGIN SELECT RAISE(ABORT, 'invalid_ticker_validity_date'); END;
--> statement-breakpoint
CREATE TRIGGER `fund_ticker_dates_valid_update` BEFORE UPDATE OF `valid_from`, `valid_to` ON `fund_ticker`
WHEN length(NEW.`valid_from`) <> 10 OR date(NEW.`valid_from`) IS NOT NEW.`valid_from`
  OR (NEW.`valid_to` IS NOT NULL AND (length(NEW.`valid_to`) <> 10 OR date(NEW.`valid_to`) IS NOT NEW.`valid_to`))
BEGIN SELECT RAISE(ABORT, 'invalid_ticker_validity_date'); END;
--> statement-breakpoint
CREATE TRIGGER `daily_record_date_valid_insert` BEFORE INSERT ON `daily_record`
WHEN length(NEW.`session_date`) <> 10 OR date(NEW.`session_date`) IS NOT NEW.`session_date`
BEGIN SELECT RAISE(ABORT, 'invalid_session_date'); END;
--> statement-breakpoint
CREATE TRIGGER `daily_record_date_valid_update` BEFORE UPDATE OF `session_date` ON `daily_record`
WHEN length(NEW.`session_date`) <> 10 OR date(NEW.`session_date`) IS NOT NEW.`session_date`
BEGIN SELECT RAISE(ABORT, 'invalid_session_date'); END;
--> statement-breakpoint
CREATE TRIGGER `record_event_date_valid_insert` BEFORE INSERT ON `record_event`
WHEN length(NEW.`session_date`) <> 10 OR date(NEW.`session_date`) IS NOT NEW.`session_date`
BEGIN SELECT RAISE(ABORT, 'invalid_session_date'); END;
--> statement-breakpoint
CREATE TRIGGER `ingestion_run_date_valid_insert` BEFORE INSERT ON `ingestion_run`
WHEN NEW.`latest_session` IS NOT NULL AND (length(NEW.`latest_session`) <> 10 OR date(NEW.`latest_session`) IS NOT NEW.`latest_session`)
BEGIN SELECT RAISE(ABORT, 'invalid_latest_session'); END;
--> statement-breakpoint
CREATE TRIGGER `ingestion_run_date_valid_update` BEFORE UPDATE OF `latest_session` ON `ingestion_run`
WHEN NEW.`latest_session` IS NOT NULL AND (length(NEW.`latest_session`) <> 10 OR date(NEW.`latest_session`) IS NOT NEW.`latest_session`)
BEGIN SELECT RAISE(ABORT, 'invalid_latest_session'); END;
--> statement-breakpoint
CREATE TRIGGER `record_event_validate_insert`
BEFORE INSERT ON `record_event`
BEGIN
  SELECT CASE
    WHEN NEW.`from_version` = 0 AND EXISTS (
      SELECT 1 FROM `daily_record`
      WHERE `fund_id` = NEW.`fund_id` AND `session_date` = NEW.`session_date`
    ) THEN RAISE(ABORT, 'version_conflict')
    WHEN NEW.`from_version` > 0 AND NOT EXISTS (
      SELECT 1 FROM `daily_record`
      WHERE `fund_id` = NEW.`fund_id`
        AND `session_date` = NEW.`session_date`
        AND `version` = NEW.`from_version`
    ) THEN RAISE(ABORT, 'version_conflict')
  END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.`changes`)
    WHERE `key` NOT IN ('status', 'price', 'volume', 'source')
  ) THEN RAISE(ABORT, 'unknown_change_field') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM json_each(NEW.`changes`)
  ) THEN RAISE(ABORT, 'empty_change_set') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.`changes`)
    WHERE json_type(`value`) <> 'object'
  ) THEN RAISE(ABORT, 'invalid_change_shape') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.`changes`) field
    WHERE json_type(field.`value`, '$.old') IS NULL
      OR json_type(field.`value`, '$.new') IS NULL
      OR (SELECT COUNT(*) FROM json_each(field.`value`)) <> 2
      OR EXISTS (
        SELECT 1 FROM json_each(field.`value`)
        WHERE `key` NOT IN ('old', 'new')
      )
  ) THEN RAISE(ABORT, 'invalid_change_members') END;
  SELECT CASE WHEN
    (
      json_type(NEW.`changes`, '$.status') IS NOT NULL AND
      (
        json_type(NEW.`changes`, '$.status.old') NOT IN ('text', 'null') OR
        json_type(NEW.`changes`, '$.status.new') <> 'text'
      )
    ) OR
    (
      json_type(NEW.`changes`, '$.price') IS NOT NULL AND
      (
        json_type(NEW.`changes`, '$.price.old') NOT IN ('text', 'null') OR
        json_type(NEW.`changes`, '$.price.new') NOT IN ('text', 'null')
      )
    ) OR
    (
      json_type(NEW.`changes`, '$.volume') IS NOT NULL AND
      (
        json_type(NEW.`changes`, '$.volume.old') NOT IN ('text', 'null') OR
        json_type(NEW.`changes`, '$.volume.new') NOT IN ('text', 'null')
      )
    ) OR
    (
      json_type(NEW.`changes`, '$.source') IS NOT NULL AND
      (
        json_type(NEW.`changes`, '$.source.old') NOT IN ('text', 'null') OR
        json_type(NEW.`changes`, '$.source.new') <> 'text' OR
        json_extract(NEW.`changes`, '$.source.new') = ''
      )
    )
  THEN RAISE(ABORT, 'invalid_change_value_type') END;
  SELECT CASE WHEN NEW.`from_version` > 0 AND EXISTS (
    SELECT 1 FROM json_each(NEW.`changes`)
    WHERE json_extract(`value`, '$.old') IS json_extract(`value`, '$.new')
  ) THEN RAISE(ABORT, 'no_op_change') END;
  SELECT CASE
    WHEN NEW.`from_version` = 0 AND (
      json_type(NEW.`changes`, '$.status') IS NULL OR
      json_type(NEW.`changes`, '$.price') IS NULL OR
      json_type(NEW.`changes`, '$.volume') IS NULL OR
      json_type(NEW.`changes`, '$.source') IS NULL OR
      json_type(NEW.`changes`, '$.status.old') <> 'null' OR
      json_type(NEW.`changes`, '$.price.old') <> 'null' OR
      json_type(NEW.`changes`, '$.volume.old') <> 'null' OR
      json_type(NEW.`changes`, '$.source.old') <> 'null'
    ) THEN RAISE(ABORT, 'invalid_creation_receipt')
  END;
  SELECT CASE
    WHEN NEW.`from_version` > 0 AND (
      (
        json_type(NEW.`changes`, '$.status') IS NOT NULL AND
        json_extract(NEW.`changes`, '$.status.old') IS NOT (
          SELECT `status` FROM `daily_record`
          WHERE `fund_id` = NEW.`fund_id` AND `session_date` = NEW.`session_date`
        )
      ) OR
      (
        json_type(NEW.`changes`, '$.price') IS NOT NULL AND
        json_extract(NEW.`changes`, '$.price.old') IS NOT (
          SELECT `price` FROM `daily_record`
          WHERE `fund_id` = NEW.`fund_id` AND `session_date` = NEW.`session_date`
        )
      ) OR
      (
        json_type(NEW.`changes`, '$.volume') IS NOT NULL AND
        json_extract(NEW.`changes`, '$.volume.old') IS NOT (
          SELECT `volume` FROM `daily_record`
          WHERE `fund_id` = NEW.`fund_id` AND `session_date` = NEW.`session_date`
        )
      ) OR
      (
        json_type(NEW.`changes`, '$.source') IS NOT NULL AND
        json_extract(NEW.`changes`, '$.source.old') IS NOT (
          SELECT `source` FROM `daily_record`
          WHERE `fund_id` = NEW.`fund_id` AND `session_date` = NEW.`session_date`
        )
      )
    ) THEN RAISE(ABORT, 'event_old_value_mismatch')
  END;
  SELECT CASE WHEN NEW.`from_version` > 0 AND NEW.`detected_at` < (
    SELECT `updated_at` FROM `daily_record`
    WHERE `fund_id` = NEW.`fund_id` AND `session_date` = NEW.`session_date`
  ) THEN RAISE(ABORT, 'stale_event') END;
  SELECT CASE WHEN NEW.`source` = '' OR NEW.`source` IS NOT (
    CASE
      WHEN json_type(NEW.`changes`, '$.source') IS NOT NULL
      THEN json_extract(NEW.`changes`, '$.source.new')
      ELSE (
        SELECT `source` FROM `daily_record`
        WHERE `fund_id` = NEW.`fund_id` AND `session_date` = NEW.`session_date`
      )
    END
  ) THEN RAISE(ABORT, 'event_source_mismatch') END;
END;
--> statement-breakpoint
CREATE TRIGGER `record_event_apply_create`
AFTER INSERT ON `record_event`
WHEN NEW.`from_version` = 0
BEGIN
  INSERT INTO `daily_record` (
    `fund_id`, `session_date`, `status`, `price`, `volume`,
    `source`, `version`, `updated_at`
  ) VALUES (
    NEW.`fund_id`,
    NEW.`session_date`,
    json_extract(NEW.`changes`, '$.status.new'),
    json_extract(NEW.`changes`, '$.price.new'),
    json_extract(NEW.`changes`, '$.volume.new'),
    NEW.`source`,
    NEW.`to_version`,
    NEW.`detected_at`
  );
END;
--> statement-breakpoint
CREATE TRIGGER `record_event_apply_revision`
AFTER INSERT ON `record_event`
WHEN NEW.`from_version` > 0
BEGIN
  UPDATE `daily_record` SET
    `status` = CASE
      WHEN json_type(NEW.`changes`, '$.status') IS NOT NULL
      THEN json_extract(NEW.`changes`, '$.status.new') ELSE `status` END,
    `price` = CASE
      WHEN json_type(NEW.`changes`, '$.price') IS NOT NULL
      THEN json_extract(NEW.`changes`, '$.price.new') ELSE `price` END,
    `volume` = CASE
      WHEN json_type(NEW.`changes`, '$.volume') IS NOT NULL
      THEN json_extract(NEW.`changes`, '$.volume.new') ELSE `volume` END,
    `source` = CASE
      WHEN json_type(NEW.`changes`, '$.source') IS NOT NULL
      THEN json_extract(NEW.`changes`, '$.source.new') ELSE `source` END,
    `version` = NEW.`to_version`,
    `updated_at` = NEW.`detected_at`
  WHERE `fund_id` = NEW.`fund_id`
    AND `session_date` = NEW.`session_date`
    AND `version` = NEW.`from_version`;
END;
--> statement-breakpoint
CREATE TRIGGER `daily_record_no_direct_insert`
BEFORE INSERT ON `daily_record`
WHEN NOT EXISTS (
  SELECT 1 FROM `record_event`
  WHERE `fund_id` = NEW.`fund_id`
    AND `session_date` = NEW.`session_date`
    AND `from_version` = 0
    AND `to_version` = NEW.`version`
    AND `detected_at` = NEW.`updated_at`
)
BEGIN
  SELECT RAISE(ABORT, 'daily_record_event_required');
END;
--> statement-breakpoint
CREATE TRIGGER `daily_record_no_direct_update`
BEFORE UPDATE ON `daily_record`
WHEN NOT EXISTS (
  SELECT 1 FROM `record_event`
  WHERE `fund_id` = NEW.`fund_id`
    AND `session_date` = NEW.`session_date`
    AND `from_version` = OLD.`version`
    AND `to_version` = NEW.`version`
    AND `detected_at` = NEW.`updated_at`
)
BEGIN
  SELECT RAISE(ABORT, 'daily_record_event_required');
END;
--> statement-breakpoint
CREATE TRIGGER `daily_record_no_direct_delete`
BEFORE DELETE ON `daily_record`
BEGIN
  SELECT RAISE(ABORT, 'daily_record_event_required');
END;
--> statement-breakpoint
CREATE TRIGGER `record_event_no_update`
BEFORE UPDATE ON `record_event`
BEGIN
  SELECT RAISE(ABORT, 'record_event_is_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER `record_event_no_delete`
BEFORE DELETE ON `record_event`
BEGIN
  SELECT RAISE(ABORT, 'record_event_is_append_only');
END;
