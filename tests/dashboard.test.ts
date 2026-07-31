import assert from "node:assert/strict";
import test from "node:test";
import {
  hasNoPipelineGaps,
  illustrativeSnapshot,
  loadDashboard,
} from "../lib/dashboard.ts";
import { runDailyIngestion } from "../lib/ingestion.ts";
import type { PriceProvider, ProviderBar } from "../lib/provider.ts";
import { seedWatchlist } from "../lib/store.ts";
import { makeTestDb as makeDb } from "./d1.ts";

const session = "2026-07-29";
const bar = (close: string, volume = "100"): ProviderBar => ({
  sessionDate: session,
  close,
  volume,
});

class DashboardProvider implements PriceProvider {
  readonly source = "dashboard_fixture";
  readonly series: Record<string, ProviderBar[]>;
  constructor(series: Record<string, ProviderBar[]>) {
    this.series = series;
  }
  async dailySeries(ticker: string) {
    const result = this.series[ticker];
    if (!result) throw new Error(`No fixture for ${ticker}`);
    return structuredClone(result);
  }
}

function completeProvider(spyPrice = "100.129999") {
  return new DashboardProvider({
    SPY: [bar(spyPrice)],
    QQQ: [bar("200")],
    BND: [bar("75")],
    USA: [bar("7")],
  });
}

test("illustrative data is an explicit mode that never claims live health", () => {
  const snapshot = illustrativeSnapshot();
  assert.equal(snapshot.mode, "illustrative");
  assert.equal(snapshot.pipelineState, "setup");
  assert.ok(snapshot.funds.length > 0);
  assert.equal(snapshot.reliabilitySessions, 0);
});

test("an empty live database renders setup rather than sample prices", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  await seedWatchlist(db);
  const snapshot = await loadDashboard(db, new Date("2026-07-29T23:30:00Z"));
  assert.equal(snapshot.mode, "setup");
  assert.equal(snapshot.pipelineState, "setup");
  assert.deepEqual(snapshot.funds, []);
});

test("a fully priced scheduled session is healthy and advances reliability", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  const observedAt = new Date("2026-07-29T23:15:00Z");
  await runDailyIngestion(db, completeProvider(), observedAt, "scheduled");

  const snapshot = await loadDashboard(db, new Date("2026-07-30T01:00:00Z"));
  assert.equal(snapshot.mode, "live");
  assert.equal(snapshot.pipelineState, "healthy");
  assert.equal(snapshot.resolvedPercent, 100);
  assert.equal(snapshot.pricedPercent, 100);
  assert.equal(snapshot.reliabilitySessions, 1);
  assert.equal(snapshot.funds.find((fund) => fund.ticker === "SPY")?.price, "$100.13");
});

test("a manual-only refresh cannot claim healthy automation or advance reliability", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  await runDailyIngestion(
    db,
    completeProvider(),
    new Date("2026-07-29T23:15:00Z"),
    "manual",
  );
  const snapshot = await loadDashboard(db, new Date("2026-07-30T01:00:00Z"));
  assert.equal(snapshot.pipelineState, "attention");
  assert.equal(snapshot.reliabilitySessions, 0);
});

test("percentage rounding cannot hide even one unresolved fund", () => {
  assert.equal(Math.round((200 / 201) * 100), 100);
  assert.equal(hasNoPipelineGaps(201, 200), false);
  assert.equal(hasNoPipelineGaps(201, 201), true);
});

test("missing data is a pipeline defect and never counts as resolved", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  const provider = completeProvider();
  provider.series.QQQ = [];
  await runDailyIngestion(
    db,
    provider,
    new Date("2026-07-30T11:00:00Z"),
    "scheduled",
  );

  const snapshot = await loadDashboard(db, new Date("2026-07-30T12:00:00Z"));
  assert.equal(snapshot.pipelineState, "attention");
  assert.equal(snapshot.resolvedPercent, 75);
  assert.equal(snapshot.pricedPercent, 75);
  assert.equal(snapshot.reliabilitySessions, 0);
  assert.equal(snapshot.funds.find((fund) => fund.ticker === "QQQ")?.status, "missing");
});

test("every active fund shares the same latest-session denominator", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  await runDailyIngestion(
    db,
    completeProvider(),
    new Date("2026-07-29T23:15:00Z"),
    "scheduled",
  );
  await db.prepare(
    `INSERT INTO fund
      (id, name, exchange, currency, instrument_type, created_at)
     VALUES ('late_fund', 'Late fund', 'US', 'USD', 'ETF', '2026-07-29')`,
  ).run();
  await db.prepare(
    `INSERT INTO fund_ticker (fund_id, ticker, valid_from, valid_to)
     VALUES ('late_fund', 'LATE', '2026-07-29', NULL)`,
  ).run();
  await db.prepare(
    `INSERT INTO watchlist (fund_id, active, added_at)
     VALUES ('late_fund', 1, '2026-07-29')`,
  ).run();

  const snapshot = await loadDashboard(db, new Date("2026-07-30T01:00:00Z"));
  assert.equal(snapshot.funds.length, 5);
  assert.equal(snapshot.funds.find((fund) => fund.ticker === "LATE")?.status, "missing");
  assert.equal(snapshot.pipelineState, "attention");
  assert.equal(snapshot.resolvedPercent, 80);
  assert.equal(snapshot.reliabilitySessions, 0);
});

test("listing-lifecycle states render explicitly without inflating priced completeness", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  const provider = completeProvider();
  provider.series.QQQ = [];
  await runDailyIngestion(
    db,
    provider,
    new Date("2026-07-29T23:15:00Z"),
    "scheduled",
  );
  await db.prepare(
    "UPDATE fund SET inception_date = '2026-08-01' WHERE id = 'fund_qqq'",
  ).run();
  await runDailyIngestion(
    db,
    provider,
    new Date("2026-07-29T23:17:00Z"),
    "scheduled",
  );

  const snapshot = await loadDashboard(db, new Date("2026-07-30T01:00:00Z"));
  assert.equal(snapshot.funds.find((fund) => fund.ticker === "QQQ")?.status, "not_listed");
  assert.equal(snapshot.pipelineState, "healthy");
  assert.equal(snapshot.resolvedPercent, 100);
  assert.equal(snapshot.pricedPercent, 75);
  assert.equal(snapshot.reliabilitySessions, 0);
});

test("an older missing record in the same run keeps the pipeline unhealthy", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  const latest = "2026-07-29";
  const older = "2026-07-28";
  const provider = new DashboardProvider({
    SPY: [
      { sessionDate: latest, close: "100", volume: "100" },
      { sessionDate: older, close: "99", volume: "100" },
    ],
    QQQ: [{ sessionDate: latest, close: "200", volume: "100" }],
    BND: [
      { sessionDate: latest, close: "75", volume: "100" },
      { sessionDate: older, close: "74", volume: "100" },
    ],
    USA: [
      { sessionDate: latest, close: "7", volume: "100" },
      { sessionDate: older, close: "6", volume: "100" },
    ],
  });
  await runDailyIngestion(
    db,
    provider,
    new Date("2026-07-30T11:00:00Z"),
    "scheduled",
  );
  const snapshot = await loadDashboard(db, new Date("2026-07-30T12:00:00Z"));
  assert.equal(snapshot.pricedPercent, 100);
  assert.equal(snapshot.pipelineState, "attention");
  assert.match(snapshot.pipelineDetail, /Latest scheduled run partial/);
});

test("a missed scheduled occurrence turns an otherwise complete dashboard unhealthy", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  const result = await runDailyIngestion(
    db,
    completeProvider(),
    new Date("2026-07-29T23:15:00Z"),
    "scheduled",
  );
  await db.prepare(
    "UPDATE ingestion_run SET started_at = ?, finished_at = ? WHERE id = ?",
  ).bind("2026-07-29T23:15:00Z", "2026-07-29T23:16:00Z", result.runId).run();
  await runDailyIngestion(
    db,
    completeProvider(),
    new Date("2026-07-30T13:00:00Z"),
    "manual",
  );

  const snapshot = await loadDashboard(db, new Date("2026-07-30T13:00:00Z"));
  assert.equal(snapshot.pipelineState, "attention");
  assert.match(snapshot.pipelineDetail, /Expected scheduled run not observed/);
});

test("late reconciliation cannot skip a failed session in the consecutive counter", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  const monday = "2026-07-27";
  const tuesday = "2026-07-28";
  const wednesday = "2026-07-29";
  const provider = new DashboardProvider({
    SPY: [{ sessionDate: monday, close: "100", volume: "100" }],
    QQQ: [{ sessionDate: monday, close: "200", volume: "100" }],
    BND: [{ sessionDate: monday, close: "75", volume: "100" }],
    USA: [{ sessionDate: monday, close: "7", volume: "100" }],
  });
  await runDailyIngestion(
    db,
    provider,
    new Date("2026-07-27T23:15:00Z"),
    "scheduled",
  );
  for (const ticker of ["SPY", "QQQ", "BND", "USA"]) {
    provider.series[ticker] = [
      { sessionDate: wednesday, close: "102", volume: "100" },
      { sessionDate: tuesday, close: "101", volume: "100" },
      ...provider.series[ticker],
    ];
  }
  await runDailyIngestion(
    db,
    provider,
    new Date("2026-07-29T23:15:00Z"),
    "scheduled",
  );

  const snapshot = await loadDashboard(db, new Date("2026-07-30T01:00:00Z"));
  assert.equal(snapshot.pipelineState, "healthy");
  assert.equal(snapshot.reliabilitySessions, 1);
});

test("removing a fund today cannot erase its historical reliability failure", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  const provider = completeProvider();
  provider.series.QQQ = [];
  await runDailyIngestion(
    db,
    provider,
    new Date("2026-07-30T11:00:00Z"),
    "scheduled",
  );
  await db.prepare("UPDATE watchlist SET active = 0 WHERE fund_id = 'fund_qqq'").run();

  const snapshot = await loadDashboard(db, new Date("2026-07-30T12:00:00Z"));
  assert.equal(snapshot.resolvedPercent, 100);
  assert.equal(snapshot.reliabilitySessions, 0);
});

test("the conservative arrival deadline disqualifies a late half-day capture", async (t) => {
  const { mf, db } = await makeDb();
  t.after(() => mf.dispose());
  const halfDay = "2026-11-27";
  const provider = new DashboardProvider(Object.fromEntries(
    ["SPY", "QQQ", "BND", "USA"].map((ticker) => [ticker, [{
      sessionDate: halfDay,
      close: "100",
      volume: "100",
    }]]),
  ));
  await runDailyIngestion(
    db,
    provider,
    new Date("2026-11-28T11:00:00Z"),
    "scheduled",
  );
  const snapshot = await loadDashboard(db, new Date("2026-11-28T11:01:00Z"));
  assert.equal(snapshot.reliabilitySessions, 0);
});

test("same-day reference sessions become eligible only after the DST-aware New York close", async () => {
  for (const example of [
    {
      sessionDate: "2026-07-29",
      beforeClose: "2026-07-29T19:59:00Z",
      afterClose: "2026-07-29T20:01:00Z",
    },
    {
      sessionDate: "2026-01-05",
      beforeClose: "2026-01-05T20:59:00Z",
      afterClose: "2026-01-05T21:01:00Z",
    },
  ]) {
    const provider = new DashboardProvider(Object.fromEntries(
      ["SPY", "QQQ", "BND", "USA"].map((ticker) => [ticker, [{
        sessionDate: example.sessionDate,
        close: "100.000000",
        volume: "100",
      }]]),
    ));
    const before = await makeDb();
    await assert.rejects(
      () => runDailyIngestion(before.db, provider, new Date(example.beforeClose)),
      /No completed reference session/,
    );
    await before.mf.dispose();

    const after = await makeDb();
    const result = await runDailyIngestion(
      after.db,
      provider,
      new Date(example.afterClose),
    );
    assert.equal(result.sessionDate, example.sessionDate);
    await after.mf.dispose();
  }
});
