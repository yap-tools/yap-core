/**
 * The 0010 step: `users.denied_capabilities`, the per-user deny list of
 * account-level capabilities. Seeded through journal index 9 — the head before
 * the column — then migrated forward on both dialects. Pinned here is the
 * default: every user that existed before the column is unrestricted, and so
 * is a row written without it.
 */
import { asc } from "drizzle-orm";
import { expect, it } from "vitest";

import { getUser, whoami } from "../../src/core/users.js";
import { describeEachAdapter } from "../helpers/adapters.js";

const created = "2026-01-01T00:00:00.000Z";

describeEachAdapter("migration-0010", (adapter) => {
  it("adds users.denied_capabilities; existing users and raw inserts are unrestricted", async () => {
    const db = await adapter.makeFreshDb();
    try {
      await db.migrateTo(9); // apply through 0009 (the head before the column)
      await db.insertRows("users", [
        { id: "u1", name: "ada", external_id: null, created_at: created },
        { id: "u2", name: "grace", external_id: "ext-2", created_at: created },
      ]);

      await db.migrate(); // apply the rest, incl. 0010
      expect(await db.appliedMigrations()).toBe(db.journalLength());

      // A row written without the column (older code path, raw insert).
      await db.insertRows("users", [{ id: "u3", name: "raw", external_id: null, created_at: created }]);

      const { users } = db.tables;
      const rows = await db.client.select().from(users).orderBy(asc(users.id));
      expect(rows.map((r) => [r.id, r.deniedCapabilities])).toEqual([
        ["u1", "[]"],
        ["u2", "[]"],
        ["u3", "[]"],
      ]);
      expect((await getUser(db, "u2")).deniedCapabilities).toEqual([]);
      expect(await whoami(db, "u1")).toEqual({ id: "u1", name: "ada", externalId: null, deniedCapabilities: [] });
    } finally {
      await db.close();
    }
  });
});
