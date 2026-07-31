import { DatabaseSync } from "node:sqlite";

type BoundValue = string | number | bigint | null | Uint8Array;

class NodeSqliteStatement {
  private readonly database: DatabaseSync;
  private readonly sql: string;
  private values: BoundValue[] = [];

  constructor(database: DatabaseSync, sql: string) {
    this.database = database;
    this.sql = sql;
  }

  bind(...values: BoundValue[]) {
    this.values = values;
    return this;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }

  async first<T>(columnName?: string): Promise<T | null> {
    const row = this.database.prepare(this.sql).get(...this.values) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return (columnName ? row[columnName] : row) as T;
  }

  async all<T>() {
    const results = this.database.prepare(this.sql).all(...this.values) as T[];
    return { success: true, results, meta: {} };
  }
}

export function nodeSqliteD1(database: DatabaseSync): D1Database {
  const binding = {
    prepare(sql: string) {
      return new NodeSqliteStatement(database, sql);
    },
    async batch(statements: NodeSqliteStatement[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return binding as unknown as D1Database;
}
