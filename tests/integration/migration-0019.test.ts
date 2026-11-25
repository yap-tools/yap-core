/**
 * The 0019 step: users.email becomes unique. Seeded through journal index 18,
 * then migrated forward on both dialects. Shared addresses stop the migration
 * with a message naming them and their users, and nothing is applied; without
 * any, it goes ahead and the index refuses a duplicate from then on.
 *
 * Preflight (db/preflight.ts) runs the same guard against the database on a
 * read-only connection of its own: it reports the shared addresses without
 * migrating or writing anything, also while a writer holds the database.
 */
import { existsSync, readFileSync } from "node:fs";

import BetterSqlite3 from "better-sqlite3";
import { expect, it } from "vitest";

import type { SqliteDbConfig } from "../../src/config.js";
import type { Db } from "../../src/db/index.js";
import { MigrationRefused } from "../../src/db/migrationGuards.js";
import { preflight } from "../../src/db/preflight.js";
import { describeEachAdapter } from "../helpers/adapters.js";

const now = "2026-01-01T00:00:00.000Z";

describeEachAdapter("migration-0019", (adapter) => {
  it("stops on shared emails, names them and their users, and changes nothing", async () => {
    const db = await adapter.makeFreshDb();
    try {
      await db.migrateTo(18); // through 0018, the head before the unique index
      await db.insertRows("users", [
        { id: "u1", name: "a", email: "same@example.com", created_at: now },
        { id: "u2", name: "b", email: "same@example.com", created_at: now },
        { id: "u3", name: "c", email: "other@example.com", created_at: now },
        { id: "u4", name: "d", email: "other@example.com", created_at: now },
        { id: "u5", name: "e", email: "alone@example.com", created_at: now },
        { id: "u6", name: "f", created_at: now },
        { id: "u7", name: "g", created_at: now },
      ]);

      const err = await db.migrate().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(MigrationRefused);
      const message = (err as Error).message;
      expect(message).toContain("migration 0019_unique_user_email cannot be applied");
      expect(message).toContain("other@example.com (users u3, u4)");
      expect(message).toContain("same@example.com (users u1, u2)");
      expect(message).not.toContain("alone@example.com");
      expect(message).toContain("PATCH /v1/users/<id>");
      expect(message).toContain("Nothing was changed.");

      expect(await db.appliedMigrations()).toBe(19);
      const users = await db.snapshotRead((read) => read("users"));
      expect(users.map((u) => [u.id, u.email ?? null]).sort()).toEqual([
        ["u1", "same@example.com"],
        ["u2", "same@example.com"],
        ["u3", "other@example.com"],
        ["u4", "other@example.com"],
        ["u5", "alone@example.com"],
        ["u6", null],
        ["u7", null],
      ]);
      // migrateTo through 0019 is guarded the same way.
      await expect(db.migrateTo(19)).rejects.toBeInstanceOf(MigrationRefused);
      expect(await db.appliedMigrations()).toBe(19);
    } finally {
      await db.close();
    }
  });

  it("goes ahead once the operator clears the duplicates; the index then refuses one", async () => {
    const db = await adapter.makeFreshDb();
    try {
      await db.migrateTo(18);
      await db.insertRows("users", [
        { id: "u1", name: "a", email: "same@example.com", created_at: now },
        { id: "u2", name: "b", email: null, created_at: now },
        { id: "u3", name: "c", email: null, created_at: now },
      ]);

      await db.migrate();
      expect(await db.appliedMigrations()).toBe(db.journalLength());
      await expect(
        db.insertRows("users", [{ id: "u4", name: "d", email: "same@example.com", created_at: now }]),
      ).rejects.toThrow();
      // Many users with no email stay fine.
      await db.insertRows("users", [{ id: "u5", name: "e", email: null, created_at: now }]);
    } finally {
      await db.close();
    }
  });

  it("does not look for emails on a database from before the column", async () => {
    const db = await adapter.makeFreshDb();
    try {
      await db.migrateTo(10);
      await db.insertRows("users", [{ id: "u1", name: "a", created_at: now }]);
      await db.migrate();
      expect(await db.appliedMigrations()).toBe(db.journalLength());
    } finally {
      await db.close();
    }
  });

  it("preflight reports the shared emails and changes nothing", async () => {
    const { db, config } = await adapter.makeFreshDbWithConfig();
    try {
      await seedShared(db);
      const usersBefore = await db.snapshotRead((read) => read("users"));
      const filesBefore = config.dialect === "sqlite" ? sqliteFiles(config) : null;

      const result = await preflight(config);
      expect(result.applied).toBe(19);
      expect(result.shipped).toBe(db.journalLength());
      expect(result.refusals).toHaveLength(1);
      expect(result.refusals[0]).toBeInstanceOf(MigrationRefused);
      expect(result.refusals[0]!.message).toContain("migration 0019_unique_user_email cannot be applied");
      expect(result.refusals[0]!.message).toContain("same@example.com (users u1, u2)");

      // Nothing migrated, nothing written.
      expect(await db.appliedMigrations()).toBe(19);
      expect(await db.snapshotRead((read) => read("users"))).toEqual(usersBefore);
      if (config.dialect === "sqlite") expect(sqliteFiles(config)).toEqual(filesBefore);
    } finally {
      await db.close();
    }
  });

  it("preflight passes on clean data and on an up-to-date database", async () => {
    const { db, config } = await adapter.makeFreshDbWithConfig();
    try {
      await db.migrateTo(18);
      await db.insertRows("users", [{ id: "u1", name: "a", email: "same@example.com", created_at: now }]);
      expect((await preflight(config)).refusals).toEqual([]);
      await db.migrate();
      expect(await preflight(config)).toEqual({ applied: db.journalLength(), shipped: db.journalLength(), refusals: [] });
    } finally {
      await db.close();
    }
  });

  it("preflight on an empty database finds nothing applied and nothing to refuse", async () => {
    const { db, config } = await adapter.makeFreshDbWithConfig();
    try {
      expect(await preflight(config)).toEqual({ applied: 0, shipped: db.journalLength(), refusals: [] });
    } finally {
      await db.close();
    }
  });

  if (adapter.dialect === "sqlite") {
    it("preflight neither blocks on nor disturbs a writer holding the database", async () => {
      const { db, config: sqliteConfig } = (await adapter.makeFreshDbWithConfig()) as { db: Db; config: SqliteDbConfig };
      const writer = new BetterSqlite3(sqliteConfig.path);
      try {
        await seedShared(db);
        // An open write transaction, as a serving instance may hold one.
        writer.exec("BEGIN IMMEDIATE");
        writer.prepare("INSERT INTO users (id, name, email, created_at) VALUES ('u3', 'c', 'same@example.com', ?)").run(now);

        const started = Date.now();
        const result = await preflight(sqliteConfig);
        expect(Date.now() - started).toBeLessThan(1500); // did not wait out the busy timeout
        // It reads the last committed snapshot: the uncommitted row is not in it.
        expect(result.refusals[0]!.message).toContain("same@example.com (users u1, u2)");

        writer.exec("COMMIT"); // the writer was not disturbed
        expect((await preflight(sqliteConfig)).refusals[0]!.message).toContain("(users u1, u2, u3)");
      } finally {
        writer.close();
        await db.close();
      }
    });

    it("preflight does not create a database file that is not there", async () => {
      const { db, config } = await adapter.makeFreshDbWithConfig();
      await db.close();
      const missing = { dialect: "sqlite" as const, path: `${(config as SqliteDbConfig).path}.absent` };
      expect((await preflight(missing)).applied).toBe(0);
      expect(existsSync(missing.path)).toBe(false);
    });
  }
});

/** Through 0018, with two users sharing an address. */
async function seedShared(db: Db): Promise<void> {
  await db.migrateTo(18);
  await db.insertRows("users", [
    { id: "u1", name: "a", email: "same@example.com", created_at: now },
    { id: "u2", name: "b", email: "same@example.com", created_at: now },
  ]);
}

/** The SQLite database file and its WAL sidecar, byte for byte. */
function sqliteFiles(config: SqliteDbConfig): Record<string, string | null> {
  const read = (p: string): string | null => (existsSync(p) ? readFileSync(p).toString("base64") : null);
  return { db: read(config.path), wal: read(`${config.path}-wal`) };
}
