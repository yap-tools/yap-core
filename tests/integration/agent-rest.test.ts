/**
 * Agents over REST: authoring CRUD, secret-free responses, the edit_agents
 * gate and existence-hiding for outsiders, and the file attachment round-trip
 * (upload-request → PUT bytes → complete → list) through the real signed URLs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";

describeEachAdapter("agents REST", (adapter) => {
  let app: TestApp;
  let alice: ApiClient;
  let bob: ApiClient;
  let bobId: string;
  let spaceId: string;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    const b = await sysadmin.post("/v1/users", { name: "Bob" });
    bob = apiClient(app.baseUrl, b.body.initialKey.key);
    bobId = b.body.user.id;
    spaceId = (await alice.post("/v1/spaces", { name: "Agents" })).body.id;
  });

  afterAll(async () => {
    await app.stop();
  });

  describe("authoring", () => {
    it("creates, lists, gets, updates and deletes — never exposing a key", async () => {
      const created = await alice.post(`/v1/spaces/${spaceId}/agents`, {
        name: "summarizer",
        runtime: "mock",
        model: "mock-1",
        args: { topic: "weekly" },
        instructions: "summarize",
      });
      expect(created.status).toBe(201);
      expect(created.body.name).toBe("summarizer");
      expect(created.body.args).toEqual({ topic: "weekly" });
      const blob = JSON.stringify(created.body);
      expect(blob).not.toContain("access_key");
      expect(blob).not.toContain("v1."); // no encrypted key leaked
      const agentId = created.body.id;

      const list = await alice.get(`/v1/spaces/${spaceId}/agents`);
      expect(list.body.data.map((a: any) => a.name)).toContain("summarizer");

      const got = await alice.get(`/v1/agents/${agentId}`);
      expect(got.body.id).toBe(agentId);
      expect(got.body.accessKeyEncrypted).toBeUndefined();

      const patched = await alice.patch(`/v1/agents/${agentId}`, { model: "mock-2", schedule: "0 8 * * *" });
      expect(patched.status).toBe(200);
      expect(patched.body.model).toBe("mock-2");
      expect(patched.body.schedule).toBe("0 8 * * *");

      const deleted = await alice.delete(`/v1/agents/${agentId}`);
      expect(deleted.body.deleted).toBe(true);
      expect((await alice.get(`/v1/agents/${agentId}`)).status).toBe(404);
    });

    it("rejects a non-member: 403 to author, 404 to read (existence hidden)", async () => {
      const created = await alice.post(`/v1/spaces/${spaceId}/agents`, { name: "private", runtime: "mock", model: "m" });
      const agentId = created.body.id;

      const denied = await bob.post(`/v1/spaces/${spaceId}/agents`, { name: "intruder", runtime: "mock", model: "m" });
      expect(denied.status).toBe(403);
      expect(denied.body.error.details.capability).toBe("edit_agents");

      expect((await bob.get(`/v1/agents/${agentId}`)).status).toBe(404);

      // Once Alice grants Bob read standing, the agent becomes visible but
      // still unauthored by him.
      await alice.post(`/v1/spaces/${spaceId}/grants`, { userId: bobId, capabilities: ["read_items"], effect: "allow" });
      expect((await bob.get(`/v1/agents/${agentId}`)).status).toBe(200);
      expect((await bob.patch(`/v1/agents/${agentId}`, { model: "x" })).status).toBe(403);
    });

    it("setting a schedule requires run_agents, not just edit_agents", async () => {
      // Bob can author agents but cannot run them.
      await alice.post(`/v1/spaces/${spaceId}/grants`, { userId: bobId, capabilities: ["edit_agents"], effect: "allow" });
      const noSchedule = await bob.post(`/v1/spaces/${spaceId}/agents`, { name: "bob-plain", runtime: "mock", model: "m" });
      expect(noSchedule.status).toBe(201);

      const withSchedule = await bob.post(`/v1/spaces/${spaceId}/agents`, {
        name: "bob-cron",
        runtime: "mock",
        model: "m",
        schedule: "0 9 * * *",
      });
      expect(withSchedule.status).toBe(403);
      expect(withSchedule.body.error.details.capability).toBe("run_agents");

      // Patching a schedule onto the plain agent is likewise blocked.
      const patched = await bob.patch(`/v1/agents/${noSchedule.body.id}`, { schedule: "0 9 * * *" });
      expect(patched.status).toBe(403);

      // Granting run_agents unblocks it.
      await alice.post(`/v1/spaces/${spaceId}/grants`, { userId: bobId, capabilities: ["run_agents"], effect: "allow" });
      expect((await bob.patch(`/v1/agents/${noSchedule.body.id}`, { schedule: "0 9 * * *" })).status).toBe(200);
    });
  });

  describe("file attachment", () => {
    it("attaches a file through the signed upload URL and lists it", async () => {
      const agentId = (await alice.post(`/v1/spaces/${spaceId}/agents`, { name: "withfiles", runtime: "mock", model: "m" }))
        .body.id;

      const req = await alice.post(`/v1/agents/${agentId}/files/upload-request`, { name: "script.sh" });
      expect(req.status).toBe(201);
      const { upload_url, complete_url, file_id } = req.body;

      const put = await fetch(upload_url, { method: "PUT", body: new TextEncoder().encode("echo hi") });
      expect(put.status).toBe(200);

      const done = await fetch(complete_url, { method: "POST" });
      expect(done.status).toBe(200);

      const files = await alice.get(`/v1/agents/${agentId}/files`);
      expect(files.body.data.map((f: any) => f.id)).toContain(file_id);
      expect(files.body.data.find((f: any) => f.id === file_id).status).toBe("finalized");

      const del = await alice.delete(`/v1/agent-files/${file_id}`);
      expect(del.body.deleted).toBe(true);
    });
  });
});
