/**
 * The 0017 step: provider login. Seeded through journal index 16, then
 * migrated forward on both dialects. Existing grants keep their key and their
 * tokens (SQLite rebuilds oauth_codes and oauth_grants to make key_id
 * nullable, which must not cascade into oauth_tokens), still die with their
 * key, and have no end of their own; users get a null email; the new tables
 * start empty.
 */
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";

import { authenticateToken } from "../../src/core/oauth.js";
import { hashKey } from "../../src/crypto.js";
import { describeEachAdapter } from "../helpers/adapters.js";

const now = "2026-01-01T00:00:00.000Z";
const later = "2099-01-01T00:00:00.000Z";

describeEachAdapter("migration-0017", (adapter) => {
  it("keeps existing grants, their tokens and their key binding; adds the provider-login columns and tables", async () => {
    const db = await adapter.makeFreshDb();
    try {
      await db.migrateTo(16); // through 0016, the head before provider login
      await db.insertRows("users", [{ id: "u1", name: "ada", created_at: now }]);
      await db.insertRows("access_keys", [
        { id: "k1", user_id: "u1", name: "default", issuer: "sysadmin", key_hash: hashKey("yap_k1"), created_at: now },
      ]);
      await db.insertRows("oauth_clients", [{ id: "c1", name: "App", redirect_uris: '["https://app.example/cb"]', created_at: now }]);
      await db.insertRows("oauth_codes", [
        {
          id: "code1",
          code_hash: "h",
          client_id: "c1",
          user_id: "u1",
          key_id: "k1",
          scope: '{"role":"member"}',
          code_challenge: "x",
          redirect_uri: "https://app.example/cb",
          expires_at: later,
        },
      ]);
      await db.insertRows("oauth_grants", [
        { id: "g1", user_id: "u1", key_id: "k1", client_id: "c1", scope: '{"role":"member"}', created_at: now, last_used_at: now },
      ]);
      await db.insertRows("oauth_tokens", [
        { id: "t1", token_hash: hashKey("yap_at_old"), grant_id: "g1", kind: "access", expires_at: later },
      ]);

      await db.migrate();
      expect(await db.appliedMigrations()).toBe(db.journalLength());

      const { users, oauthGrants, oauthCodes, oauthTokens, userIdentities, oidcTransactions, accessKeys } = db.tables;
      expect((await db.client.select().from(users))[0]).toMatchObject({ id: "u1", email: null });
      expect(await db.client.select().from(oauthGrants)).toMatchObject([{ id: "g1", keyId: "k1", expiresAt: null }]);
      expect(await db.client.select().from(oauthCodes)).toMatchObject([{ id: "code1", keyId: "k1", grantExpiresAt: null }]);
      expect(await db.client.select().from(oauthTokens)).toHaveLength(1);
      expect(await authenticateToken(db, "yap_at_old")).toMatchObject({ userId: "u1", grantId: "g1" });
      expect(await db.client.select().from(userIdentities)).toEqual([]);
      expect(await db.client.select().from(oidcTransactions)).toEqual([]);

      // key_id is nullable now, and a key-backed grant still dies with its key.
      await db.client.insert(oauthGrants).values({
        id: "g2",
        userId: "u1",
        keyId: null,
        clientId: "c1",
        scope: '{"role":"member"}',
        createdAt: now,
        lastUsedAt: now,
        expiresAt: later,
      });
      await db.client.delete(accessKeys).where(eq(accessKeys.id, "k1"));
      expect((await db.client.select().from(oauthGrants)).map((g) => g.id)).toEqual(["g2"]);
      expect(await db.client.select().from(oauthTokens)).toEqual([]);
      expect(await db.client.select().from(oauthCodes)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
