import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("hosting declares durable storage and two Singapore-day reconciliation triggers", async () => {
  const [hostingRaw, vite, worker, builtWrangler, stagedHosting, ...stagedMigrations] = await Promise.all([
    readFile(new URL(".openai/hosting.json", root), "utf8"),
    readFile(new URL("vite.config.ts", root), "utf8"),
    readFile(new URL("worker/index.ts", root), "utf8"),
    readFile(new URL("dist/server/wrangler.json", root), "utf8"),
    readFile(new URL("dist/.openai/hosting.json", root), "utf8"),
    readFile(new URL("dist/.openai/drizzle/0000_messy_tyrannus.sql", root), "utf8"),
    readFile(new URL("dist/.openai/drizzle/0001_peaceful_northstar.sql", root), "utf8"),
    readFile(new URL("dist/.openai/drizzle/0002_far_maximus.sql", root), "utf8"),
    readFile(new URL("dist/.openai/drizzle/0003_certain_reptil.sql", root), "utf8"),
    readFile(new URL("dist/.openai/drizzle/0004_clean_karma.sql", root), "utf8"),
  ]);
  const hosting = JSON.parse(hostingRaw);
  const compiledWorker = JSON.parse(builtWrangler);
  assert.equal(hosting.d1, "DB");
  assert.equal(hosting.r2, null);
  assert.match(vite, /"15 23 \* \* 1-5"/);
  assert.match(vite, /"45 9 \* \* 2-6"/);
  assert.match(worker, /async scheduled\(/);
  assert.match(worker, /runDailyIngestion/);
  assert.deepEqual(compiledWorker.triggers.crons, [
    "15 23 * * 1-5",
    "45 9 * * 2-6",
  ]);
  assert.equal(JSON.parse(stagedHosting).d1, "DB");
  const stagedSql = stagedMigrations.join("\n");
  assert.match(stagedSql, /CREATE TABLE IF NOT EXISTS `daily_record`/);
  assert.match(stagedSql, /CREATE TABLE IF NOT EXISTS `ingestion_lease`/);
  assert.match(stagedSql, /CREATE TABLE IF NOT EXISTS `ingestion_expectation`/);
  assert.match(stagedSql, /CREATE TABLE IF NOT EXISTS `reference_session`/);
  assert.doesNotMatch(stagedSql, /CREATE TRIGGER/);
});

test("the schedule covers each US weekday close, including Friday, within 24 hours", () => {
  const sessionCloses = [
    "2026-07-27T20:00:00Z",
    "2026-07-28T20:00:00Z",
    "2026-07-29T20:00:00Z",
    "2026-07-30T20:00:00Z",
    "2026-07-31T20:00:00Z",
  ].map((value) => new Date(value));
  const scheduled = [
    "2026-07-27T23:15:00Z",
    "2026-07-28T09:45:00Z", "2026-07-28T23:15:00Z",
    "2026-07-29T09:45:00Z", "2026-07-29T23:15:00Z",
    "2026-07-30T09:45:00Z", "2026-07-30T23:15:00Z",
    "2026-07-31T09:45:00Z", "2026-07-31T23:15:00Z",
    "2026-08-01T09:45:00Z",
  ].map((value) => new Date(value));
  for (const close of sessionCloses) {
    const next = scheduled.find((instant) => instant > close);
    assert.ok(next, `No scheduled run after ${close.toISOString()}`);
    assert.ok(
      next.getTime() - close.getTime() <= 24 * 60 * 60 * 1000,
      `${close.toISOString()} waits more than 24 hours`,
    );
  }
});

test("ingestion installs the runtime integrity triggers before any write", async () => {
  const [runtimeSchema, ingestion] = await Promise.all([
    readFile(new URL("lib/store.ts", root), "utf8"),
    readFile(new URL("lib/ingestion.ts", root), "utf8"),
  ]);
  const runtimeTriggers = [...new Set(
    [...runtimeSchema.matchAll(/CREATE TRIGGER IF NOT EXISTS ([a-z_]+)/g)]
      .map((match) => match[1]),
  )].sort();
  assert.ok(runtimeTriggers.length >= 9);
  assert.match(runtimeSchema, /record_event_no_delete/);
  const dailyBootstrap = ingestion.indexOf("await ensureSchema(db);", ingestion.indexOf("runDailyIngestion"));
  const failedBootstrap = ingestion.indexOf("await ensureSchema(db);", ingestion.indexOf("recordFailedIngestionRun"));
  assert.ok(dailyBootstrap > 0);
  assert.ok(failedBootstrap > 0);
  assert.ok(dailyBootstrap < ingestion.indexOf("await acquireLease", dailyBootstrap));
  assert.ok(failedBootstrap < ingestion.indexOf("await acquireLease", failedBootstrap));
});

test("the committed migrations execute as complete SQLite scripts", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (let pass = 1; pass <= 2; pass += 1) {
      for (const filename of [
        "0000_messy_tyrannus.sql",
        "0001_peaceful_northstar.sql",
        "0002_far_maximus.sql",
        "0003_certain_reptil.sql",
        "0004_clean_karma.sql",
      ]) {
        const migration = await readFile(new URL(`drizzle/${filename}`, root), "utf8");
        assert.doesNotThrow(() => db.exec(migration), `${filename}, pass ${pass}`);
      }
    }
  } finally {
    db.close();
  }
});

test("live ingestion requires both private runtime values", async () => {
  const [route, envExample] = await Promise.all([
    readFile(new URL("app/api/ingest/route.ts", root), "utf8"),
    readFile(new URL(".env.example", root), "utf8"),
  ]);
  assert.match(envExample, /^ALPHA_VANTAGE_API_KEY=/m);
  assert.match(envExample, /^INGEST_TOKEN=/m);
  assert.match(route, /if \(!runtime\.INGEST_TOKEN\)/);
  assert.match(route, /secureTokenMatch/);
  assert.match(route, /status: 429/);
  assert.match(route, /"retry-after"/);
  const authCheck = route.indexOf("if (!(await secureTokenMatch");
  assert.ok(authCheck < route.indexOf("if (!runtime.DB)"));
  assert.ok(authCheck < route.indexOf("if (!runtime.ALPHA_VANTAGE_API_KEY)"));
});

test("the dashboard read path is read-only and private hosting is explicit", async () => {
  const [dashboard, readme] = await Promise.all([
    readFile(new URL("lib/dashboard.ts", root), "utf8"),
    readFile(new URL("README.md", root), "utf8"),
  ]);
  assert.doesNotMatch(dashboard, /ensureSchema|seedWatchlist/);
  assert.match(readme, /private site/i);
  assert.match(readme, /must not be changed to a shared\/public\s+deployment/i);
});
