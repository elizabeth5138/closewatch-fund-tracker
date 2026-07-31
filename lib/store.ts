import {
  createTransition,
  type CandidateObservation,
  type DailyRecord,
} from "./domain.ts";

export type TrackedFund = {
  fundId: string;
  name: string;
  inceptionDate: string | null;
  delistedDate: string | null;
  tickers: Array<{
    ticker: string;
    validFrom: string;
    validTo: string | null;
  }>;
};

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS fund (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    exchange TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    instrument_type TEXT NOT NULL CHECK (instrument_type IN ('ETF', 'CEF')),
    inception_date TEXT,
    delisted_date TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fund_ticker (
    fund_id TEXT NOT NULL REFERENCES fund(id),
    ticker TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    PRIMARY KEY (fund_id, valid_from),
    UNIQUE (ticker, valid_from),
    CHECK (valid_to IS NULL OR valid_to >= valid_from)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS fund_ticker_one_current_per_fund_idx
    ON fund_ticker(fund_id) WHERE valid_to IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS fund_ticker_one_current_assignment_idx
    ON fund_ticker(ticker) WHERE valid_to IS NULL`,
  `CREATE TRIGGER IF NOT EXISTS fund_ticker_no_overlap_insert
    BEFORE INSERT ON fund_ticker
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM fund_ticker existing
        WHERE (
          existing.fund_id = NEW.fund_id OR existing.ticker = NEW.ticker
        )
        AND NEW.valid_from <= COALESCE(existing.valid_to, '9999-12-31')
        AND existing.valid_from <= COALESCE(NEW.valid_to, '9999-12-31')
      ) THEN RAISE(ABORT, 'ticker_validity_overlap') END;
    END`,
  `CREATE TRIGGER IF NOT EXISTS fund_ticker_no_overlap_update
    BEFORE UPDATE ON fund_ticker
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM fund_ticker existing
        WHERE existing.rowid <> OLD.rowid
        AND (
          existing.fund_id = NEW.fund_id OR existing.ticker = NEW.ticker
        )
        AND NEW.valid_from <= COALESCE(existing.valid_to, '9999-12-31')
        AND existing.valid_from <= COALESCE(NEW.valid_to, '9999-12-31')
      ) THEN RAISE(ABORT, 'ticker_validity_overlap') END;
    END`,
  `CREATE TRIGGER IF NOT EXISTS fund_ticker_immutable_identity
    BEFORE UPDATE ON fund_ticker
    WHEN NEW.fund_id <> OLD.fund_id
      OR NEW.ticker <> OLD.ticker
      OR NEW.valid_from <> OLD.valid_from
      OR (OLD.valid_to IS NOT NULL AND NEW.valid_to IS NOT OLD.valid_to)
    BEGIN
      SELECT RAISE(ABORT, 'ticker_assignment_identity_is_immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS fund_ticker_no_history_rewrite
    BEFORE UPDATE OF valid_to ON fund_ticker
    WHEN OLD.valid_to IS NULL AND NEW.valid_to IS NOT NULL AND EXISTS (
      SELECT 1 FROM daily_record
      WHERE fund_id = OLD.fund_id AND session_date > NEW.valid_to
    )
    BEGIN
      SELECT RAISE(ABORT, 'ticker_change_would_rewrite_history');
    END`,
  `CREATE TRIGGER IF NOT EXISTS fund_ticker_no_delete
    BEFORE DELETE ON fund_ticker
    BEGIN
      SELECT RAISE(ABORT, 'ticker_assignments_are_append_only');
    END`,
  `CREATE TABLE IF NOT EXISTS watchlist (
    fund_id TEXT PRIMARY KEY REFERENCES fund(id),
    active INTEGER NOT NULL DEFAULT 1,
    added_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS daily_record (
    fund_id TEXT NOT NULL REFERENCES fund(id),
    session_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('pending', 'priced', 'no_trade', 'suspended', 'not_listed', 'missing')
    ),
    price TEXT,
    volume TEXT,
    source TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (fund_id, session_date),
    CHECK (
      price IS NULL OR (
        typeof(price) = 'text'
        AND instr(price, '.') > 1
        AND length(price) - instr(price, '.') = 6
        AND price NOT GLOB '*[^0-9.]*'
        AND substr(price, instr(price, '.') + 1) NOT GLOB '*[^0-9]*'
        AND (
          substr(price, 1, instr(price, '.') - 1) = '0' OR
          substr(price, 1, 1) <> '0'
        )
      )
    ),
    CHECK (
      volume IS NULL OR (
        typeof(volume) = 'text'
        AND length(volume) > 0
        AND volume NOT GLOB '*[^0-9]*'
        AND (volume = '0' OR substr(volume, 1, 1) <> '0')
      )
    ),
    CHECK (
      (status = 'priced' AND price IS NOT NULL AND volume IS NOT NULL) OR
      (status = 'no_trade' AND price IS NOT NULL AND volume = '0') OR
      (status IN ('pending', 'suspended', 'not_listed', 'missing')
        AND price IS NULL AND volume IS NULL)
    )
  )`,
  `CREATE TABLE IF NOT EXISTS record_event (
    id TEXT PRIMARY KEY,
    fund_id TEXT NOT NULL,
    session_date TEXT NOT NULL,
    from_version INTEGER NOT NULL,
    to_version INTEGER NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('created', 'revised')),
    changes TEXT NOT NULL CHECK (json_valid(changes)),
    source TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    UNIQUE (fund_id, session_date, to_version),
    CHECK (to_version = from_version + 1),
    CHECK (
      (from_version = 0 AND event_type = 'created') OR
      (from_version > 0 AND event_type = 'revised')
    )
  )`,
  `CREATE TABLE IF NOT EXISTS ingestion_run (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    trigger_kind TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_kind IN ('scheduled', 'manual')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
    latest_session TEXT,
    expected_count INTEGER NOT NULL DEFAULT 0,
    resolved_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS fetch_attempt (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES ingestion_run(id),
    ticker TEXT NOT NULL,
    source TEXT NOT NULL,
    attempted_at TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
    detail TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS fetch_attempt_run_idx ON fetch_attempt(run_id)`,
  `CREATE TABLE IF NOT EXISTS ingestion_lease (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    run_id TEXT,
    acquired_at TEXT,
    released_at TEXT
  )`,
  `INSERT OR IGNORE INTO ingestion_lease
    (id, run_id, acquired_at, released_at) VALUES (1, NULL, NULL, NULL)`,
  `CREATE TABLE IF NOT EXISTS ingestion_expectation (
    run_id TEXT NOT NULL REFERENCES ingestion_run(id),
    session_date TEXT NOT NULL,
    fund_id TEXT NOT NULL REFERENCES fund(id),
    PRIMARY KEY (run_id, session_date, fund_id)
  )`,
  `CREATE INDEX IF NOT EXISTS ingestion_expectation_session_idx
    ON ingestion_expectation(session_date)`,
  `CREATE TABLE IF NOT EXISTS reference_session (
    session_date TEXT PRIMARY KEY,
    first_observed_at TEXT NOT NULL,
    source TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS daily_record_session_idx
    ON daily_record(session_date)`,
  `CREATE INDEX IF NOT EXISTS daily_record_status_idx
    ON daily_record(status)`,
  `CREATE INDEX IF NOT EXISTS record_event_lookup_idx
    ON record_event(fund_id, session_date)`,
  `CREATE TRIGGER IF NOT EXISTS fund_dates_valid_insert
    BEFORE INSERT ON fund
    WHEN (NEW.inception_date IS NOT NULL AND (
      length(NEW.inception_date) <> 10 OR date(NEW.inception_date) IS NOT NEW.inception_date
    )) OR (NEW.delisted_date IS NOT NULL AND (
      length(NEW.delisted_date) <> 10 OR date(NEW.delisted_date) IS NOT NEW.delisted_date
    )) OR (
      NEW.inception_date IS NOT NULL AND NEW.delisted_date IS NOT NULL
      AND NEW.delisted_date < NEW.inception_date
    )
    BEGIN SELECT RAISE(ABORT, 'invalid_fund_lifecycle_date'); END`,
  `CREATE TRIGGER IF NOT EXISTS fund_dates_valid_update
    BEFORE UPDATE OF inception_date, delisted_date ON fund
    WHEN (NEW.inception_date IS NOT NULL AND (
      length(NEW.inception_date) <> 10 OR date(NEW.inception_date) IS NOT NEW.inception_date
    )) OR (NEW.delisted_date IS NOT NULL AND (
      length(NEW.delisted_date) <> 10 OR date(NEW.delisted_date) IS NOT NEW.delisted_date
    )) OR (
      NEW.inception_date IS NOT NULL AND NEW.delisted_date IS NOT NULL
      AND NEW.delisted_date < NEW.inception_date
    )
    BEGIN SELECT RAISE(ABORT, 'invalid_fund_lifecycle_date'); END`,
  `CREATE TRIGGER IF NOT EXISTS fund_ticker_dates_valid_insert
    BEFORE INSERT ON fund_ticker
    WHEN length(NEW.valid_from) <> 10 OR date(NEW.valid_from) IS NOT NEW.valid_from
      OR (NEW.valid_to IS NOT NULL AND (
        length(NEW.valid_to) <> 10 OR date(NEW.valid_to) IS NOT NEW.valid_to
      ))
    BEGIN SELECT RAISE(ABORT, 'invalid_ticker_validity_date'); END`,
  `CREATE TRIGGER IF NOT EXISTS fund_ticker_dates_valid_update
    BEFORE UPDATE OF valid_from, valid_to ON fund_ticker
    WHEN length(NEW.valid_from) <> 10 OR date(NEW.valid_from) IS NOT NEW.valid_from
      OR (NEW.valid_to IS NOT NULL AND (
        length(NEW.valid_to) <> 10 OR date(NEW.valid_to) IS NOT NEW.valid_to
      ))
    BEGIN SELECT RAISE(ABORT, 'invalid_ticker_validity_date'); END`,
  `CREATE TRIGGER IF NOT EXISTS daily_record_date_valid_insert
    BEFORE INSERT ON daily_record
    WHEN length(NEW.session_date) <> 10 OR date(NEW.session_date) IS NOT NEW.session_date
    BEGIN SELECT RAISE(ABORT, 'invalid_session_date'); END`,
  `CREATE TRIGGER IF NOT EXISTS daily_record_date_valid_update
    BEFORE UPDATE OF session_date ON daily_record
    WHEN length(NEW.session_date) <> 10 OR date(NEW.session_date) IS NOT NEW.session_date
    BEGIN SELECT RAISE(ABORT, 'invalid_session_date'); END`,
  `CREATE TRIGGER IF NOT EXISTS record_event_date_valid_insert
    BEFORE INSERT ON record_event
    WHEN length(NEW.session_date) <> 10 OR date(NEW.session_date) IS NOT NEW.session_date
    BEGIN SELECT RAISE(ABORT, 'invalid_session_date'); END`,
  `CREATE TRIGGER IF NOT EXISTS ingestion_run_date_valid_insert
    BEFORE INSERT ON ingestion_run
    WHEN NEW.latest_session IS NOT NULL AND (
      length(NEW.latest_session) <> 10 OR date(NEW.latest_session) IS NOT NEW.latest_session
    )
    BEGIN SELECT RAISE(ABORT, 'invalid_latest_session'); END`,
  `CREATE TRIGGER IF NOT EXISTS ingestion_run_date_valid_update
    BEFORE UPDATE OF latest_session ON ingestion_run
    WHEN NEW.latest_session IS NOT NULL AND (
      length(NEW.latest_session) <> 10 OR date(NEW.latest_session) IS NOT NEW.latest_session
    )
    BEGIN SELECT RAISE(ABORT, 'invalid_latest_session'); END`,
  `CREATE TRIGGER IF NOT EXISTS ingestion_expectation_date_valid_insert
    BEFORE INSERT ON ingestion_expectation
    WHEN length(NEW.session_date) <> 10 OR date(NEW.session_date) IS NOT NEW.session_date
    BEGIN SELECT RAISE(ABORT, 'invalid_session_date'); END`,
  `CREATE TRIGGER IF NOT EXISTS reference_session_date_valid_insert
    BEFORE INSERT ON reference_session
    WHEN length(NEW.session_date) <> 10 OR date(NEW.session_date) IS NOT NEW.session_date
    BEGIN SELECT RAISE(ABORT, 'invalid_session_date'); END`,
  `CREATE TRIGGER IF NOT EXISTS record_event_validate_insert
    BEFORE INSERT ON record_event
    BEGIN
      SELECT CASE
        WHEN NEW.from_version = 0 AND EXISTS (
          SELECT 1 FROM daily_record
          WHERE fund_id = NEW.fund_id AND session_date = NEW.session_date
        ) THEN RAISE(ABORT, 'version_conflict')
        WHEN NEW.from_version > 0 AND NOT EXISTS (
          SELECT 1 FROM daily_record
          WHERE fund_id = NEW.fund_id
            AND session_date = NEW.session_date
            AND version = NEW.from_version
        ) THEN RAISE(ABORT, 'version_conflict')
      END;
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM json_each(NEW.changes)
        WHERE key NOT IN ('status', 'price', 'volume', 'source')
      ) THEN RAISE(ABORT, 'unknown_change_field') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM json_each(NEW.changes)
      ) THEN RAISE(ABORT, 'empty_change_set') END;
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM json_each(NEW.changes)
        WHERE json_type(value) <> 'object'
      ) THEN RAISE(ABORT, 'invalid_change_shape') END;
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM json_each(NEW.changes) field
        WHERE json_type(field.value, '$.old') IS NULL
          OR json_type(field.value, '$.new') IS NULL
          OR (SELECT COUNT(*) FROM json_each(field.value)) <> 2
          OR EXISTS (
            SELECT 1 FROM json_each(field.value)
            WHERE key NOT IN ('old', 'new')
          )
      ) THEN RAISE(ABORT, 'invalid_change_members') END;
      SELECT CASE WHEN
        (
          json_type(NEW.changes, '$.status') IS NOT NULL AND
          (
            json_type(NEW.changes, '$.status.old') NOT IN ('text', 'null') OR
            json_type(NEW.changes, '$.status.new') <> 'text'
          )
        ) OR
        (
          json_type(NEW.changes, '$.price') IS NOT NULL AND
          (
            json_type(NEW.changes, '$.price.old') NOT IN ('text', 'null') OR
            json_type(NEW.changes, '$.price.new') NOT IN ('text', 'null')
          )
        ) OR
        (
          json_type(NEW.changes, '$.volume') IS NOT NULL AND
          (
            json_type(NEW.changes, '$.volume.old') NOT IN ('text', 'null') OR
            json_type(NEW.changes, '$.volume.new') NOT IN ('text', 'null')
          )
        ) OR
        (
          json_type(NEW.changes, '$.source') IS NOT NULL AND
          (
            json_type(NEW.changes, '$.source.old') NOT IN ('text', 'null') OR
            json_type(NEW.changes, '$.source.new') <> 'text' OR
            json_extract(NEW.changes, '$.source.new') = ''
          )
        )
      THEN RAISE(ABORT, 'invalid_change_value_type') END;
      SELECT CASE WHEN NEW.from_version > 0 AND EXISTS (
        SELECT 1 FROM json_each(NEW.changes)
        WHERE json_extract(value, '$.old') IS json_extract(value, '$.new')
      ) THEN RAISE(ABORT, 'no_op_change') END;
      SELECT CASE
        WHEN NEW.from_version = 0 AND (
          json_type(NEW.changes, '$.status') IS NULL OR
          json_type(NEW.changes, '$.price') IS NULL OR
          json_type(NEW.changes, '$.volume') IS NULL OR
          json_type(NEW.changes, '$.source') IS NULL OR
          json_type(NEW.changes, '$.status.old') <> 'null' OR
          json_type(NEW.changes, '$.price.old') <> 'null' OR
          json_type(NEW.changes, '$.volume.old') <> 'null' OR
          json_type(NEW.changes, '$.source.old') <> 'null'
        ) THEN RAISE(ABORT, 'invalid_creation_receipt')
      END;
      SELECT CASE
        WHEN NEW.from_version > 0 AND (
          (
            json_type(NEW.changes, '$.status') IS NOT NULL AND
            json_extract(NEW.changes, '$.status.old') IS NOT (
              SELECT status FROM daily_record
              WHERE fund_id = NEW.fund_id AND session_date = NEW.session_date
            )
          ) OR
          (
            json_type(NEW.changes, '$.price') IS NOT NULL AND
            json_extract(NEW.changes, '$.price.old') IS NOT (
              SELECT price FROM daily_record
              WHERE fund_id = NEW.fund_id AND session_date = NEW.session_date
            )
          ) OR
          (
            json_type(NEW.changes, '$.volume') IS NOT NULL AND
            json_extract(NEW.changes, '$.volume.old') IS NOT (
              SELECT volume FROM daily_record
              WHERE fund_id = NEW.fund_id AND session_date = NEW.session_date
            )
          ) OR
          (
            json_type(NEW.changes, '$.source') IS NOT NULL AND
            json_extract(NEW.changes, '$.source.old') IS NOT (
              SELECT source FROM daily_record
              WHERE fund_id = NEW.fund_id AND session_date = NEW.session_date
            )
          )
        ) THEN RAISE(ABORT, 'event_old_value_mismatch')
      END;
      SELECT CASE WHEN NEW.from_version > 0 AND NEW.detected_at < (
        SELECT updated_at FROM daily_record
        WHERE fund_id = NEW.fund_id AND session_date = NEW.session_date
      ) THEN RAISE(ABORT, 'stale_event') END;
      SELECT CASE WHEN NEW.source = '' OR NEW.source IS NOT (
        CASE
          WHEN json_type(NEW.changes, '$.source') IS NOT NULL
          THEN json_extract(NEW.changes, '$.source.new')
          ELSE (
            SELECT source FROM daily_record
            WHERE fund_id = NEW.fund_id AND session_date = NEW.session_date
          )
        END
      ) THEN RAISE(ABORT, 'event_source_mismatch') END;
    END`,
  `CREATE TRIGGER IF NOT EXISTS record_event_apply_create
    AFTER INSERT ON record_event
    WHEN NEW.from_version = 0
    BEGIN
      INSERT INTO daily_record (
        fund_id, session_date, status, price, volume, source, version, updated_at
      ) VALUES (
        NEW.fund_id,
        NEW.session_date,
        json_extract(NEW.changes, '$.status.new'),
        json_extract(NEW.changes, '$.price.new'),
        json_extract(NEW.changes, '$.volume.new'),
        NEW.source,
        NEW.to_version,
        NEW.detected_at
      );
    END`,
  `CREATE TRIGGER IF NOT EXISTS record_event_apply_revision
    AFTER INSERT ON record_event
    WHEN NEW.from_version > 0
    BEGIN
      UPDATE daily_record SET
        status = CASE
          WHEN json_type(NEW.changes, '$.status') IS NOT NULL
          THEN json_extract(NEW.changes, '$.status.new') ELSE status END,
        price = CASE
          WHEN json_type(NEW.changes, '$.price') IS NOT NULL
          THEN json_extract(NEW.changes, '$.price.new') ELSE price END,
        volume = CASE
          WHEN json_type(NEW.changes, '$.volume') IS NOT NULL
          THEN json_extract(NEW.changes, '$.volume.new') ELSE volume END,
        source = CASE
          WHEN json_type(NEW.changes, '$.source') IS NOT NULL
          THEN json_extract(NEW.changes, '$.source.new') ELSE source END,
        version = NEW.to_version,
        updated_at = NEW.detected_at
      WHERE fund_id = NEW.fund_id
        AND session_date = NEW.session_date
        AND version = NEW.from_version;
    END`,
  `CREATE TRIGGER IF NOT EXISTS daily_record_no_direct_insert
    BEFORE INSERT ON daily_record
    WHEN NOT EXISTS (
      SELECT 1 FROM record_event
      WHERE fund_id = NEW.fund_id
        AND session_date = NEW.session_date
        AND from_version = 0
        AND to_version = NEW.version
        AND detected_at = NEW.updated_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'daily_record_event_required');
    END`,
  `CREATE TRIGGER IF NOT EXISTS daily_record_no_direct_update
    BEFORE UPDATE ON daily_record
    WHEN NOT EXISTS (
      SELECT 1 FROM record_event
      WHERE fund_id = NEW.fund_id
        AND session_date = NEW.session_date
        AND from_version = OLD.version
        AND to_version = NEW.version
        AND detected_at = NEW.updated_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'daily_record_event_required');
    END`,
  `CREATE TRIGGER IF NOT EXISTS daily_record_no_direct_delete
    BEFORE DELETE ON daily_record
    BEGIN
      SELECT RAISE(ABORT, 'daily_record_event_required');
    END`,
  `CREATE TRIGGER IF NOT EXISTS record_event_no_update
    BEFORE UPDATE ON record_event
    BEGIN
      SELECT RAISE(ABORT, 'record_event_is_append_only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS record_event_no_delete
    BEFORE DELETE ON record_event
    BEGIN
      SELECT RAISE(ABORT, 'record_event_is_append_only');
    END`,
];

const integrityTriggerStatements = schemaStatements.filter((statement) =>
  /^CREATE TRIGGER IF NOT EXISTS /m.test(statement),
);

export const INTEGRITY_TRIGGER_NAMES = integrityTriggerStatements.map((statement) => {
  const name = /^CREATE TRIGGER IF NOT EXISTS ([a-z_]+)/m.exec(statement)?.[1];
  if (!name) throw new Error("Integrity trigger is missing a stable name.");
  return name;
});

function normalizeTriggerDefinition(sql: string): string {
  return sql
    .replace(/IF\s+NOT\s+EXISTS/gi, "")
    .replace(/[`"\s]/g, "")
    .replace(/;$/, "")
    .toLowerCase();
}

const expectedTriggerDefinitions = new Map(
  integrityTriggerStatements.map((statement, index) => [
    INTEGRITY_TRIGGER_NAMES[index],
    normalizeTriggerDefinition(statement),
  ]),
);

async function hasCompleteIntegrityBundle(db: D1Database): Promise<boolean> {
  const placeholders = INTEGRITY_TRIGGER_NAMES.map(() => "?").join(", ");
  const installed = await db.prepare(
    `SELECT name, sql FROM sqlite_master
     WHERE type = 'trigger' AND name IN (${placeholders})`,
  ).bind(...INTEGRITY_TRIGGER_NAMES).all<{ name: string; sql: string | null }>();
  if (installed.results.length !== INTEGRITY_TRIGGER_NAMES.length) return false;
  return installed.results.every((trigger) =>
    trigger.sql !== null &&
    expectedTriggerDefinitions.get(trigger.name) === normalizeTriggerDefinition(trigger.sql),
  );
}

export async function ensureSchema(db: D1Database): Promise<void> {
  if (await hasCompleteIntegrityBundle(db)) {
    await db.prepare(
      `INSERT OR IGNORE INTO ingestion_lease
       (id, run_id, acquired_at, released_at) VALUES (1, NULL, NULL, NULL)`,
    ).run();
    return;
  }
  const dropTriggers = INTEGRITY_TRIGGER_NAMES.map(
    (name) => `DROP TRIGGER IF EXISTS ${name}`,
  );
  await db.batch(
    [...dropTriggers, ...schemaStatements].map((sql) => db.prepare(sql)),
  );
  if (!(await hasCompleteIntegrityBundle(db))) {
    throw new Error("Integrity trigger bootstrap did not install the complete expected bundle.");
  }
}

export async function getTrackedFunds(db: D1Database): Promise<TrackedFund[]> {
  const result = await db
    .prepare(
      `SELECT
        f.id AS fundId,
        ft.ticker AS ticker,
        ft.valid_from AS validFrom,
        ft.valid_to AS validTo,
        f.name AS name,
        f.inception_date AS inceptionDate,
        f.delisted_date AS delistedDate
      FROM watchlist w
      JOIN fund f ON f.id = w.fund_id
      LEFT JOIN fund_ticker ft ON ft.fund_id = f.id
      WHERE w.active = 1
      ORDER BY f.id, ft.valid_from`,
    )
    .all<{
      fundId: string;
      ticker: string | null;
      validFrom: string | null;
      validTo: string | null;
      name: string;
      inceptionDate: string | null;
      delistedDate: string | null;
    }>();
  const funds = new Map<string, TrackedFund>();
  for (const row of result.results) {
    const fund = funds.get(row.fundId) ?? {
      fundId: row.fundId,
      name: row.name,
      inceptionDate: row.inceptionDate,
      delistedDate: row.delistedDate,
      tickers: [],
    };
    if (row.ticker && row.validFrom) {
      fund.tickers.push({
        ticker: row.ticker,
        validFrom: row.validFrom,
        validTo: row.validTo,
      });
    }
    funds.set(row.fundId, fund);
  }
  return [...funds.values()];
}

export async function getDailyRecord(
  db: D1Database,
  fundId: string,
  sessionDate: string,
): Promise<DailyRecord | null> {
  return db
    .prepare(
      `SELECT
        fund_id AS fundId,
        session_date AS sessionDate,
        status,
        price,
        volume,
        source,
        version,
        updated_at AS updatedAt
      FROM daily_record
      WHERE fund_id = ? AND session_date = ?`,
    )
    .bind(fundId, sessionDate)
    .first<DailyRecord>();
}

export async function applyObservation(
  db: D1Database,
  candidate: CandidateObservation,
  detectedAt: string,
): Promise<"created" | "revised" | "unchanged"> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await getDailyRecord(db, candidate.fundId, candidate.sessionDate);
    if (current && current.updatedAt > detectedAt) return "unchanged";
    const transition = createTransition(current, candidate, detectedAt);
    if (!transition) return "unchanged";

    const { event } = transition;
    try {
      await db
        .prepare(
          `INSERT INTO record_event (
            id, fund_id, session_date, from_version, to_version,
            event_type, changes, source, detected_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          event.id,
          event.fundId,
          event.sessionDate,
          event.fromVersion,
          event.toVersion,
          event.eventType,
          JSON.stringify(event.changes),
          event.source,
          event.detectedAt,
        )
        .run();
      return event.eventType;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("version_conflict") || attempt === 2) throw error;
    }
  }
  throw new Error("Unreachable compare-and-swap state.");
}

export async function seedWatchlist(db: D1Database): Promise<void> {
  const now = new Date().toISOString();
  const seeds = [
    ["fund_spy", "SPDR S&P 500 ETF Trust", "ETF", "SPY"],
    ["fund_qqq", "Invesco QQQ Trust", "ETF", "QQQ"],
    ["fund_bnd", "Vanguard Total Bond Market ETF", "ETF", "BND"],
    ["fund_usa", "Liberty All-Star Equity Fund", "CEF", "USA"],
  ];

  for (const [id, name, type, ticker] of seeds) {
    await db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO fund
            (id, name, exchange, currency, instrument_type, created_at)
           VALUES (?, ?, 'US', 'USD', ?, ?)`,
        )
        .bind(id, name, type, now),
      db
        .prepare(
          `INSERT INTO fund_ticker (fund_id, ticker, valid_from, valid_to)
           SELECT ?, ?, '1900-01-01', NULL
           WHERE NOT EXISTS (
             SELECT 1 FROM fund_ticker
             WHERE fund_id = ? AND ticker = ? AND valid_from = '1900-01-01'
           )`,
        )
        .bind(id, ticker, id, ticker),
      db
        .prepare(
          `INSERT OR IGNORE INTO watchlist (fund_id, active, added_at)
           VALUES (?, 1, ?)`,
        )
        .bind(id, now),
    ]);
  }
}
