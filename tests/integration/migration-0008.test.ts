/**
 * The 0008 step: `users.external_id`, a nullable correlation id with a unique
 * index. Seeded through journal index 7 — the pre-externalId head — then
 * migrated forward on both dialects. Pinned here: users that existed before
 * the column read back with `externalId: null`, any number of users may leave
 * it null, and a set value is unique per instance.
 */
import { expect, it } from "vitest";

import { describeEachAdapter } from "../helpers/adapters.js";

const now = "2026-01-01T00:00:00.000Z";

describeEachAdapter("migration-0008", (adapter) => {
  it("adds a nullable, unique users.external_id; existing users read back as null", async () => {
    const db = await adapter.makeFreshDb();
    try {
      await db.migrateTo(7); // apply through 0007 (the pre-externalId head)
      await db.insertRows("users", [
        { id: "u1", name: "ada", created_at: now },
        { id: "u2", name: "grace", created_at: now },
      ]);

      await db.migrate(); // apply the rest, incl. 0008
      expect(await db.appliedMigrations()).toBe(db.journalLength());

      const rows = await db.client.select().from(db.tables.users);
      expect(rows.map((r) => r.externalId)).toEqual([null, null]);

      await db.insertRows("users", [{ id: "u3", name: "linus", created_at: now, external_id: "ext-1" }]);
      await expect(
        db.insertRows("users", [{ id: "u4", name: "dup", created_at: now, external_id: "ext-1" }]),
      ).rejects.toThrow();
      expect(await db.client.select().from(db.tables.users)).toHaveLength(3);
    } finally {
      await db.close();
    }
  });
});
