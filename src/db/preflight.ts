/**
 * Upgrade preflight: runs the migration guards (migrationGuards.ts) of this
 * build against a live database without changing it, so an upgrade can stop
 * before the new code is installed instead of failing at its first start.
 *
 * It answers one question: would this build's pending migrations go ahead on
 * the data as it stands? The database is opened read-only, on a connection of
 * its own, and never migrated: SQLite through a `readonly` handle (not
 * createDb, which creates the file and switches it to WAL), Postgres inside a
 * `READ ONLY` transaction that is rolled back. A running server may keep
 * writing meanwhile; the check reads one consistent snapshot.
 *
 * The answer is a point-in-time one: data written after it can still trip a
 * guard, which is why the server runs the same guards again right before it
 * migrates at startup.
 */
import { existsSync } from "node:fs";

import BetterSqlite3 from "better-sqlite3";
import pg from "pg";

import { ConfigError, loadConfig, type PgDbConfig, type SqliteDbConfig } from "../config.js";
import { resolveEnvFile } from "../instance/env.js";
import { MIGRATIONS_TABLE, shippedMigrationCount } from "./index.js";
import { pendingMigrationRefusals, type MigrationRefused, type RawQuery } from "./migrationGuards.js";

export interface PreflightResult {
  /** Migrations recorded as applied in the database (0 = fresh or absent). */
  applied: number;
  /** Migrations this build ships. */
  shipped: number;
  /** One per pending migration that cannot go ahead, in journal order. */
  refusals: MigrationRefused[];
}

/** How long a SQLite read waits on a lock held by a writer before giving up. */
const SQLITE_BUSY_TIMEOUT_MS = 2000;

/**
 * The dialect-neutral part, run inside the caller's read-only snapshot:
 * count what is applied (none when the bookkeeping table is absent: a fresh
 * database), then run the guards of everything after that.
 */
async function check(
  query: RawQuery,
  bookkeepingPresent: () => Promise<boolean>,
  table: string,
  shipped: number,
): Promise<PreflightResult> {
  const applied = (await bookkeepingPresent())
    ? Number((await query(`SELECT COUNT(*) AS n FROM ${table}`))[0]!.n)
    : 0;
  return { applied, shipped, refusals: await pendingMigrationRefusals(applied, shipped - 1, query) };
}

async function checkSqlite(config: SqliteDbConfig): Promise<PreflightResult> {
  const shipped = shippedMigrationCount("sqlite");
  // No file yet: the first start creates and migrates it; nothing to check.
  if (config.path === ":memory:" || !existsSync(config.path)) return { applied: 0, shipped, refusals: [] };
  const conn = new BetterSqlite3(config.path, { readonly: true, fileMustExist: true, timeout: SQLITE_BUSY_TIMEOUT_MS });
  try {
    const query: RawQuery = async (sql) => conn.prepare(sql).all() as Record<string, unknown>[];
    conn.exec("BEGIN"); // one snapshot for the count and every guard
    try {
      return await check(
        query,
        async () => (await query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${MIGRATIONS_TABLE.sqlite}'`)).length > 0,
        MIGRATIONS_TABLE.sqlite,
        shipped,
      );
    } finally {
      conn.exec("COMMIT");
    }
  } finally {
    conn.close();
  }
}

async function checkPg(config: PgDbConfig): Promise<PreflightResult> {
  const client = new pg.Client({ connectionString: config.url });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const query: RawQuery = async (sql) => (await client.query(sql)).rows as Record<string, unknown>[];
      // Probe for the bookkeeping table instead of letting a missing one
      // error: an error would abort the transaction for the guards after it.
      return await check(
        query,
        async () => (await query(`SELECT to_regclass('${MIGRATIONS_TABLE.pg}') IS NOT NULL AS present`))[0]!.present === true,
        MIGRATIONS_TABLE.pg,
        shippedMigrationCount("pg"),
      );
    } finally {
      await client.query("ROLLBACK").catch(() => {});
    }
  } finally {
    await client.end();
  }
}

/** Checks this build's pending migrations against the database. Never writes. */
export async function preflight(config: SqliteDbConfig | PgDbConfig): Promise<PreflightResult> {
  return config.dialect === "sqlite" ? checkSqlite(config) : checkPg(config);
}

/**
 * `yap preflight`, in-process: loads the instance's env and config the way
 * serve does, checks, prints, and returns the exit code (0 = this build can
 * start on the database as it stands, 1 = it cannot). A configuration this
 * build refuses counts as a failure too: it would stop the server at startup.
 */
export async function runPreflightCommand(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    console.error(`yap preflight: takes no arguments, got ${argv.join(" ")}`);
    return 1;
  }
  const envFile = resolveEnvFile();
  if (envFile) process.loadEnvFile(envFile);
  let dbConfig: SqliteDbConfig | PgDbConfig;
  try {
    dbConfig = loadConfig().db;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`yap preflight: this version would not start with this configuration: ${err.message}`);
    return 1;
  }

  const { applied, shipped, refusals } = await preflight(dbConfig);
  const pending = Math.max(0, shipped - applied);
  if (refusals.length > 0) {
    for (const refusal of refusals) console.error(`yap preflight: ${refusal.message}`);
    console.error(
      `yap preflight: ${refusals.length} of ${pending} pending migration(s) cannot be applied to this data; ` +
        "this version would refuse to start",
    );
    return 1;
  }
  if (applied === 0) console.log("preflight passed: no existing database to check (the first start creates it)");
  else if (applied > shipped) {
    console.log(`preflight passed: the database is ${applied - shipped} migration(s) ahead of this version; none to apply`);
  } else console.log(`preflight passed: ${pending} pending migration(s), none refused`);
  return 0;
}
