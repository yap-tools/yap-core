/**
 * The 0009 step: `access_keys.issuer`, who issued a key (`user` | `sysadmin`).
 * Seeded through journal index 8 — the pre-issuer head — then migrated forward
 * on both dialects. Pinned here is the backfill: the one kind of key that was
 * sysadmin-issued before the column existed is the initial key from user
 * creation, recognisable as the key named `default` written at the user's own
 * creation instant. Every other key — including the replacement a rotation of
 * that key produced — reads back as `user`.
 */
import { asc } from "drizzle-orm";
import { expect, it } from "vitest";

import { describeEachAdapter } from "../helpers/adapters.js";

const created = "2026-01-01T00:00:00.000Z";
const later = "2026-02-01T00:00:00.000Z";

describeEachAdapter("migration-0009", (adapter) => {
  it("adds access_keys.issuer and backfills initial keys as sysadmin, the rest as user", async () => {
    const db = await adapter.makeFreshDb();
    try {
      await db.migrateTo(8); // apply through 0008 (the pre-issuer head)
      await db.insertRows("users", [
        { id: "u1", name: "ada", created_at: created },
        { id: "u2", name: "grace", created_at: created },
      ]);
      const key = (id: string, userId: string, name: string, createdAt: string, revokedAt: string | null = null) => ({
        id,
        user_id: userId,
        name,
        key_hash: `hash-${id}`,
        created_at: createdAt,
        revoked_at: revokedAt,
      });
      await db.insertRows("access_keys", [
        key("k1-initial", "u1", "default", created),
        key("k2-minted", "u1", "laptop", later),
        key("k3-initial-rotated", "u2", "default", created, later),
        key("k4-rotation", "u2", "default", later), // what rotating k3 left behind
        key("k5-same-instant", "u2", "other", created), // not named `default`
      ]);

      await db.migrate(); // apply the rest, incl. 0009
      expect(await db.appliedMigrations()).toBe(db.journalLength());

      const { accessKeys } = db.tables;
      const rows = await db.client.select().from(accessKeys).orderBy(asc(accessKeys.id));
      expect(rows.map((r) => [r.id, r.issuer])).toEqual([
        ["k1-initial", "sysadmin"],
        ["k2-minted", "user"],
        ["k3-initial-rotated", "sysadmin"],
        ["k4-rotation", "user"],
        ["k5-same-instant", "user"],
      ]);

      // A row written without an issuer (older code path, raw insert) is a user key.
      await db.insertRows("access_keys", [key("k6-raw", "u1", "raw", later)]);
      const after = await db.client.select().from(accessKeys).orderBy(asc(accessKeys.id));
      expect(after.find((r) => r.id === "k6-raw")!.issuer).toBe("user");
    } finally {
      await db.close();
    }
  });
});
