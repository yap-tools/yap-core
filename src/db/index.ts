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
 *
 * The raw-access methods (listDataTables/insertRows/snapshotRead) bypass the
 * TS schema entirely and speak database column names, so backup export and
 * import work at whatever schema version the database file is actually at —
 * including one older than this build (the pre-migration backup case).
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  /** Apply migrations only up to (and including) journal index `index`. */
  migrateTo(index: number): Promise<void>;
  /** Number of journal entries shipped with this build. */
  journalLength(): number;
  /** Number of migrations recorded as applied in this database (0 = fresh). */
  appliedMigrations(): Promise<number>;
  /** Data tables present in the database (drizzle bookkeeping excluded). */
  listDataTables(): Promise<string[]>;
  /** Raw insert keyed by database column names — schema-version agnostic. */
  insertRows(table: string, rows: Record<string, unknown>[]): Promise<void>;
  /** Consistent read: all read() calls inside fn see one snapshot. */
  snapshotRead<T>(fn: (read: (table: string) => Promise<Record<string, unknown>[]>) => Promise<T>): Promise<T>;
  /** Drop every data table plus migration bookkeeping (restore --force). */
  dropAllTables(): Promise<void>;
  close(): Promise<void>;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface JournalEntry {
  idx: number;
  tag: string;
}

function journalEntries(dialect: "sqlite" | "pg"): JournalEntry[] {
  const path = resolve(repoRoot, "drizzle", dialect, "meta", "_journal.json");
  return (JSON.parse(readFileSync(path, "utf8")) as { entries: JournalEntry[] }).entries;
}

/** The migration tag at a journal index (for backup manifests). */
export function journalTag(dialect: "sqlite" | "pg", index: number): string {
  const entry = journalEntries(dialect).find((e) => e.idx === index);
  if (!entry) throw new Error(`no ${dialect} migration at journal index ${index}`);
  return entry.tag;
}

/**
 * Stock-migrator partial apply: copy the migrations folder with the journal
 * truncated to `index` and run the normal migrator against the copy. Its
 * bookkeeping rows match a full run exactly (same hashes, same timestamps),
 * so a later migrate() continues from where this stopped.
 */
function truncatedMigrationsFolder(dialect: "sqlite" | "pg", index: number): string {
  const src = resolve(repoRoot, "drizzle", dialect);
  const journal = JSON.parse(readFileSync(resolve(src, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
    [k: string]: unknown;
  };
  if (index < 0 || index >= journal.entries.length) {
    throw new Error(`migration index ${index} out of range (journal has ${journal.entries.length} entries)`);
  }
  const dir = mkdtempSync(join(tmpdir(), "yap-migrate-to-"));
  mkdirSync(join(dir, "meta"), { recursive: true });
  const entries = journal.entries.filter((e) => e.idx <= index);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const e of entries) {
    copyFileSync(resolve(src, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  }
  return dir;
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid identifier: ${name}`);
  return `"${name}"`;
}

export async function createDb(config: SqliteDbConfig | PgDbConfig): Promise<Db> {
  if (config.dialect === "sqlite") {
    if (config.path !== ":memory:") {
      mkdirSync(dirname(resolve(config.path)), { recursive: true });
    }
    const sqlite = new BetterSqlite3(config.path);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    const client = drizzleSqlite(sqlite);

    const listNames = (): string[] =>
      (
        sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((r) => r.name);

    return {
      dialect: "sqlite",
      client,
      tables: sqliteSchema,
      migrate: async () => {
        migrateSqlite(client, { migrationsFolder: resolve(repoRoot, "drizzle/sqlite") });
      },
      migrateTo: async (index) => {
        const folder = truncatedMigrationsFolder("sqlite", index);
        try {
          migrateSqlite(client, { migrationsFolder: folder });
        } finally {
          rmSync(folder, { recursive: true, force: true });
        }
      },
      journalLength: () => journalEntries("sqlite").length,
      appliedMigrations: async () => {
        try {
          const row = sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as { n: number };
          return row.n;
        } catch {
          return 0; // bookkeeping table absent — fresh database
        }
      },
      listDataTables: async () => listNames(),
      insertRows: async (table, rows) => {
        if (rows.length === 0) return;
        const cols = Object.keys(rows[0]!);
        const stmt = sqlite.prepare(
          `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        );
        const insertAll = sqlite.transaction((rs: Record<string, unknown>[]) => {
          for (const r of rs) stmt.run(...(cols.map((c) => r[c]) as never[]));
        });
        insertAll(rows);
      },
      snapshotRead: async (fn) => {
        // The serving path shares the main connection; a second read-only
        // connection gives a consistent WAL snapshot without entangling
        // transactions. :memory: cannot be reopened — use the main connection
        // there (single-task contexts only, i.e. tests).
        const conn = config.path === ":memory:" ? sqlite : new BetterSqlite3(config.path, { readonly: true });
        conn.exec("BEGIN");
        try {
          return await fn(async (table) => conn.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() as Record<string, unknown>[]);
        } finally {
          conn.exec("COMMIT");
          if (conn !== sqlite) conn.close();
        }
      },
      dropAllTables: async () => {
        sqlite.pragma("foreign_keys = OFF");
        for (const t of listNames()) sqlite.exec(`DROP TABLE IF EXISTS ${quoteIdent(t)}`);
        sqlite.exec("DROP TABLE IF EXISTS __drizzle_migrations");
        sqlite.pragma("foreign_keys = ON");
      },
      close: async () => {
        sqlite.close();
      },
    };
  }

  const pool = new pg.Pool({ connectionString: config.url });
  const client = drizzlePg(pool);

  const listNames = async (): Promise<string[]> =>
    (await pool.query("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows.map(
      (r: { name: string }) => r.name,
    );

  return {
    dialect: "pg",
    client: client as unknown as DbClient,
    tables: pgSchema as unknown as Tables,
    migrate: async () => {
      await migratePg(client, { migrationsFolder: resolve(repoRoot, "drizzle/pg") });
    },
    migrateTo: async (index) => {
      const folder = truncatedMigrationsFolder("pg", index);
      try {
        await migratePg(client, { migrationsFolder: folder });
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
    journalLength: () => journalEntries("pg").length,
    appliedMigrations: async () => {
      try {
        const res = await pool.query("SELECT COUNT(*)::int AS n FROM drizzle.__drizzle_migrations");
        return (res.rows[0] as { n: number }).n;
      } catch {
        return 0; // bookkeeping table absent — fresh database
      }
    },
    listDataTables: listNames,
    insertRows: async (table, rows) => {
      if (rows.length === 0) return;
      const cols = Object.keys(rows[0]!);
      const conn = await pool.connect();
      try {
        await conn.query("BEGIN");
        const chunkSize = 200;
        for (let at = 0; at < rows.length; at += chunkSize) {
          const chunk = rows.slice(at, at + chunkSize);
          const placeholders = chunk
            .map((_, ri) => `(${cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(", ")})`)
            .join(", ");
          await conn.query(
            `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(", ")}) VALUES ${placeholders}`,
            chunk.flatMap((r) => cols.map((c) => r[c])) as unknown[],
          );
        }
        await conn.query("COMMIT");
      } catch (err) {
        await conn.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    },
    snapshotRead: async (fn) => {
      const conn = await pool.connect();
      try {
        await conn.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        return await fn(async (table) => (await conn.query(`SELECT * FROM ${quoteIdent(table)}`)).rows);
      } finally {
        await conn.query("COMMIT").catch(() => {});
        conn.release();
      }
    },
    dropAllTables: async () => {
      for (const t of await listNames()) {
        await pool.query(`DROP TABLE IF EXISTS ${quoteIdent(t)} CASCADE`);
      }
      await pool.query("DROP TABLE IF EXISTS drizzle.__drizzle_migrations");
    },
    close: async () => {
      await pool.end();
    },
  };
}
