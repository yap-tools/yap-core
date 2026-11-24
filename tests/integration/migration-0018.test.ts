/**
 * The 0018 step: users.provider_login_only. Seeded through journal index 17,
 * then migrated forward on both dialects: every user from before the column
 * keeps key login, so their keys authenticate as they always did.
 */
import { expect, it } from "vitest";

import { authenticateKey } from "../../src/core/keys.js";
import { getUser } from "../../src/core/users.js";
import { hashKey } from "../../src/crypto.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { KEY_LOGIN_ON } from "../helpers/app.js";

const now = "2026-01-01T00:00:00.000Z";

describeEachAdapter("migration-0018", (adapter) => {
  it("adds provider_login_only, off for every existing user", async () => {
    const db = await adapter.makeFreshDb();
    try {
      await db.migrateTo(17); // through 0017, the head before the flag
      await db.insertRows("users", [{ id: "u1", name: "ada", created_at: now }]);
      await db.insertRows("access_keys", [
        { id: "k1", user_id: "u1", name: "default", issuer: "sysadmin", key_hash: hashKey("yap_old_key"), created_at: now },
      ]);

      await db.migrate();
      expect(await db.appliedMigrations()).toBe(db.journalLength());
      expect((await getUser(db, "u1")).providerLoginOnly).toBe(false);
      expect(await authenticateKey(db, KEY_LOGIN_ON, "yap_old_key")).toMatchObject({ ok: true, userId: "u1", keyId: "k1" });
    } finally {
      await db.close();
    }
  });
});
