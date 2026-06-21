/**
 * The both-adapter test matrix. Suites written with describeEachAdapter run
 * against SQLite in-memory always, and against Postgres when YAP_TEST_PG_URL
 * is set (CI provides a service container). This is what enforces the
 * portability promise mechanically.
 */
import { sql } from "drizzle-orm";
import { describe } from "vitest";

import { createDb, type Db } from "../../src/db/index.js";

export interface Adapter {
  dialect: "sqlite" | "pg";
  /** Returns a migrated, empty database. Caller must close() it. */
  makeDb(): Promise<Db>;
  /** Returns an unmigrated (schema-less) database. Caller must close() it. */
  makeFreshDb(): Promise<Db>;
}

const PG_URL = process.env.YAP_TEST_PG_URL;

// Tables in FK-safe truncation order (children first; TRUNCATE ... CASCADE
// makes order moot on pg, but keep the list explicit and complete).
const ALL_TABLES = [
  "item_values",
  "items",
  "properties",
  "item_types",
  "hooks",
  "files",
  "agent_files",
  "agents",
  "runtime_credentials",
  "user_docs",
  "grants",
  "bundle_docs",
  "bundles",
  "spaces",
  "oauth_tokens",
  "oauth_codes",
  "oauth_grants",
  "oauth_clients",
  "access_keys",
  "users",
];

let pgMigrated = false;

async function makePgDb(url: string): Promise<Db> {
  const db = await createDb({ dialect: "pg", url });
  if (!pgMigrated) {
    await db.migrate();
    pgMigrated = true;
  }
  // .execute exists on the pg drizzle instance; the shared Db type is
  // sqlite-shaped, so go through a structural cast here (test-only).
  const pgClient = db.client as unknown as { execute(q: unknown): Promise<unknown> };
  await pgClient.execute(sql.raw(`TRUNCATE TABLE ${ALL_TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`));
  return db;
}

async function makeSqliteDb(): Promise<Db> {
  const db = await createDb({ dialect: "sqlite", path: ":memory:" });
  await db.migrate();
  return db;
}

/** Schema-less database: sqlite gets a blank :memory: file; pg gets the shared
 * database with every table (and migration bookkeeping) dropped. */
async function makeFreshSqliteDb(): Promise<Db> {
  return createDb({ dialect: "sqlite", path: ":memory:" });
}

async function makeFreshPgDb(url: string): Promise<Db> {
  const db = await createDb({ dialect: "pg", url });
  await db.dropAllTables();
  pgMigrated = false; // a later makeDb must re-migrate
  return db;
}

export function describeEachAdapter(name: string, fn: (adapter: Adapter) => void): void {
  describe(`${name} [sqlite]`, () => {
    fn({ dialect: "sqlite", makeDb: makeSqliteDb, makeFreshDb: makeFreshSqliteDb });
  });
  const pgDescribe = PG_URL ? describe : describe.skip;
  pgDescribe(`${name} [pg]`, () => {
    fn({ dialect: "pg", makeDb: () => makePgDb(PG_URL!), makeFreshDb: () => makeFreshPgDb(PG_URL!) });
  });
}
