/**
 * The 0016 step: key scopes. Seeded through journal index 15, then migrated
 * forward on both dialects: every key from before the column is unscoped
 * (scope null), so it authenticates and carries its user's full authority as
 * it always did.
 */
import { expect, it } from "vitest";

import { authenticateKey, listKeysForUser } from "../../src/core/keys.js";
import { hashKey } from "../../src/crypto.js";
import { describeEachAdapter } from "../helpers/adapters.js";

const now = "2026-01-01T00:00:00.000Z";

describeEachAdapter("migration-0016", (adapter) => {
  it("adds a nullable scope column and leaves every existing key unscoped", async () => {
    const db = await adapter.makeFreshDb();
    try {
      await db.migrateTo(15); // through 0015, the head before key scopes
      await db.insertRows("users", [{ id: "u1", name: "ada", created_at: now }]);
      await db.insertRows("access_keys", [
        { id: "k1", user_id: "u1", name: "default", issuer: "sysadmin", key_hash: hashKey("yap_old_key"), created_at: now },
      ]);

      await db.migrate();
      expect(await db.appliedMigrations()).toBe(db.journalLength());
      const rows = await db.client.select().from(db.tables.accessKeys);
      expect(rows[0]).toMatchObject({ id: "k1", scope: null });
      expect(await authenticateKey(db, "yap_old_key")).toEqual({ userId: "u1", keyId: "k1", scope: null });
      expect((await listKeysForUser(db, "u1"))[0]!.scope).toBeNull();
    } finally {
      await db.close();
    }
  });
});
