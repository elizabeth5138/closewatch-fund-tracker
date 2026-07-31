import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  recordFailedIngestionRun,
  runDailyIngestion,
} from "../lib/ingestion.ts";
import type { PriceProvider, ProviderBar } from "../lib/provider.ts";
import { INTEGRITY_TRIGGER_NAMES } from "../lib/store.ts";
import { nodeSqliteD1 } from "./sqlite-d1.ts";

const migrations = [
  "0000_messy_tyrannus.sql",
  "0001_peaceful_northstar.sql",
  "0002_far_maximus.sql",
  "0003_certain_reptil.sql",
  "0004_clean_karma.sql",
];

async function migrationOnlyDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  for (const filename of migrations) {
    const sql = await readFile(new URL(`../drizzle/${filename}`, import.meta.url), "utf8");
    sqlite.exec(sql);
  }
  return { sqlite, db: nodeSqliteD1(sqlite) };
}

class BootstrapProvider implements PriceProvider {
  readonly source = "bootstrap_fixture";

  async dailySeries(ticker: string): Promise<ProviderBar[]> {
    if (!["SPY", "QQQ", "BND", "USA"].includes(ticker)) {
      throw new Error(`Unexpected ticker ${ticker}`);
    }
    return [{ sessionDate: "2026-07-29", close: "100.000000", volume: "100" }];
  }
}

test("daily ingestion installs the complete trigger bundle from migration-only state", async () => {
  const { sqlite, db } = await migrationOnlyDatabase();
  try {
    await runDailyIngestion(
      db,
      new BootstrapProvider(),
      new Date("2026-07-30T11:00:00Z"),
      "scheduled",
    );
    const count = sqlite.prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger'",
    ).get() as { count: number };
    assert.equal(count.count, INTEGRITY_TRIGGER_NAMES.length);
    assert.throws(
      () => sqlite.prepare(
        `UPDATE daily_record SET price = '999.000000'
         WHERE fund_id = 'fund_spy' AND session_date = '2026-07-29'`,
      ).run(),
      /event_required/,
    );
  } finally {
    sqlite.close();
  }
});

test("failed ingestion replaces a stale sentinel-only bundle", async () => {
  const { sqlite, db } = await migrationOnlyDatabase();
  try {
    sqlite.exec(
      `CREATE TRIGGER record_event_no_delete
       BEFORE DELETE ON record_event BEGIN SELECT 1; END`,
    );
    await recordFailedIngestionRun(
      db,
      "configuration",
      "provider key absent",
      new Date("2026-07-30T11:00:00Z"),
    );
    const triggers = sqlite.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger'",
    ).all() as Array<{ name: string; sql: string }>;
    assert.equal(triggers.length, INTEGRITY_TRIGGER_NAMES.length);
    assert.match(
      triggers.find((trigger) => trigger.name === "record_event_no_delete")?.sql ?? "",
      /record_event_is_append_only/,
    );
  } finally {
    sqlite.close();
  }
});

test("failed ingestion repairs a missing trigger from an otherwise current bundle", async () => {
  const { sqlite, db } = await migrationOnlyDatabase();
  try {
    await recordFailedIngestionRun(
      db,
      "configuration",
      "initial bootstrap",
      new Date("2026-07-30T11:00:00Z"),
    );
    sqlite.exec("DROP TRIGGER daily_record_no_direct_update");
    await recordFailedIngestionRun(
      db,
      "configuration",
      "repair bootstrap",
      new Date("2026-07-30T11:02:00Z"),
    );
    const repaired = sqlite.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'daily_record_no_direct_update'`,
    ).get() as { sql: string } | undefined;
    assert.match(repaired?.sql ?? "", /daily_record_event_required/);
  } finally {
    sqlite.close();
  }
});

test("failed ingestion repairs a case-sensitive literal mutation with every trigger name present", async () => {
  const { sqlite, db } = await migrationOnlyDatabase();
  try {
    await recordFailedIngestionRun(
      db,
      "configuration",
      "initial bootstrap",
      new Date("2026-07-30T11:00:00Z"),
    );
    const current = sqlite.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'record_event_validate_insert'`,
    ).get() as { sql: string };
    const staleDefinition = current.sql.replace("'status'", "'STATUS'");
    assert.notEqual(staleDefinition, current.sql);
    sqlite.exec("DROP TRIGGER record_event_validate_insert");
    sqlite.exec(staleDefinition);

    await recordFailedIngestionRun(
      db,
      "configuration",
      "repair bootstrap",
      new Date("2026-07-30T11:02:00Z"),
    );
    const repaired = sqlite.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'record_event_validate_insert'`,
    ).get() as { sql: string };
    assert.match(repaired.sql, /'status'/);
    assert.doesNotMatch(repaired.sql, /'STATUS'/);

    const result = await runDailyIngestion(
      db,
      new BootstrapProvider(),
      new Date("2026-07-30T11:04:00Z"),
      "scheduled",
    );
    assert.equal(result.failed.length, 0);
  } finally {
    sqlite.close();
  }
});
