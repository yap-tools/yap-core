import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";

describeEachAdapter("identity & keys", (adapter) => {
  let app: TestApp;
  let sysadmin: ApiClient;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
  });

  afterAll(async () => {
    await app.stop();
  });

  describe("user provisioning (sysadmin key)", () => {
    it("creates a user with a personal space and a one-time initial key", async () => {
      const res = await sysadmin.post("/v1/users", { name: "Alice" });
      expect(res.status).toBe(201);
      expect(res.body.user.name).toBe("Alice");
      expect(res.body.personalSpaceId).toBeTruthy();
      expect(res.body.initialKey.key).toMatch(/^yap_/);

      const user = apiClient(app.baseUrl, res.body.initialKey.key);
      const spacesRes = await user.get("/v1/spaces");
      expect(spacesRes.status).toBe(200);
      const personal = spacesRes.body.data.find((s: any) => s.personal === 1);
      expect(personal).toBeTruthy();
      expect(personal.id).toBe(res.body.personalSpaceId);
      expect(personal.name).toBe("Personal");
    });

    it("rejects user provisioning without the sysadmin key", async () => {
      const created = await sysadmin.post("/v1/users", { name: "Bob" });
      const user = apiClient(app.baseUrl, created.body.initialKey.key);
      const res = await user.post("/v1/users", { name: "Mallory" });
      expect(res.status).toBe(401);
      const anon = apiClient(app.baseUrl);
      expect((await anon.post("/v1/users", { name: "Mallory" })).status).toBe(401);
    });

    it("lists, gets, and deletes users", async () => {
      const created = await sysadmin.post("/v1/users", { name: "Temp" });
      const id = created.body.user.id;
      expect((await sysadmin.get(`/v1/users/${id}`)).body.name).toBe("Temp");
      const list = await sysadmin.get("/v1/users");
      expect(list.body.data.some((u: any) => u.id === id)).toBe(true);
      expect((await sysadmin.delete(`/v1/users/${id}`)).status).toBe(200);
      expect((await sysadmin.get(`/v1/users/${id}`)).status).toBe(404);
      // The deleted user's key no longer authenticates.
      const ghost = apiClient(app.baseUrl, created.body.initialKey.key);
      expect((await ghost.get("/v1/spaces")).status).toBe(401);
    });

    it("returns the standard error shape", async () => {
      const res = await sysadmin.get("/v1/users/nope");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
      expect(typeof res.body.error.message).toBe("string");
    });
  });

  describe("access keys (self)", () => {
    let key: string;
    let user: ApiClient;

    beforeAll(async () => {
      const created = await sysadmin.post("/v1/users", { name: "KeyHolder" });
      key = created.body.initialKey.key;
      user = apiClient(app.baseUrl, key);
    });

    it("supports multiple active keys per user", async () => {
      const second = await user.post("/v1/keys", { name: "laptop" });
      expect(second.status).toBe(201);
      expect(second.body.key).toMatch(/^yap_/);
      const viaSecond = apiClient(app.baseUrl, second.body.key);
      expect((await viaSecond.get("/v1/keys")).status).toBe(200);
      expect((await user.get("/v1/keys")).status).toBe(200); // original still works
    });

    it("never returns key secrets in listings", async () => {
      const list = await user.get("/v1/keys");
      expect(JSON.stringify(list.body)).not.toContain("yap_");
      expect(list.body.data.every((k: any) => k.key === undefined && k.keyHash === undefined)).toBe(true);
    });

    it("rotation revokes the old key immediately, no grace period", async () => {
      const extra = await user.post("/v1/keys", { name: "rotate-me" });
      const rotated = await user.post(`/v1/keys/${extra.body.id}/rotate`);
      expect(rotated.status).toBe(200);
      expect(rotated.body.key).toMatch(/^yap_/);
      expect(rotated.body.key).not.toBe(extra.body.key);
      const oldClient = apiClient(app.baseUrl, extra.body.key);
      expect((await oldClient.get("/v1/keys")).status).toBe(401);
      const newClient = apiClient(app.baseUrl, rotated.body.key);
      expect((await newClient.get("/v1/keys")).status).toBe(200);
    });

    it("deleting a key revokes it", async () => {
      const extra = await user.post("/v1/keys", { name: "delete-me" });
      await user.delete(`/v1/keys/${extra.body.id}`);
      const deleted = apiClient(app.baseUrl, extra.body.key);
      expect((await deleted.get("/v1/keys")).status).toBe(401);
    });

    it("the sysadmin key is not a user credential on user endpoints", async () => {
      expect((await sysadmin.get("/v1/keys")).status).toBe(401);
      expect((await sysadmin.get("/v1/spaces")).status).toBe(401);
    });
  });

  describe("MCP authentication", () => {
    it("rejects missing and invalid keys, and the sysadmin key, on /mcp", async () => {
      const post = (auth?: string, qs = "") =>
        fetch(`${app.baseUrl}/mcp${qs}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(auth ? { authorization: `Bearer ${auth}` } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        });
      expect((await post()).status).toBe(401);
      expect((await post("yap_invalidinvalidinvalid")).status).toBe(401);
      expect((await post(TEST_SYSADMIN_KEY)).status).toBe(401);
    });

    it("accepts a user key via bearer and via the ?key= fallback", async () => {
      const created = await sysadmin.post("/v1/users", { name: "McpUser" });
      const key = created.body.initialKey.key;
      const post = (auth?: string, qs = "") =>
        fetch(`${app.baseUrl}/mcp${qs}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(auth ? { authorization: `Bearer ${auth}` } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        });
      expect((await post(key)).status).not.toBe(401);
      expect((await post(undefined, `?key=${key}`)).status).not.toBe(401);
    });
  });
});
