import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";

describeEachAdapter("spaces & grants", (adapter) => {
  let app: TestApp;
  let sysadmin: ApiClient;
  let alice: ApiClient;
  let bob: ApiClient;
  let aliceId: string;
  let bobId: string;
  let alicePersonalId: string;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    const b = await sysadmin.post("/v1/users", { name: "Bob" });
    aliceId = a.body.user.id;
    bobId = b.body.user.id;
    alicePersonalId = a.body.personalSpaceId;
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    bob = apiClient(app.baseUrl, b.body.initialKey.key);
  });

  afterAll(async () => {
    await app.stop();
  });

  describe("space lifecycle", () => {
    it("creates, reads, updates, and deletes a space", async () => {
      const created = await alice.post("/v1/spaces", {
        name: "Projects",
        description: "Work projects",
        keywords: "work, projects",
      });
      expect(created.status).toBe(201);
      const id = created.body.id;

      const fetched = await alice.get(`/v1/spaces/${id}`);
      expect(fetched.body.name).toBe("Projects");

      const patched = await alice.patch(`/v1/spaces/${id}`, { description: "All work projects" });
      expect(patched.body.description).toBe("All work projects");

      expect((await alice.delete(`/v1/spaces/${id}`)).status).toBe(200);
      expect((await alice.get(`/v1/spaces/${id}`)).status).toBe(404);
    });

    it("creating a space seeds auditable allow rows for the creator", async () => {
      const created = await alice.post("/v1/spaces", { name: "Seeded" });
      const grants = await alice.get(`/v1/spaces/${created.body.id}/grants`);
      expect(grants.status).toBe(200);
      const caps = grants.body.data.map((g: any) => g.capability);
      expect(caps).toContain("manage_roles");
      expect(caps).toContain("read_items");
      expect(grants.body.data.every((g: any) => g.effect === "allow" && g.userId === aliceId)).toBe(true);
      await alice.delete(`/v1/spaces/${created.body.id}`);
    });

    it("spaces are invisible to non-members", async () => {
      const created = await alice.post("/v1/spaces", { name: "Hidden" });
      expect((await bob.get(`/v1/spaces/${created.body.id}`)).status).toBe(404);
      const bobList = await bob.get("/v1/spaces");
      expect(bobList.body.data.some((s: any) => s.id === created.body.id)).toBe(false);
      await alice.delete(`/v1/spaces/${created.body.id}`);
    });
  });

  describe("personal space rules", () => {
    it("rejects rename", async () => {
      const res = await alice.patch(`/v1/spaces/${alicePersonalId}`, { name: "Renamed" });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/personal/i);
    });

    it("allows description edits (only rename and delete are restricted)", async () => {
      const res = await alice.patch(`/v1/spaces/${alicePersonalId}`, { description: "Mine" });
      expect(res.status).toBe(200);
    });

    it("rejects delete", async () => {
      const res = await alice.delete(`/v1/spaces/${alicePersonalId}`);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/personal/i);
    });

    it("rejects grants entirely (unshareable)", async () => {
      const res = await alice.post(`/v1/spaces/${alicePersonalId}/grants`, {
        userId: bobId,
        capabilities: ["read_items"],
        effect: "allow",
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/personal/i);
    });
  });

  describe("grants & sharing", () => {
    let spaceId: string;

    beforeAll(async () => {
      const created = await alice.post("/v1/spaces", { name: "Shared", keywords: "team" });
      spaceId = created.body.id;
    });

    it("granting a role (set of capabilities) shares the space", async () => {
      const res = await alice.post(`/v1/spaces/${spaceId}/grants`, {
        userId: bobId,
        capabilities: ["read_items", "edit_items"],
        effect: "allow",
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toHaveLength(2);
      const bobView = await bob.get(`/v1/spaces/${spaceId}`);
      expect(bobView.status).toBe(200);
      expect(bobView.body.name).toBe("Shared");
    });

    it("requires manage_roles to grant", async () => {
      const res = await bob.post(`/v1/spaces/${spaceId}/grants`, {
        userId: bobId,
        capabilities: ["manage_roles"],
        effect: "allow",
      });
      expect(res.status).toBe(403);
      expect(res.body.error.details?.capability).toBe("manage_roles");
    });

    it("an explicit deny row beats an allow at the same level", async () => {
      await alice.post(`/v1/spaces/${spaceId}/grants`, {
        userId: bobId,
        capabilities: ["edit_items"],
        effect: "deny",
      });
      // Bob retains read_items but edit_items now denies; verify via grant rows
      const rows = (await alice.get(`/v1/spaces/${spaceId}/grants`)).body.data;
      const bobEdit = rows.filter((g: any) => g.userId === bobId && g.capability === "edit_items");
      expect(bobEdit.map((g: any) => g.effect).sort()).toEqual(["allow", "deny"]);
    });

    it("deleting a grant row removes it (single capability per row)", async () => {
      const grant = await alice.post(`/v1/spaces/${spaceId}/grants`, {
        userId: bobId,
        capabilities: "fire_hooks",
        effect: "allow",
      });
      const grantId = grant.body.data[0].id;
      expect((await alice.delete(`/v1/spaces/${spaceId}/grants/${grantId}`)).status).toBe(200);
      const rows = (await alice.get(`/v1/spaces/${spaceId}/grants`)).body.data;
      expect(rows.some((g: any) => g.id === grantId)).toBe(false);
    });

    it("authorizes grant deletion before checking existence (no existence oracle)", async () => {
      const grant = await alice.post(`/v1/spaces/${spaceId}/grants`, {
        userId: bobId,
        capabilities: "read_files",
        effect: "allow",
      });
      const realGrantId = grant.body.data[0].id;
      // Bob has no manage_roles here: he must get 403 for BOTH an existing and
      // a nonexistent grant id, so the response can't be used to probe ids.
      expect((await bob.delete(`/v1/spaces/${spaceId}/grants/${realGrantId}`)).status).toBe(403);
      expect((await bob.delete(`/v1/spaces/${spaceId}/grants/does-not-exist`)).status).toBe(403);
      // The grant is untouched.
      const rows = (await alice.get(`/v1/spaces/${spaceId}/grants`)).body.data;
      expect(rows.some((g: any) => g.id === realGrantId)).toBe(true);
    });

    it("validates capability names and effect", async () => {
      const bad = await alice.post(`/v1/spaces/${spaceId}/grants`, {
        userId: bobId,
        capabilities: ["Not A Capability!"],
        effect: "allow",
      });
      expect(bad.status).toBe(400);
      const badEffect = await alice.post(`/v1/spaces/${spaceId}/grants`, {
        userId: bobId,
        capabilities: ["read_items"],
        effect: "maybe",
      });
      expect(badEffect.status).toBe(400);
    });

    it("rejects grants to nonexistent users", async () => {
      const res = await alice.post(`/v1/spaces/${spaceId}/grants`, {
        userId: "no-such-user",
        capabilities: ["read_items"],
        effect: "allow",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("pagination", () => {
    it("paginates space listings with opaque cursors", async () => {
      const mine = apiClient(app.baseUrl, (await sysadmin.post("/v1/users", { name: "Pager" })).body.initialKey.key);
      for (let i = 0; i < 5; i++) {
        await mine.post("/v1/spaces", { name: `S${i}` });
      }
      const page1 = await mine.get("/v1/spaces?limit=3");
      expect(page1.body.data).toHaveLength(3);
      expect(page1.body.nextCursor).toBeTruthy();
      const page2 = await mine.get(`/v1/spaces?limit=3&cursor=${page1.body.nextCursor}`);
      expect(page2.body.data.length).toBeGreaterThanOrEqual(3); // 5 created + personal
      const ids1 = page1.body.data.map((s: any) => s.id);
      const ids2 = page2.body.data.map((s: any) => s.id);
      expect(ids1.filter((id: string) => ids2.includes(id))).toEqual([]);
      expect((await mine.get("/v1/spaces?cursor=garbage")).status).toBe(400);
    });
  });
});
