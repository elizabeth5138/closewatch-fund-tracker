import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const funds = sqliteTable(
  "fund",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    exchange: text("exchange").notNull(),
    currency: text("currency").notNull().default("USD"),
    instrumentType: text("instrument_type", { enum: ["ETF", "CEF"] }).notNull(),
    inceptionDate: text("inception_date"),
    delistedDate: text("delisted_date"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("fund_instrument_type_check", sql`${table.instrumentType} IN ('ETF', 'CEF')`),
    check("fund_currency_check", sql`${table.currency} = 'USD'`),
  ],
);

export const fundTickers = sqliteTable(
  "fund_ticker",
  {
    fundId: text("fund_id")
      .notNull()
      .references(() => funds.id),
    ticker: text("ticker").notNull(),
    validFrom: text("valid_from").notNull(),
    validTo: text("valid_to"),
  },
  (table) => [
    primaryKey({ columns: [table.fundId, table.validFrom] }),
    uniqueIndex("fund_ticker_identity_idx").on(table.ticker, table.validFrom),
    uniqueIndex("fund_ticker_one_current_per_fund_idx")
      .on(table.fundId)
      .where(sql`${table.validTo} IS NULL`),
    uniqueIndex("fund_ticker_one_current_assignment_idx")
      .on(table.ticker)
      .where(sql`${table.validTo} IS NULL`),
    check(
      "fund_ticker_validity_check",
      sql`${table.validTo} IS NULL OR ${table.validTo} >= ${table.validFrom}`,
    ),
  ],
);

export const ingestionRuns = sqliteTable(
  "ingestion_run",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    triggerKind: text("trigger_kind", { enum: ["scheduled", "manual"] }).notNull().default("manual"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    status: text("status", { enum: ["running", "succeeded", "partial", "failed"] }).notNull(),
    latestSession: text("latest_session"),
    expectedCount: integer("expected_count").notNull().default(0),
    resolvedCount: integer("resolved_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
  },
  (table) => [
    check(
      "ingestion_run_status_check",
      sql`${table.status} IN ('running', 'succeeded', 'partial', 'failed')`,
    ),
    check(
      "ingestion_run_trigger_check",
      sql`${table.triggerKind} IN ('scheduled', 'manual')`,
    ),
  ],
);

export const fetchAttempts = sqliteTable(
  "fetch_attempt",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => ingestionRuns.id),
    ticker: text("ticker").notNull(),
    source: text("source").notNull(),
    attemptedAt: text("attempted_at").notNull(),
    outcome: text("outcome", { enum: ["succeeded", "failed"] }).notNull(),
    detail: text("detail"),
  },
  (table) => [
    index("fetch_attempt_run_idx").on(table.runId),
    check(
      "fetch_attempt_outcome_check",
      sql`${table.outcome} IN ('succeeded', 'failed')`,
    ),
  ],
);

export const ingestionLease = sqliteTable(
  "ingestion_lease",
  {
    id: integer("id").primaryKey(),
    runId: text("run_id"),
    acquiredAt: text("acquired_at"),
    releasedAt: text("released_at"),
  },
  (table) => [check("ingestion_lease_singleton_check", sql`${table.id} = 1`)],
);

export const ingestionExpectations = sqliteTable(
  "ingestion_expectation",
  {
    runId: text("run_id")
      .notNull()
      .references(() => ingestionRuns.id),
    sessionDate: text("session_date").notNull(),
    fundId: text("fund_id")
      .notNull()
      .references(() => funds.id),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.sessionDate, table.fundId] }),
    index("ingestion_expectation_session_idx").on(table.sessionDate),
  ],
);

export const referenceSessions = sqliteTable("reference_session", {
  sessionDate: text("session_date").primaryKey(),
  firstObservedAt: text("first_observed_at").notNull(),
  source: text("source").notNull(),
});

export const watchlist = sqliteTable("watchlist", {
  fundId: text("fund_id")
    .primaryKey()
    .references(() => funds.id),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  addedAt: text("added_at").notNull(),
});

export const dailyRecords = sqliteTable(
  "daily_record",
  {
    fundId: text("fund_id")
      .notNull()
      .references(() => funds.id),
    sessionDate: text("session_date").notNull(),
    status: text("status", {
      enum: ["pending", "priced", "no_trade", "suspended", "not_listed", "missing"],
    }).notNull(),
    price: text("price"),
    volume: text("volume"),
    source: text("source").notNull(),
    version: integer("version").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.fundId, table.sessionDate] }),
    index("daily_record_session_idx").on(table.sessionDate),
    index("daily_record_status_idx").on(table.status),
    check(
      "daily_record_status_check",
      sql`${table.status} IN ('pending', 'priced', 'no_trade', 'suspended', 'not_listed', 'missing')`,
    ),
    check("daily_record_version_check", sql`${table.version} > 0`),
    check(
      "daily_record_price_check",
      sql`${table.price} IS NULL OR (
        typeof(${table.price}) = 'text'
        AND instr(${table.price}, '.') > 1
        AND length(${table.price}) - instr(${table.price}, '.') = 6
        AND ${table.price} NOT GLOB '*[^0-9.]*'
        AND substr(${table.price}, instr(${table.price}, '.') + 1) NOT GLOB '*[^0-9]*'
        AND (
          substr(${table.price}, 1, instr(${table.price}, '.') - 1) = '0' OR
          substr(${table.price}, 1, 1) <> '0'
        )
      )`,
    ),
    check(
      "daily_record_volume_check",
      sql`${table.volume} IS NULL OR (
        typeof(${table.volume}) = 'text'
        AND length(${table.volume}) > 0
        AND ${table.volume} NOT GLOB '*[^0-9]*'
        AND (${table.volume} = '0' OR substr(${table.volume}, 1, 1) <> '0')
      )`,
    ),
    check(
      "daily_record_state_shape_check",
      sql`(
        (${table.status} = 'priced' AND ${table.price} IS NOT NULL AND ${table.volume} IS NOT NULL) OR
        (${table.status} = 'no_trade' AND ${table.price} IS NOT NULL AND ${table.volume} = '0') OR
        (${table.status} IN ('pending', 'suspended', 'not_listed', 'missing')
          AND ${table.price} IS NULL AND ${table.volume} IS NULL)
      )`,
    ),
  ],
);

export const recordEvents = sqliteTable(
  "record_event",
  {
    id: text("id").primaryKey(),
    fundId: text("fund_id").notNull(),
    sessionDate: text("session_date").notNull(),
    fromVersion: integer("from_version").notNull(),
    toVersion: integer("to_version").notNull(),
    eventType: text("event_type", { enum: ["created", "revised"] }).notNull(),
    changes: text("changes").notNull(),
    source: text("source").notNull(),
    detectedAt: text("detected_at").notNull(),
  },
  (table) => [
    uniqueIndex("record_event_version_idx").on(
      table.fundId,
      table.sessionDate,
      table.toVersion,
    ),
    index("record_event_lookup_idx").on(table.fundId, table.sessionDate),
    check("record_event_json_check", sql`json_valid(${table.changes})`),
    check(
      "record_event_version_step_check",
      sql`${table.toVersion} = ${table.fromVersion} + 1`,
    ),
    check(
      "record_event_type_check",
      sql`(
        (${table.fromVersion} = 0 AND ${table.eventType} = 'created') OR
        (${table.fromVersion} > 0 AND ${table.eventType} = 'revised')
      )`,
    ),
  ],
);
