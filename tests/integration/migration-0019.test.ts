/**
 * The 0019 step: users.email becomes unique. Seeded through journal index 18,
 * then migrated forward on both dialects. Shared addresses stop the migration
 * with a message naming them and their users, and nothing is applied; without
 * any, it goes ahead and the index refuses a duplicate from then on.
 */
import { expect, it } from "vitest";

import { MigrationRefused } from "../../src/db/migrationGuards.js";
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
});
