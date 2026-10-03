/**
 * `externalId` on users: an optional, unique, immutable correlation id a
 * provisioning client supplies so `POST /v1/users` can be retried safely. A
 * repeated create is a pure read — 200, the existing user, no key, no rows.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";

describeEachAdapter("users: externalId", (adapter) => {
  let app: TestApp;
  let sysadmin: ApiClient;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
  });

  afterAll(async () => {
    await app.stop();
  });

  async function rowCounts(): Promise<{ users: number; spaces: number; keys: number }> {
    const { users, spaces, accessKeys } = app.db.tables;
    return {
      users: (await app.db.client.select().from(users)).length,
      spaces: (await app.db.client.select().from(spaces)).length,
      keys: (await app.db.client.select().from(accessKeys)).length,
    };
  }

  it("creates a user without an externalId and reports it as null", async () => {
    const res = await sysadmin.post("/v1/users", { name: "Plain" });
    expect(res.status).toBe(201);
    expect(res.body.user.externalId).toBeNull();
    expect(res.body.initialKey.key).toMatch(/^yap_/);

    // No externalId means no idempotency: a second call is a second user.
    const again = await sysadmin.post("/v1/users", { name: "Plain" });
    expect(again.status).toBe(201);
    expect(again.body.user.id).not.toBe(res.body.user.id);
  });

  it("creates a user with an externalId and returns it on every representation", async () => {
    const res = await sysadmin.post("/v1/users", { name: "Ada", externalId: "ext-ada" });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ name: "Ada", externalId: "ext-ada" });
    expect(res.body.personalSpaceId).toBeTruthy();
    expect(res.body.initialKey.key).toMatch(/^yap_/);

    const id = res.body.user.id;
    expect((await sysadmin.get(`/v1/users/${id}`)).body.externalId).toBe("ext-ada");
    const list = await sysadmin.get("/v1/users");
    expect(list.body.data.find((u: any) => u.id === id).externalId).toBe("ext-ada");
  });

  it("a repeated create returns 200 with the existing user, no key, and no new rows", async () => {
    const first = await sysadmin.post("/v1/users", { name: "Grace", externalId: "ext-grace" });
    expect(first.status).toBe(201);
    const before = await rowCounts();

    const again = await sysadmin.post("/v1/users", { name: "Someone Else", externalId: "ext-grace" });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ user: first.body.user, personalSpaceId: first.body.personalSpaceId });
    expect(again.body.user.name).toBe("Grace"); // a different name is ignored
    expect(again.body).not.toHaveProperty("initialKey");
    expect(await rowCounts()).toEqual(before);

    // The key from the first call is untouched by the retry.
    const user = apiClient(app.baseUrl, first.body.initialKey.key);
    expect((await user.get("/v1/whoami")).status).toBe(200);
  });

  it("looks a user up by externalId, or returns an empty list", async () => {
    const created = await sysadmin.post("/v1/users", { name: "Linus", externalId: "ext-linus" });

    const hit = await sysadmin.get("/v1/users?externalId=ext-linus");
    expect(hit.status).toBe(200);
    expect(hit.body.data).toEqual([created.body.user]);
    expect(hit.body.nextCursor).toBeNull();

    const miss = await sysadmin.get("/v1/users?externalId=nobody");
    expect(miss.status).toBe(200);
    expect(miss.body.data).toEqual([]);
  });

  it("treats the externalId as opaque: exact match, any characters", async () => {
    const odd = "crm:tenant/42?x=1&y= z";
    const created = await sysadmin.post("/v1/users", { name: "Odd", externalId: odd });
    expect(created.status).toBe(201);
    const hit = await sysadmin.get(`/v1/users?externalId=${encodeURIComponent(odd)}`);
    expect(hit.body.data.map((u: any) => u.id)).toEqual([created.body.user.id]);
    expect((await sysadmin.get("/v1/users?externalId=CRM%3Atenant%2F42%3Fx%3D1%26y%3D%20z")).body.data).toEqual([]);
  });

  it("rejects an empty or oversized externalId", async () => {
    expect((await sysadmin.post("/v1/users", { name: "X", externalId: "" })).status).toBe(400);
    expect((await sysadmin.post("/v1/users", { name: "X", externalId: "x".repeat(256) })).status).toBe(400);
    expect((await sysadmin.post("/v1/users", { name: "X", externalId: 42 })).status).toBe(400);
    expect((await sysadmin.get("/v1/users?externalId=")).status).toBe(400);
  });

  it("keeps the lookup and the idempotent create behind the sysadmin key", async () => {
    const created = await sysadmin.post("/v1/users", { name: "Eve", externalId: "ext-eve" });
    const user = apiClient(app.baseUrl, created.body.initialKey.key);
    expect((await user.get("/v1/users?externalId=ext-eve")).status).toBe(401);
    expect((await user.post("/v1/users", { name: "Eve", externalId: "ext-eve" })).status).toBe(401);
    expect((await apiClient(app.baseUrl).get("/v1/users?externalId=ext-eve")).status).toBe(401);
  });

  it("frees the externalId when the user is deleted", async () => {
    const first = await sysadmin.post("/v1/users", { name: "Temp", externalId: "ext-temp" });
    expect((await sysadmin.delete(`/v1/users/${first.body.user.id}`)).status).toBe(200);
    const second = await sysadmin.post("/v1/users", { name: "Temp", externalId: "ext-temp" });
    expect(second.status).toBe(201);
    expect(second.body.user.id).not.toBe(first.body.user.id);
  });

  it("concurrent creates with the same externalId yield exactly one user", async () => {
    const before = await rowCounts();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => sysadmin.post("/v1/users", { name: `Racer ${i}`, externalId: "ext-race" })),
    );

    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.user.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.body.personalSpaceId)).size).toBe(1);
    expect(results.filter((r) => r.body.initialKey)).toHaveLength(1);

    const after = await rowCounts();
    expect(after).toEqual({ users: before.users + 1, spaces: before.spaces + 1, keys: before.keys + 1 });
    const { users } = app.db.tables;
    expect(await app.db.client.select().from(users).where(eq(users.externalId, "ext-race"))).toHaveLength(1);
  });
});
