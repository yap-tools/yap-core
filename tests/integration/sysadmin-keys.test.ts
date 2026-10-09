/**
 * The sysadmin key lane: `/v1/users/:id/keys` lets the operator issue, list
 * and revoke access keys for any user. A key records who issued it (`issuer`:
 * `user` or `sysadmin`) and is otherwise an ordinary key — full authority as
 * that user, visible in the user's own list, rotatable and revocable by them.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";

describeEachAdapter("sysadmin key lane", (adapter) => {
  let app: TestApp;
  let sysadmin: ApiClient;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
  });

  afterAll(async () => {
    await app.stop();
  });

  async function newUser(name: string): Promise<{ id: string; initialKeyId: string; client: ApiClient }> {
    const created = await sysadmin.post("/v1/users", { name });
    expect(created.status).toBe(201);
    return {
      id: created.body.user.id,
      initialKeyId: created.body.initialKey.id,
      client: apiClient(app.baseUrl, created.body.initialKey.key),
    };
  }

  it("issues a key for another user: raw key once, only the hash stored, full authority as that user", async () => {
    const user = await newUser("Issued");
    const issued = await sysadmin.post(`/v1/users/${user.id}/keys`, { name: "recovery" });
    expect(issued.status).toBe(201);
    expect(issued.body).toEqual({
      id: expect.any(String),
      name: "recovery",
      issuer: "sysadmin",
      createdAt: expect.any(String),
      key: expect.stringMatching(/^yap_/),
    });

    const { accessKeys } = app.db.tables;
    const stored = (await app.db.client.select().from(accessKeys).where(eq(accessKeys.id, issued.body.id)))[0]!;
    expect(stored.userId).toBe(user.id);
    expect(stored.issuer).toBe("sysadmin");
    expect(JSON.stringify(stored)).not.toContain(issued.body.key);

    const viaIssued = apiClient(app.baseUrl, issued.body.key);
    expect((await viaIssued.get("/v1/whoami")).body.id).toBe(user.id);
    expect((await viaIssued.post("/v1/spaces", { name: "Mine" })).status).toBe(201);
  });

  it("the name is optional, and so is the body", async () => {
    const user = await newUser("Unnamed");
    const bare = await sysadmin.post(`/v1/users/${user.id}/keys`);
    expect(bare.status).toBe(201);
    expect(bare.body.name).toBe("");
    const empty = await sysadmin.post(`/v1/users/${user.id}/keys`, {});
    expect(empty.status).toBe(201);
    expect(empty.body.name).toBe("");
    expect((await sysadmin.post(`/v1/users/${user.id}/keys`, { name: 7 })).status).toBe(400);
  });

  it("lists a user's keys as metadata only, never the raw key or its hash", async () => {
    const user = await newUser("Listed");
    const issued = await sysadmin.post(`/v1/users/${user.id}/keys`, { name: "ops" });
    const minted = await user.client.post("/v1/keys", { name: "laptop" });

    const list = await sysadmin.get(`/v1/users/${user.id}/keys`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(3);
    expect(list.body.data).toEqual(
      expect.arrayContaining([
        { id: user.initialKeyId, name: "default", issuer: "sysadmin", createdAt: expect.any(String) },
        { id: issued.body.id, name: "ops", issuer: "sysadmin", createdAt: expect.any(String) },
        { id: minted.body.id, name: "laptop", issuer: "user", createdAt: expect.any(String) },
      ]),
    );
    const raw = JSON.stringify(list.body);
    expect(raw).not.toContain("yap_");
    expect(raw).not.toContain("keyHash");
    const { accessKeys } = app.db.tables;
    for (const row of await app.db.client.select().from(accessKeys).where(eq(accessKeys.userId, user.id))) {
      expect(raw).not.toContain(row.keyHash);
    }
  });

  it("the user sees sysadmin-issued and self-minted keys alike, each with its issuer and name", async () => {
    const user = await newUser("Seeing");
    const issued = await sysadmin.post(`/v1/users/${user.id}/keys`, { name: "ops" });
    const minted = await user.client.post("/v1/keys", { name: "laptop" });
    expect(minted.body.issuer).toBe("user");

    const own = await user.client.get("/v1/keys");
    expect(own.status).toBe(200);
    expect(own.body.data).toHaveLength(3);
    const byId = new Map<string, any>(own.body.data.map((k: any) => [k.id, k]));
    expect(byId.get(user.initialKeyId)).toMatchObject({ name: "default", issuer: "sysadmin" });
    expect(byId.get(issued.body.id)).toMatchObject({ name: "ops", issuer: "sysadmin" });
    expect(byId.get(minted.body.id)).toMatchObject({ name: "laptop", issuer: "user" });
    expect(own.body).toEqual((await sysadmin.get(`/v1/users/${user.id}/keys`)).body);
  });

  it("revokes a user's key: it stops authenticating and leaves both lists", async () => {
    const user = await newUser("Revoked");
    const minted = await user.client.post("/v1/keys", { name: "compromised" });
    const viaMinted = apiClient(app.baseUrl, minted.body.key);
    expect((await viaMinted.get("/v1/whoami")).status).toBe(200);

    const revoked = await sysadmin.delete(`/v1/users/${user.id}/keys/${minted.body.id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ deleted: true });

    expect((await viaMinted.get("/v1/whoami")).status).toBe(401);
    const ids = (await sysadmin.get(`/v1/users/${user.id}/keys`)).body.data.map((k: any) => k.id);
    expect(ids).toEqual([user.initialKeyId]);
    expect((await user.client.get("/v1/keys")).body.data.map((k: any) => k.id)).toEqual([user.initialKeyId]);

    // Already revoked: gone, like the user's own DELETE /v1/keys/:id.
    expect((await sysadmin.delete(`/v1/users/${user.id}/keys/${minted.body.id}`)).status).toBe(404);
  });

  it("can revoke every key and then issue a new one: a locked-out user is reachable again", async () => {
    const user = await newUser("LockedOut");
    expect((await sysadmin.delete(`/v1/users/${user.id}/keys/${user.initialKeyId}`)).status).toBe(200);
    expect((await user.client.get("/v1/whoami")).status).toBe(401);
    expect((await sysadmin.get(`/v1/users/${user.id}/keys`)).body.data).toEqual([]);

    const issued = await sysadmin.post(`/v1/users/${user.id}/keys`, { name: "recovery" });
    expect((await apiClient(app.baseUrl, issued.body.key).get("/v1/whoami")).body.id).toBe(user.id);
  });

  it("a key id is only reachable under the user who holds it", async () => {
    const a = await newUser("A");
    const b = await newUser("B");
    const res = await sysadmin.delete(`/v1/users/${b.id}/keys/${a.initialKeyId}`);
    expect(res.status).toBe(404);
    expect((await a.client.get("/v1/whoami")).status).toBe(200);
  });

  it("404s for a user that does not exist", async () => {
    expect((await sysadmin.post("/v1/users/nope/keys", { name: "x" })).status).toBe(404);
    expect((await sysadmin.get("/v1/users/nope/keys")).status).toBe(404);
    expect((await sysadmin.delete("/v1/users/nope/keys/also-nope")).status).toBe(404);
  });

  it("a sysadmin-issued key is an ordinary key: the user can rotate and revoke it", async () => {
    const user = await newUser("Ordinary");
    const issued = await sysadmin.post(`/v1/users/${user.id}/keys`, { name: "ops" });

    // Rotation is the user's act: the replacement keeps the name, issuer is `user`.
    const rotated = await user.client.post(`/v1/keys/${issued.body.id}/rotate`);
    expect(rotated.status).toBe(200);
    expect(rotated.body).toMatchObject({ name: "ops", issuer: "user" });
    expect(rotated.body.key).toMatch(/^yap_/);
    expect((await apiClient(app.baseUrl, issued.body.key).get("/v1/whoami")).status).toBe(401);

    const again = await sysadmin.post(`/v1/users/${user.id}/keys`, { name: "ops-2" });
    expect((await user.client.delete(`/v1/keys/${again.body.id}`)).status).toBe(200);
    expect((await apiClient(app.baseUrl, again.body.key).get("/v1/whoami")).status).toBe(401);
  });

  it("rotating the initial key yields a `user` key named as before", async () => {
    const user = await newUser("Rotator");
    const rotated = await user.client.post(`/v1/keys/${user.initialKeyId}/rotate`);
    expect(rotated.body).toMatchObject({ name: "default", issuer: "user" });
  });

  it("rejects every caller but the sysadmin key", async () => {
    const user = await newUser("Caller");
    const other = await newUser("Other");
    const callers: ApiClient[] = [
      apiClient(app.baseUrl), // no credential
      apiClient(app.baseUrl, "yap_invalidinvalidinvalid"),
      user.client, // the user themself
      other.client, // another user
    ];
    for (const caller of callers) {
      expect((await caller.post(`/v1/users/${user.id}/keys`, { name: "x" })).status).toBe(401);
      expect((await caller.get(`/v1/users/${user.id}/keys`)).status).toBe(401);
      expect((await caller.delete(`/v1/users/${user.id}/keys/${user.initialKeyId}`)).status).toBe(401);
    }
    // Nothing was issued or revoked along the way.
    const list = await sysadmin.get(`/v1/users/${user.id}/keys`);
    expect(list.body.data.map((k: any) => k.id)).toEqual([user.initialKeyId]);
  });

  it("revoking a key through the lane revokes the OAuth grants it authorized", async () => {
    const user = await newUser("Granted");
    const { oauthClients, oauthGrants } = app.db.tables;
    const now = new Date().toISOString();
    await app.db.client
      .insert(oauthClients)
      .values({ id: `client-${user.id}`, name: "App", redirectUris: "[]", createdAt: now });
    await app.db.client.insert(oauthGrants).values({
      id: `grant-${user.id}`,
      userId: user.id,
      keyId: user.initialKeyId,
      clientId: `client-${user.id}`,
      scope: JSON.stringify({ role: "member" }),
      createdAt: now,
      lastUsedAt: now,
    });

    expect((await sysadmin.delete(`/v1/users/${user.id}/keys/${user.initialKeyId}`)).status).toBe(200);
    expect(await app.db.client.select().from(oauthGrants).where(eq(oauthGrants.userId, user.id))).toEqual([]);
  });
});
