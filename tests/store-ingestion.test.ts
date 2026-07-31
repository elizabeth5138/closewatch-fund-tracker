import assert from "node:assert/strict";
import test from "node:test";
import {
  IngestionBusyError,
  recordFailedIngestionRun,
  runDailyIngestion,
} from "../lib/ingestion.ts";
import type { PriceProvider, ProviderBar } from "../lib/provider.ts";
import {
  applyObservation,
  getDailyRecord,
  INTEGRITY_TRIGGER_NAMES,
  seedWatchlist,
} from "../lib/store.ts";
import { makeTestDb as makeDb } from "./d1.ts";

class FixtureProvider implements PriceProvider {
  readonly source = "fixture_provider";
  series: Record<string, ProviderBar[]>;
  constructor(series: Record<string, ProviderBar[]>) {
    this.series = series;
  }
  async dailySeries(ticker: string) {
    const result = this.series[ticker];
    if (!result) throw new Error(`No fixture for ${ticker}`);
    return structuredClone(result);
  }
}

const priced = (sessionDate: string, close: string, volume = "100"): ProviderBar => ({
  sessionDate,
  close,
  volume,
});

test("schema triggers make event creation atomic and append-only", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  await seedWatchlist(db);

  const candidate = {
    fundId: "fund_spy",
    sessionDate: "2026-07-29",
    status: "priced" as const,
    price: "100.12",
    volume: "200",
    source: "fixture_provider",
  };
  assert.equal(
    await applyObservation(db, candidate, "2026-07-30T10:00:00Z"),
    "created",
  );
  assert.equal(
    await applyObservation(
      db,
      { ...candidate, price: "100.1200000" },
      "2026-07-30T11:00:00Z",
    ),
    "unchanged",
  );
  assert.equal(
    await applyObservation(
      db,
      { ...candidate, price: "100.13", volume: "205" },
      "2026-07-30T12:00:00Z",
    ),
    "revised",
  );

  const current = await getDailyRecord(db, "fund_spy", "2026-07-29");
  assert.equal(current?.version, 2);
  assert.equal(current?.price, "100.130000");
  assert.equal(current?.volume, "205");

  const events = await db
    .prepare(
      `SELECT from_version AS fromVersion, to_version AS toVersion
       FROM record_event
       WHERE fund_id = ? AND session_date = ?
       ORDER BY to_version`,
    )
    .bind("fund_spy", "2026-07-29")
    .all<{ fromVersion: number; toVersion: number }>();
  assert.deepEqual(events.results, [
    { fromVersion: 0, toVersion: 1 },
    { fromVersion: 1, toVersion: 2 },
  ]);
  assert.equal(current?.version, events.results.length);

  await assert.rejects(
    () =>
      db
        .prepare("UPDATE record_event SET source = 'tampered' WHERE fund_id = ?")
        .bind("fund_spy")
        .run(),
    /append_only/,
  );
  await assert.rejects(
    () =>
      db
        .prepare("DELETE FROM record_event WHERE fund_id = ?")
        .bind("fund_spy")
        .run(),
    /append_only/,
  );
  await assert.rejects(
    () =>
      db
        .prepare(
          `UPDATE daily_record SET price = '999.000000'
           WHERE fund_id = ? AND session_date = ?`,
        )
        .bind("fund_spy", "2026-07-29")
        .run(),
    /event_required/,
  );
  await assert.rejects(
    () =>
      db
        .prepare(
          `DELETE FROM daily_record WHERE fund_id = ? AND session_date = ?`,
        )
        .bind("fund_spy", "2026-07-29")
        .run(),
    /event_required/,
  );

  const lyingChanges = JSON.stringify({
    price: { old: "999.000000", new: "100.140000" },
  });
  await assert.rejects(
    () =>
      db
        .prepare(
          `INSERT INTO record_event (
            id, fund_id, session_date, from_version, to_version,
            event_type, changes, source, detected_at
          ) VALUES (?, ?, ?, 2, 3, 'revised', ?, ?, ?)`,
        )
        .bind(
          "lying-event",
          "fund_spy",
          "2026-07-29",
          lyingChanges,
          "fixture_provider",
          "2026-07-30T13:00:00Z",
        )
        .run(),
    /old_value_mismatch/,
  );

  const numericPriceChanges = JSON.stringify({
    status: { old: null, new: "priced" },
    price: { old: null, new: 100.12 },
    volume: { old: null, new: "10" },
    source: { old: null, new: "fixture_provider" },
  });
  await assert.rejects(
    () =>
      db
        .prepare(
          `INSERT INTO record_event (
            id, fund_id, session_date, from_version, to_version,
            event_type, changes, source, detected_at
          ) VALUES (?, ?, ?, 0, 1, 'created', ?, ?, ?)`,
        )
        .bind(
          "numeric-price-event",
          "fund_spy",
          "2026-07-28",
          numericPriceChanges,
          "fixture_provider",
          "2026-07-30T13:00:00Z",
        )
        .run(),
    /constraint/i,
  );
  assert.equal(
    await getDailyRecord(db, "fund_spy", "2026-07-28"),
    null,
  );

  const numericVolumeChanges = JSON.stringify({
    status: { old: null, new: "priced" },
    price: { old: null, new: "100.120000" },
    volume: { old: null, new: 10 },
    source: { old: null, new: "fixture_provider" },
  });
  await assert.rejects(
    () =>
      db.prepare(
        `INSERT INTO record_event (
          id, fund_id, session_date, from_version, to_version,
          event_type, changes, source, detected_at
        ) VALUES (?, ?, ?, 0, 1, 'created', ?, ?, ?)`,
      ).bind(
        "numeric-volume-event",
        "fund_spy",
        "2026-07-27",
        numericVolumeChanges,
        "fixture_provider",
        "2026-07-30T13:00:00Z",
      ).run(),
    /invalid_change_value_type/,
  );

  const mismatchedSourceChanges = JSON.stringify({
    status: { old: null, new: "priced" },
    price: { old: null, new: "100.120000" },
    volume: { old: null, new: "10" },
    source: { old: null, new: "fixture_provider" },
  });
  await assert.rejects(
    () =>
      db.prepare(
        `INSERT INTO record_event (
          id, fund_id, session_date, from_version, to_version,
          event_type, changes, source, detected_at
        ) VALUES (?, ?, ?, 0, 1, 'created', ?, ?, ?)`,
      ).bind(
        "mismatched-source-event",
        "fund_spy",
        "2026-07-26",
        mismatchedSourceChanges,
        "different_provider",
        "2026-07-30T13:00:00Z",
      ).run(),
    /event_source_mismatch/,
  );

  const missingMemberChanges = JSON.stringify({
    status: { old: null, new: "pending" },
    price: { old: null },
    volume: { old: null, new: null },
    source: { old: null, new: "fixture_provider" },
  });
  await assert.rejects(
    () => db.prepare(
      `INSERT INTO record_event (
        id, fund_id, session_date, from_version, to_version,
        event_type, changes, source, detected_at
      ) VALUES (?, ?, ?, 0, 1, 'created', ?, ?, ?)`,
    ).bind(
      "missing-member-event",
      "fund_spy",
      "2026-07-25",
      missingMemberChanges,
      "fixture_provider",
      "2026-07-30T13:00:00Z",
    ).run(),
    /invalid_change_members/,
  );

  const noOpChanges = JSON.stringify({
    price: { old: "100.130000", new: "100.130000" },
  });
  await assert.rejects(
    () => db.prepare(
      `INSERT INTO record_event (
        id, fund_id, session_date, from_version, to_version,
        event_type, changes, source, detected_at
      ) VALUES (?, ?, ?, 2, 3, 'revised', ?, ?, ?)`,
    ).bind(
      "no-op-event",
      "fund_spy",
      "2026-07-29",
      noOpChanges,
      "fixture_provider",
      "2026-07-30T13:00:00Z",
    ).run(),
    /no_op_change/,
  );

  const staleChanges = JSON.stringify({
    price: { old: "100.130000", new: "100.140000" },
  });
  await assert.rejects(
    () => db.prepare(
      `INSERT INTO record_event (
        id, fund_id, session_date, from_version, to_version,
        event_type, changes, source, detected_at
      ) VALUES (?, ?, ?, 2, 3, 'revised', ?, ?, ?)`,
    ).bind(
      "stale-event",
      "fund_spy",
      "2026-07-29",
      staleChanges,
      "fixture_provider",
      "2026-07-30T11:30:00Z",
    ).run(),
    /stale_event/,
  );

  const leadingZeroChanges = JSON.stringify({
    status: { old: null, new: "priced" },
    price: { old: null, new: "001.000000" },
    volume: { old: null, new: "00042" },
    source: { old: null, new: "fixture_provider" },
  });
  await assert.rejects(
    () => db.prepare(
      `INSERT INTO record_event (
        id, fund_id, session_date, from_version, to_version,
        event_type, changes, source, detected_at
      ) VALUES (?, ?, ?, 0, 1, 'created', ?, ?, ?)`,
    ).bind(
      "leading-zero-event",
      "fund_spy",
      "2026-07-24",
      leadingZeroChanges,
      "fixture_provider",
      "2026-07-30T13:00:00Z",
    ).run(),
    /constraint/i,
  );
});

test("the pre-write schema bootstrap installs the protected event ledger", async (t) => {
  const { mf, db } = await makeDb({ bootstrap: false });
  t.after(() => mf.dispose());
  const session = "2026-07-29";
  const provider = new FixtureProvider(Object.fromEntries(
    ["SPY", "QQQ", "BND", "USA"].map((ticker) => [ticker, [priced(session, "100")]]),
  ));
  await runDailyIngestion(db, provider, new Date("2026-07-30T11:00:00Z"));
  const installed = await db.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger'",
  ).first<{ count: number }>();
  assert.equal(installed?.count, INTEGRITY_TRIGGER_NAMES.length);
  await assert.rejects(
    () =>
      db
        .prepare(
          `UPDATE daily_record SET price = '999.000000'
           WHERE fund_id = 'fund_spy' AND session_date = '2026-07-29'`,
        )
        .run(),
    /event_required/,
  );
});

test("the failed-run path replaces a stale sentinel-only trigger bundle", async (t) => {
  const { mf, db } = await makeDb({ bootstrap: false });
  t.after(() => mf.dispose());
  await db.prepare(
    `CREATE TRIGGER record_event_no_delete
     BEFORE DELETE ON record_event BEGIN SELECT 1; END`,
  ).run();
  await recordFailedIngestionRun(
    db,
    "configuration",
    "provider key absent",
    new Date("2026-07-30T11:00:00Z"),
  );
  const installed = await db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger'",
  ).all<{ name: string; sql: string }>();
  assert.equal(installed.results.length, INTEGRITY_TRIGGER_NAMES.length);
  const sentinel = installed.results.find(
    (trigger) => trigger.name === "record_event_no_delete",
  );
  assert.match(sentinel?.sql ?? "", /record_event_is_append_only/);
});

test("the failed-run path repairs a missing integrity trigger", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  await db.prepare("DROP TRIGGER daily_record_no_direct_update").run();
  await recordFailedIngestionRun(
    db,
    "configuration",
    "provider key absent",
    new Date("2026-07-30T11:00:00Z"),
  );
  const repaired = await db.prepare(
    `SELECT sql FROM sqlite_master
     WHERE type = 'trigger' AND name = 'daily_record_no_direct_update'`,
  ).first<{ sql: string }>();
  assert.match(repaired?.sql ?? "", /daily_record_event_required/);
});

test("daily ingestion is idempotent, revisable, and reference-session driven", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  const session = "2026-07-29";
  const provider = new FixtureProvider({
    SPY: [priced(session, "100.00")],
    QQQ: [priced(session, "200.00")],
    BND: [priced(session, "75.00")],
    USA: [
      priced(session, "7.00", "0"),
      priced("2026-07-28", "7.00", "50"),
    ],
  });

  const first = await runDailyIngestion(
    db,
    provider,
    new Date("2026-07-30T11:00:00Z"),
  );
  assert.deepEqual(
    {
      sessionDate: first.sessionDate,
      expected: first.expected,
      created: first.created,
      revised: first.revised,
      unchanged: first.unchanged,
      failed: first.failed,
    },
    {
      sessionDate: session,
      expected: 4,
      created: 4,
      revised: 0,
      unchanged: 0,
      failed: [],
    },
  );
  assert.equal(
    (await getDailyRecord(db, "fund_usa", session))?.status,
    "no_trade",
  );

  const replay = await runDailyIngestion(
    db,
    provider,
    new Date("2026-07-30T12:00:00Z"),
  );
  assert.equal(replay.unchanged, 4);
  assert.equal(replay.created, 0);
  assert.equal(replay.revised, 0);

  provider.series.QQQ[0].close = "201.250000";
  const revision = await runDailyIngestion(
    db,
    provider,
    new Date("2026-07-30T13:00:00Z"),
  );
  assert.equal(revision.revised, 1);
  assert.equal(revision.unchanged, 3);
  assert.equal((await getDailyRecord(db, "fund_qqq", session))?.version, 2);
});

test("absence progresses pending to missing and a later backfill to priced", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  const session = "2026-07-29";
  const provider = new FixtureProvider({
    SPY: [priced(session, "100.00")],
    QQQ: [],
    BND: [priced(session, "75.00")],
    USA: [priced(session, "7.00")],
  });

  await runDailyIngestion(db, provider, new Date("2026-07-30T09:00:00Z"));
  assert.equal((await getDailyRecord(db, "fund_qqq", session))?.status, "pending");

  await runDailyIngestion(db, provider, new Date("2026-07-30T10:00:00Z"));
  assert.equal((await getDailyRecord(db, "fund_qqq", session))?.status, "missing");

  provider.series.QQQ = [priced(session, "200.00")];
  await runDailyIngestion(db, provider, new Date("2026-07-31T10:00:00Z"));
  const backfilled = await getDailyRecord(db, "fund_qqq", session);
  assert.equal(backfilled?.status, "priced");
  assert.equal(backfilled?.version, 3);

  const count = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM record_event
       WHERE fund_id = 'fund_qqq' AND session_date = ?`,
    )
    .bind(session)
    .first<{ count: number }>();
  assert.equal(count?.count, 3);
});

test("reference-provider failure does not invent a non-session", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  const provider: PriceProvider = {
    source: "broken",
    async dailySeries() {
      throw new Error("provider unavailable");
    },
  };
  await assert.rejects(
    () =>
      runDailyIngestion(db, provider, new Date("2026-07-30T11:00:00Z")),
    /provider unavailable/,
  );
  const records = await db
    .prepare("SELECT COUNT(*) AS count FROM daily_record")
    .first<{ count: number }>();
  assert.equal(records?.count, 0);

  const run = await db
    .prepare(
      `SELECT status, failure_count AS failureCount
       FROM ingestion_run ORDER BY started_at DESC LIMIT 1`,
    )
    .first<{ status: string; failureCount: number }>();
  assert.deepEqual(run, { status: "failed", failureCount: 1 });
});

test("the production-depth contract rejects a partial initial reference series", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  const provider: PriceProvider = {
    source: "depth_checked_fixture",
    minimumHistoryDepth: 7,
    async dailySeries() {
      return [priced("2026-07-29", "100")];
    },
  };
  await assert.rejects(
    () => runDailyIngestion(
      db,
      provider,
      new Date("2026-07-29T23:15:00Z"),
    ),
    /expected at least 7/,
  );
  const referenceRows = await db.prepare(
    "SELECT COUNT(*) AS count FROM reference_session",
  ).first<{ count: number }>();
  assert.equal(referenceRows?.count, 0);
});

test("a fund-fetch failure still materializes the expected denominator", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  const session = "2026-07-29";
  const provider: PriceProvider = {
    source: "partial_fixture",
    async dailySeries(ticker: string) {
      if (ticker === "QQQ") throw new Error("ticker request failed");
      return [priced(session, ticker === "SPY" ? "100" : "50")];
    },
  };

  const result = await runDailyIngestion(
    db,
    provider,
    new Date("2026-07-30T11:00:00Z"),
  );
  assert.equal(result.expected, 4);
  assert.equal(result.created, 4);
  assert.ok(result.failed.some((failure) => failure.ticker === "QQQ"));
  assert.equal((await getDailyRecord(db, "fund_qqq", session))?.status, "missing");

  const fetchFailure = await db
    .prepare(
      `SELECT outcome, detail FROM fetch_attempt
       WHERE run_id = ? AND ticker = 'QQQ'`,
    )
    .bind(result.runId)
    .first<{ outcome: string; detail: string }>();
  assert.equal(fetchFailure?.outcome, "failed");
  assert.match(fetchFailure?.detail ?? "", /ticker request failed/);

  const run = await db
    .prepare(
      `SELECT status, expected_count AS expectedCount,
        resolved_count AS resolvedCount, failure_count AS failureCount
       FROM ingestion_run WHERE id = ?`,
    )
    .bind(result.runId)
    .first<{
      status: string;
      expectedCount: number;
      resolvedCount: number;
      failureCount: number;
    }>();
  assert.equal(run?.status, "partial");
  assert.equal(run?.expectedCount, 4);
  assert.equal(run?.resolvedCount, 4);
  assert.equal(run?.failureCount, 1);
});

test("transport failure or partial series never erases a resolved close", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  const firstSession = "2026-07-29";
  const provider = new FixtureProvider({
    SPY: [priced(firstSession, "100")],
    QQQ: [priced(firstSession, "200")],
    BND: [priced(firstSession, "75")],
    USA: [priced(firstSession, "7")],
  });
  await runDailyIngestion(
    db,
    provider,
    new Date("2026-07-29T23:15:00Z"),
  );
  const original = await getDailyRecord(db, "fund_qqq", firstSession);

  const transportFailure: PriceProvider = {
    source: "fixture_provider",
    async dailySeries(ticker: string) {
      if (ticker === "QQQ") throw new Error("temporary transport failure");
      return [
        priced("2026-07-30", "101"),
        priced(firstSession, "100"),
      ];
    },
  };
  await runDailyIngestion(
    db,
    transportFailure,
    new Date("2026-07-30T23:15:00Z"),
  );
  assert.deepEqual(
    await getDailyRecord(db, "fund_qqq", firstSession),
    original,
  );

  const partial = new FixtureProvider({
    SPY: [priced("2026-07-30", "101"), priced(firstSession, "100")],
    QQQ: [priced("2026-07-30", "201")],
    BND: [priced("2026-07-30", "76"), priced(firstSession, "75")],
    USA: [priced("2026-07-30", "8"), priced(firstSession, "7")],
  });
  const partialRun = await runDailyIngestion(
    db,
    partial,
    new Date("2026-07-31T00:15:00Z"),
  );
  assert.ok(partialRun.failed.some(
    (failure) => failure.reason.includes("omitted previously resolved session"),
  ));
  assert.deepEqual(
    await getDailyRecord(db, "fund_qqq", firstSession),
    original,
  );
});

test("older sessions remain eligible for bounded backfill after the reference advances", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  const sessions = ["2026-07-29", "2026-07-28", "2026-07-27"];
  const provider = new FixtureProvider({
    SPY: sessions.map((date, index) => priced(date, String(100 - index))),
    QQQ: [priced("2026-07-29", "200"), priced("2026-07-27", "198")],
    BND: sessions.map((date) => priced(date, "75")),
    USA: sessions.map((date) => priced(date, "7")),
  });
  await runDailyIngestion(db, provider, new Date("2026-07-30T11:00:00Z"));
  assert.equal(
    (await getDailyRecord(db, "fund_qqq", "2026-07-28"))?.status,
    "missing",
  );

  provider.series.SPY.unshift(priced("2026-07-30", "101"));
  provider.series.QQQ.unshift(
    priced("2026-07-30", "202"),
    priced("2026-07-28", "199"),
  );
  provider.series.BND.unshift(priced("2026-07-30", "75.1"));
  provider.series.USA.unshift(priced("2026-07-30", "7.1"));

  const nextRun = await runDailyIngestion(
    db,
    provider,
    new Date("2026-07-31T11:00:00Z"),
  );
  assert.ok(nextRun.reconciledSessions.includes("2026-07-28"));
  const backfilled = await getDailyRecord(db, "fund_qqq", "2026-07-28");
  assert.equal(backfilled?.status, "priced");
  assert.equal(backfilled?.price, "199.000000");
  assert.equal(backfilled?.version, 2);
});

test("zero volume is no_trade only when the close is unchanged", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  const session = "2026-07-29";
  const prior = "2026-07-28";
  const provider = new FixtureProvider({
    SPY: [priced(session, "100")],
    QQQ: [priced(session, "201", "0"), priced(prior, "200", "10")],
    BND: [priced(session, "75")],
    USA: [priced(session, "7")],
  });
  const result = await runDailyIngestion(
    db,
    provider,
    new Date("2026-07-30T11:00:00Z"),
  );
  assert.ok(
    result.failed.some(
      (failure) =>
        failure.ticker === "QQQ" && failure.reason.includes("changed close"),
    ),
  );
  const qqq = await getDailyRecord(db, "fund_qqq", session);
  assert.equal(qqq?.status, "missing");
  assert.equal(qqq?.price, null);
});

test("stale reference data is a persisted run failure", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  const provider = new FixtureProvider({
    SPY: [priced("2026-07-01", "100")],
  });
  await assert.rejects(
    () =>
      runDailyIngestion(db, provider, new Date("2026-07-30T11:00:00Z")),
    /stale/,
  );
  const run = await db
    .prepare(
      `SELECT status, latest_session AS latestSession, failure_count AS failureCount
       FROM ingestion_run ORDER BY started_at DESC LIMIT 1`,
    )
    .first<{ status: string; latestSession: string | null; failureCount: number }>();
  assert.equal(run?.status, "failed");
  assert.equal(run?.failureCount, 1);
});

test("a one-session-late reference feed cannot produce a false healthy run", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  const provider = new FixtureProvider({
    SPY: [priced("2026-07-24", "100")],
  });
  await assert.rejects(
    () =>
      runDailyIngestion(
        db,
        provider,
        new Date("2026-07-27T23:15:00Z"),
        "scheduled",
      ),
    /has not advanced.*possible market closure or provider delay/i,
  );
  const run = await db.prepare(
    `SELECT status, latest_session AS latestSession, failure_count AS failureCount
     FROM ingestion_run ORDER BY started_at DESC LIMIT 1`,
  ).first<{ status: string; latestSession: string | null; failureCount: number }>();
  assert.equal(run?.status, "failed");
  assert.equal(run?.latestSession, null);
  assert.equal(run?.failureCount, 1);
});

test("ticker identities cannot overlap or have two current assignments", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  await seedWatchlist(db);

  await assert.rejects(
    () =>
      db
        .prepare(
          `INSERT INTO fund_ticker (fund_id, ticker, valid_from, valid_to)
           VALUES ('fund_spy', 'SPY2', '2020-01-01', NULL)`,
        )
        .run(),
    /overlap|unique/i,
  );

  await db
    .prepare(
      `INSERT INTO fund
        (id, name, exchange, currency, instrument_type, created_at)
       VALUES ('other_fund', 'Other', 'US', 'USD', 'ETF', '2026-01-01')`,
    )
    .run();
  await assert.rejects(
    () =>
      db
        .prepare(
          `INSERT INTO fund_ticker (fund_id, ticker, valid_from, valid_to)
           VALUES ('other_fund', 'SPY', '2026-01-01', NULL)`,
        )
        .run(),
    /overlap|unique/i,
  );
});

test("active funds without ticker metadata stay in the expected denominator", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  await seedWatchlist(db);
  await db.prepare(
    `INSERT INTO fund
      (id, name, exchange, currency, instrument_type, created_at)
     VALUES ('fund_unassigned', 'Unassigned fund', 'US', 'USD', 'ETF', '2026-07-29')`,
  ).run();
  await db.prepare(
    `INSERT INTO watchlist (fund_id, active, added_at)
     VALUES ('fund_unassigned', 1, '2026-07-29')`,
  ).run();
  const result = await runDailyIngestion(
    db,
    new FixtureProvider({
      SPY: [priced("2026-07-29", "100")],
      QQQ: [priced("2026-07-29", "200")],
      BND: [priced("2026-07-29", "75")],
      USA: [priced("2026-07-29", "7")],
    }),
    new Date("2026-07-30T11:00:00Z"),
  );
  assert.equal(result.expected, 5);
  assert.ok(result.failed.some((failure) => failure.ticker === "fund_unassigned"));
  assert.equal(
    (await getDailyRecord(db, "fund_unassigned", "2026-07-29"))?.status,
    "missing",
  );
});

test("malformed identity and lifecycle dates are rejected at the database boundary", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  await seedWatchlist(db);
  await assert.rejects(
    () => db.prepare(
      "UPDATE fund SET inception_date = '2026-02-30' WHERE id = 'fund_spy'",
    ).run(),
    /invalid_fund_lifecycle_date/,
  );
  await assert.rejects(
    () => db.prepare(
      `INSERT INTO fund_ticker (fund_id, ticker, valid_from, valid_to)
       VALUES ('fund_spy', 'BADDATE', '2026-2-3', NULL)`,
    ).run(),
    /invalid_ticker_validity_date/,
  );
  await assert.rejects(
    () => applyObservation(db, {
      fundId: "fund_spy",
      sessionDate: "2026-02-30",
      status: "priced",
      price: "100",
      volume: "1",
      source: "fixture",
    }, "2026-07-30T10:00:00Z"),
    /invalid_session_date/,
  );
});

test("historical reconciliation resolves the ticker valid for each session", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  await seedWatchlist(db);
  await db.prepare(
    `UPDATE fund_ticker SET valid_to = '2026-07-28'
     WHERE fund_id = 'fund_qqq' AND valid_to IS NULL`,
  ).run();
  await db.prepare(
    `INSERT INTO fund_ticker (fund_id, ticker, valid_from, valid_to)
     VALUES ('fund_qqq', 'QQQ2', '2026-07-29', NULL)`,
  ).run();
  const provider = new FixtureProvider({
    SPY: [priced("2026-07-29", "100"), priced("2026-07-28", "99")],
    QQQ: [priced("2026-07-28", "198")],
    QQQ2: [priced("2026-07-29", "201")],
    BND: [priced("2026-07-29", "75"), priced("2026-07-28", "74")],
    USA: [priced("2026-07-29", "7"), priced("2026-07-28", "6")],
  });
  await runDailyIngestion(
    db,
    provider,
    new Date("2026-07-29T23:15:00Z"),
  );
  assert.equal((await getDailyRecord(db, "fund_qqq", "2026-07-28"))?.price, "198.000000");
  assert.equal((await getDailyRecord(db, "fund_qqq", "2026-07-29"))?.price, "201.000000");
});

test("ticker assignments are append-only and cannot rewrite recorded history", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  await seedWatchlist(db);
  await applyObservation(db, {
    fundId: "fund_qqq",
    sessionDate: "2026-07-29",
    status: "priced",
    price: "200",
    volume: "100",
    source: "fixture",
  }, "2026-07-29T23:15:00Z");
  await assert.rejects(
    () => db.prepare(
      "UPDATE fund_ticker SET ticker = 'OTHER' WHERE fund_id = 'fund_qqq'",
    ).run(),
    /immutable/,
  );
  await assert.rejects(
    () => db.prepare(
      "UPDATE fund_ticker SET valid_to = '2026-07-28' WHERE fund_id = 'fund_qqq'",
    ).run(),
    /rewrite_history/,
  );
  await assert.rejects(
    () => db.prepare(
      "DELETE FROM fund_ticker WHERE fund_id = 'fund_qqq'",
    ).run(),
    /append_only/,
  );
});

test("overlapping writers reload and preserve both valid transitions", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  await seedWatchlist(db);
  const base = {
    fundId: "fund_spy",
    sessionDate: "2026-07-29",
    status: "priced" as const,
    volume: "100",
    source: "fixture_provider",
  };
  await applyObservation(
    db,
    { ...base, price: "100" },
    "2026-07-30T10:00:00Z",
  );

  const outcomes = await Promise.allSettled([
    applyObservation(
      db,
      { ...base, price: "100.10" },
      "2026-07-30T11:00:00Z",
    ),
    applyObservation(
      db,
      { ...base, price: "100.20" },
      "2026-07-30T11:00:01Z",
    ),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 0);
  const current = await getDailyRecord(db, "fund_spy", "2026-07-29");
  assert.equal(current?.version, 3);
  const eventCount = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM record_event
       WHERE fund_id = 'fund_spy' AND session_date = '2026-07-29'`,
    )
    .first<{ count: number }>();
  assert.equal(eventCount?.count, 3);
});

test("an older observation can never overwrite newer recorded state", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  await seedWatchlist(db);
  const candidate = {
    fundId: "fund_spy",
    sessionDate: "2026-07-29",
    status: "priced" as const,
    volume: "100",
    source: "fixture_provider",
  };
  await applyObservation(
    db,
    { ...candidate, price: "100" },
    "2026-07-30T10:00:00Z",
  );
  await applyObservation(
    db,
    { ...candidate, price: "102" },
    "2026-07-30T12:00:00Z",
  );
  assert.equal(
    await applyObservation(
      db,
      { ...candidate, price: "101" },
      "2026-07-30T11:00:00Z",
    ),
    "unchanged",
  );
  const current = await getDailyRecord(db, "fund_spy", "2026-07-29");
  assert.equal(current?.price, "102.000000");
  assert.equal(current?.version, 2);
  assert.equal(current?.updatedAt, "2026-07-30T12:00:00Z");
});

test("the ingestion lease rejects overlapping and cooldown-hammered runs", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  let releaseReference: (() => void) | undefined;
  let signalReferenceStarted: (() => void) | undefined;
  const referenceStarted = new Promise<void>((resolve) => {
    signalReferenceStarted = resolve;
  });
  const referenceGate = new Promise<void>((resolve) => {
    releaseReference = resolve;
  });
  const provider: PriceProvider = {
    source: "slow_fixture",
    async dailySeries(ticker: string) {
      if (ticker === "SPY") {
        signalReferenceStarted?.();
        await referenceGate;
      }
      return [priced("2026-07-29", "100")];
    },
  };
  const first = runDailyIngestion(
    db,
    provider,
    new Date("2026-07-29T23:15:00Z"),
  );
  await referenceStarted;
  await assert.rejects(
    () => runDailyIngestion(
      db,
      provider,
      new Date("2026-07-29T23:15:01Z"),
    ),
    IngestionBusyError,
  );
  releaseReference?.();
  await first;
  await assert.rejects(
    () => runDailyIngestion(
      db,
      provider,
      new Date("2026-07-29T23:15:30Z"),
    ),
    IngestionBusyError,
  );
  const runs = await db.prepare(
    "SELECT COUNT(*) AS count FROM ingestion_run",
  ).first<{ count: number }>();
  assert.equal(runs?.count, 1);
});

test("a stale lease is recovered and its abandoned run becomes failed", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  await db.prepare(
    `INSERT INTO ingestion_run
      (id, source, trigger_kind, started_at, status)
     VALUES ('abandoned', 'fixture', 'scheduled', ?, 'running')`,
  ).bind("2026-07-29T22:00:00Z").run();
  await db.prepare(
    `UPDATE ingestion_lease
     SET run_id = 'abandoned', acquired_at = ?, released_at = NULL
     WHERE id = 1`,
  ).bind("2026-07-29T22:00:00Z").run();

  await runDailyIngestion(
    db,
    new FixtureProvider({
      SPY: [priced("2026-07-29", "100")],
      QQQ: [priced("2026-07-29", "200")],
      BND: [priced("2026-07-29", "75")],
      USA: [priced("2026-07-29", "7")],
    }),
    new Date("2026-07-29T23:15:00Z"),
  );
  const abandoned = await db.prepare(
    "SELECT status, finished_at AS finishedAt FROM ingestion_run WHERE id = 'abandoned'",
  ).first<{ status: string; finishedAt: string | null }>();
  assert.equal(abandoned?.status, "failed");
  assert.equal(abandoned?.finishedAt, "2026-07-29T23:15:00.000Z");
});

test("scheduled configuration failures are persisted as terminal runs", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  const runId = await recordFailedIngestionRun(
    db,
    "configuration",
    "ALPHA_VANTAGE_API_KEY is unset.",
    new Date("2026-07-29T23:15:00Z"),
  );
  const run = await db.prepare(
    `SELECT status, trigger_kind AS triggerKind, failure_count AS failureCount
     FROM ingestion_run WHERE id = ?`,
  ).bind(runId).first<{
    status: string;
    triggerKind: string;
    failureCount: number;
  }>();
  assert.deepEqual(run, {
    status: "failed",
    triggerKind: "scheduled",
    failureCount: 1,
  });
});
