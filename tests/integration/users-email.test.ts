/**
 * A user's email is unique when set: a create or update with an address
 * another user has is a 409 naming the conflict, any number of users may
 * have none, and a repeated create by externalId stays a plain read.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { cmdUserCreate } from "../../src/cli/resources.js";
import { createUser } from "../../src/core/users.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, KEY_LOGIN_ON, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";

describeEachAdapter("users: unique email", (adapter) => {
  let app: TestApp;
  let sysadmin: ApiClient;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
  });

  afterAll(async () => {
    await app.stop();
  });

  it("refuses a second user with a taken email, whatever its case, with a 409 naming the holder", async () => {
    const first = await sysadmin.post("/v1/users", { name: "Ada", email: "ada@example.com" });
    expect(first.status).toBe(201);
    const second = await sysadmin.post("/v1/users", { name: "Ada Two", email: " ADA@example.com" });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({
      code: "conflict",
      message: `email ada@example.com is already used by user ${first.body.user.id}`,
      details: { email: "ada@example.com", userId: first.body.user.id },
    });
    const names = (await sysadmin.get("/v1/users?limit=200")).body.data.map((u: any) => u.name);
    expect(names).not.toContain("Ada Two");
  });

  it("refuses a PATCH to another user's email, and allows setting a user's own again", async () => {
    const holder = (await sysadmin.post("/v1/users", { name: "Bea", email: "bea@example.com" })).body.user;
    const other = (await sysadmin.post("/v1/users", { name: "Cy" })).body.user;
    const taken = await sysadmin.patch(`/v1/users/${other.id}`, { email: "Bea@Example.com" });
    expect(taken.status).toBe(409);
    expect(taken.body.error.details).toEqual({ email: "bea@example.com", userId: holder.id });
    expect((await sysadmin.get(`/v1/users/${other.id}`)).body.email).toBeNull();
    expect((await sysadmin.patch("/v1/users/no-such-user", { email: "bea@example.com" })).status).toBe(404);

    const same = await sysadmin.patch(`/v1/users/${holder.id}`, { email: "BEA@example.com" });
    expect(same.status).toBe(200);
    expect(same.body.email).toBe("bea@example.com");

    // Freed by clearing, the address can move.
    expect((await sysadmin.patch(`/v1/users/${holder.id}`, { email: null })).status).toBe(200);
    expect((await sysadmin.patch(`/v1/users/${other.id}`, { email: "bea@example.com" })).body.email).toBe("bea@example.com");
  });

  it("lets any number of users have no email", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await sysadmin.post("/v1/users", { name: `Nobody ${i}` });
      expect(res.status).toBe(201);
      expect(res.body.user.email).toBeNull();
      expect((await sysadmin.patch(`/v1/users/${res.body.user.id}`, { email: null })).status).toBe(200);
    }
  });

  it("a repeated create by externalId is still a read, even when its email is now someone else's", async () => {
    const made = await sysadmin.post("/v1/users", { name: "Dee", externalId: "ext-dee", email: "dee@example.com" });
    expect(made.status).toBe(201);
    expect((await sysadmin.post("/v1/users", { name: "Dee", externalId: "ext-dee", email: "dee@example.com" })).status).toBe(200);

    await sysadmin.patch(`/v1/users/${made.body.user.id}`, { email: null });
    await sysadmin.post("/v1/users", { name: "Eve", email: "dee@example.com" });
    const repeated = await sysadmin.post("/v1/users", { name: "Dee", externalId: "ext-dee", email: "dee@example.com" });
    expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);
    expect(repeated.body.user).toMatchObject({ id: made.body.user.id, email: null });

    // A new externalId with a taken address is a new user, so it is refused.
    const fresh = await sysadmin.post("/v1/users", { name: "Fay", externalId: "ext-fay", email: "dee@example.com" });
    expect(fresh.status).toBe(409);
  });

  it("concurrent creates with one email yield exactly one user (the unique index decides)", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        createUser(app.db, KEY_LOGIN_ON, { name: `Racer ${i}`, email: "race@example.com" }, { initialKey: false }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "conflict" });
    }
  });

  it("yap user create --email reports the conflict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yap-user-email-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const target = { baseUrl: app.baseUrl, remote: false, userKey: () => "unused", sysKey: () => TEST_SYSADMIN_KEY };
      await cmdUserCreate(target, dir, ["Gus", "--email", "gus@example.com"]);
      await expect(cmdUserCreate(target, dir, ["Gus Two", "--email", "GUS@example.com"])).rejects.toThrow(
        /email gus@example\.com is already used by user/,
      );
    } finally {
      vi.restoreAllMocks();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
