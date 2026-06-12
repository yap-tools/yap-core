/**
 * The 0005 cutover: non-empty inline bundles.docs values become autoloaded
 * bundle_docs rows named "instructions". Applies migrations up to 0004 with
 * drizzle's stock migrator against a truncated journal copy, seeds legacy
 * rows, then lets the full migrate() finish the job — same hashes, so the
 * bookkeeping continues where the partial run stopped.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle", "sqlite");

interface JournalEntry {
  idx: number;
  tag: string;
}

function truncatedFolder(uptoIdx: number): string {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
    [k: string]: unknown;
  };
  const dir = mkdtempSync(join(tmpdir(), "yap-mig-test-"));
  mkdirSync(join(dir, "meta"), { recursive: true });
  const entries = journal.entries.filter((e) => e.idx <= uptoIdx);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const e of entries) copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

describe("bundle docs cutover migration (sqlite)", () => {
  it("backfills non-empty inline docs as an autoloaded 'instructions' doc and drops the column", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "yap-mig-db-")), "yap.db");
    const sqlite = new BetterSqlite3(dbPath);
    sqlite.pragma("foreign_keys = ON");
    const client = drizzle(sqlite);
    const partial = truncatedFolder(4);
    try {
      migrate(client, { migrationsFolder: partial });

      const t = "2026-01-01T00:00:00.000Z";
      sqlite.prepare("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)").run("u1", "ada", t);
      sqlite
        .prepare(
          "INSERT INTO spaces (id, owner_id, name, description, keywords, context, personal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("s1", "u1", "home", "", "", "", 0, t, t);
      const insertBundle = sqlite.prepare(
        "INSERT INTO bundles (id, space_id, name, description, docs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      insertBundle.run("b1", "s1", "legacy", "", "Always set status.", t, t);
      insertBundle.run("b2", "s1", "empty", "", "", t, t);

      migrate(client, { migrationsFolder: MIGRATIONS });

      const docs = sqlite.prepare("SELECT * FROM bundle_docs ORDER BY bundle_id").all() as Record<string, unknown>[];
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({
        bundle_id: "b1",
        name: "instructions",
        content: "Always set status.",
        autoload: 1,
        created_at: t,
        updated_at: t,
      });
      expect(String(docs[0]!.id)).toMatch(/^[0-9a-f-]{36}$/);

      const cols = (sqlite.prepare("PRAGMA table_info(bundles)").all() as { name: string }[]).map((c) => c.name);
      expect(cols).not.toContain("docs");
    } finally {
      sqlite.close();
      rmSync(partial, { recursive: true, force: true });
    }
  });
});
