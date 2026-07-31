import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("hosting declares durable storage and two Singapore-day reconciliation triggers", async () => {
  const [hostingRaw, vite, worker, builtWrangler, stagedHosting, stagedMigration, stagedSecondMigration, stagedThirdMigration, stagedFourthMigration, stagedFifthMigration] = await Promise.all([
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
  assert.match(stagedMigration, /CREATE TRIGGER `record_event_validate_insert`/);
  assert.match(stagedSecondMigration, /`trigger_kind` text DEFAULT 'manual' NOT NULL/);
  assert.match(stagedSecondMigration, /SELECT "id", "source", 'manual'/);
  assert.match(stagedThirdMigration, /CREATE TABLE `ingestion_lease`/);
  assert.match(stagedThirdMigration, /INSERT INTO `ingestion_lease`/);
  assert.match(stagedFourthMigration, /CREATE TABLE `ingestion_expectation`/);
  assert.match(stagedFifthMigration, /CREATE TABLE `reference_session`/);
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

test("runtime schema and committed migration contain the same integrity triggers", async () => {
  const [runtimeSchema, ...migrations] = await Promise.all([
    readFile(new URL("lib/store.ts", root), "utf8"),
    readFile(new URL("drizzle/0000_messy_tyrannus.sql", root), "utf8"),
    readFile(new URL("drizzle/0001_peaceful_northstar.sql", root), "utf8"),
    readFile(new URL("drizzle/0002_far_maximus.sql", root), "utf8"),
    readFile(new URL("drizzle/0003_certain_reptil.sql", root), "utf8"),
    readFile(new URL("drizzle/0004_clean_karma.sql", root), "utf8"),
  ]);
  const runtimeTriggers = [...new Set(
    [...runtimeSchema.matchAll(/CREATE TRIGGER IF NOT EXISTS ([a-z_]+)/g)]
      .map((match) => match[1]),
  )].sort();
  const migrationTriggers = [...new Set(
    migrations.flatMap((migration) =>
      [...migration.matchAll(/CREATE TRIGGER `([a-z_]+)`/g)]
        .map((match) => match[1]),
    ),
  )].sort();
  assert.ok(runtimeTriggers.length >= 9);
  assert.deepEqual(migrationTriggers, runtimeTriggers);
});

test("the committed migrations execute as complete SQLite scripts", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const filename of [
      "0000_messy_tyrannus.sql",
      "0001_peaceful_northstar.sql",
      "0002_far_maximus.sql",
      "0003_certain_reptil.sql",
      "0004_clean_karma.sql",
    ]) {
      const migration = await readFile(new URL(`drizzle/${filename}`, root), "utf8");
      assert.doesNotThrow(() => db.exec(migration), filename);
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
