import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { ensureSchema } from "../lib/store.ts";

export async function makeTestDb(options: { bootstrap?: boolean } = {}) {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: ["DB"],
  });
  const db = await mf.getD1Database("DB");
  for (const filename of [
    "0000_messy_tyrannus.sql",
    "0001_peaceful_northstar.sql",
    "0002_far_maximus.sql",
    "0003_certain_reptil.sql",
    "0004_clean_karma.sql",
  ]) {
    const migration = await readFile(
      new URL(`../drizzle/${filename}`, import.meta.url),
      "utf8",
    );
    const statements = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
  if (options.bootstrap !== false) await ensureSchema(db);
  return { mf, db };
}
