/**
 * Structured-data store adapter layer. Domain code receives a `Db` and reaches
 * tables only through it; Drizzle does the dialect translation.
 *
 * Typing strategy for the twin schemas: repositories are written once against
 * the SQLite-typed surface (`Tables`, `DbClient`). The Postgres adapter casts
 * its drizzle instance and table set to the same structural types — the table
 * and column names are identical by construction, the shared query path stays
 * within Drizzle's SQLite∩Postgres subset, and the both-adapter integration
 * test matrix enforces runtime equivalence.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import BetterSqlite3 from "better-sqlite3";
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import type { PgDbConfig, SqliteDbConfig } from "../config.js";
import * as sqliteSchema from "./schema-sqlite.js";
import * as pgSchema from "./schema-pg.js";

export type Tables = typeof sqliteSchema;
export type DbClient = BetterSQLite3Database;

export interface Db {
  dialect: "sqlite" | "pg";
  client: DbClient;
  tables: Tables;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function createDb(config: SqliteDbConfig | PgDbConfig): Promise<Db> {
  if (config.dialect === "sqlite") {
    if (config.path !== ":memory:") {
      mkdirSync(dirname(resolve(config.path)), { recursive: true });
    }
    const sqlite = new BetterSqlite3(config.path);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    const client = drizzleSqlite(sqlite);
    return {
      dialect: "sqlite",
      client,
      tables: sqliteSchema,
      migrate: async () => {
        migrateSqlite(client, { migrationsFolder: resolve(repoRoot, "drizzle/sqlite") });
      },
      close: async () => {
        sqlite.close();
      },
    };
  }

  const pool = new pg.Pool({ connectionString: config.url });
  const client = drizzlePg(pool);
  return {
    dialect: "pg",
    client: client as unknown as DbClient,
    tables: pgSchema as unknown as Tables,
    migrate: async () => {
      await migratePg(client, { migrationsFolder: resolve(repoRoot, "drizzle/pg") });
    },
    close: async () => {
      await pool.end();
    },
  };
}
