/**
 * Agent file attachment: reserve → upload (single-use) → complete, listing,
 * worker staging, deletion, and the edit_agents gate.
 */
import { afterAll, beforeAll, expect, it } from "vitest";

import * as agentFiles from "../../src/core/agentFiles.js";
import * as agents from "../../src/core/agents.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";

describeEachAdapter("agent files", (adapter) => {
  let app: TestApp;
  let env: agentFiles.AgentFileEnv;
  let agentEnv: agents.AgentEnv;
  let aliceId: string;
  let bobId: string;
  let agentId: string;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    env = { db: app.db, blob: app.blob, config: app.config };
    agentEnv = { db: app.db, config: app.config };
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    aliceId = a.body.user.id;
    const alice = apiClient(app.baseUrl, a.body.initialKey.key);
    bobId = (await sysadmin.post("/v1/users", { name: "Bob" })).body.user.id;
    const spaceId = (await alice.post("/v1/spaces", { name: "Files" })).body.id;
    agentId = (await agents.createAgent(agentEnv, aliceId, spaceId, { name: "filer", runtime: "mock", model: "m" })).id;
  });

  afterAll(async () => {
    await app.stop();
  });

  it("runs the reserve → upload → complete lifecycle and stages finalized files", async () => {
    const req = await agentFiles.requestAgentUpload(env, aliceId, agentId, { name: "data.txt" });
    expect(req.file_id).toBeTruthy();
    expect(req.upload_url).toBeTruthy();
    expect(req.complete_url).toContain(`/v1/agent-files/${req.file_id}/complete`);

    const bytes = new TextEncoder().encode("hello agent");
    const stored = await agentFiles.storeAgentUploadedBytes(env, req.file_id, bytes);
    expect(stored.size).toBe(bytes.byteLength);

    // Upload link is single-use.
    await expect(agentFiles.storeAgentUploadedBytes(env, req.file_id, bytes)).rejects.toThrow(/single-use|no longer open/);

    const finalized = await agentFiles.completeAgentUpload(env, aliceId, req.file_id);
    expect(finalized.status).toBe("finalized");
    expect(finalized.size).toBe(bytes.byteLength);

    const list = await agentFiles.listAgentFiles(app.db, aliceId, agentId);
    expect(list.map((f) => f.name)).toContain("data.txt");

    const staged = await agentFiles.listFinalizedAgentFiles(app.db, agentId);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.storageKey).toContain(`agents/${agentId}/`);
  });

  it("deletes a file and its bytes", async () => {
    const req = await agentFiles.requestAgentUpload(env, aliceId, agentId, { name: "gone.txt" });
    await agentFiles.storeAgentUploadedBytes(env, req.file_id, new TextEncoder().encode("x"));
    await agentFiles.completeAgentUpload(env, aliceId, req.file_id);
    const staged = await agentFiles.listFinalizedAgentFiles(app.db, agentId);
    const storageKey = staged.find((f) => f.name === "gone.txt")!.storageKey;
    expect(await app.blob.stat(storageKey)).not.toBeNull();

    await agentFiles.deleteAgentFile(env, aliceId, req.file_id);
    expect(await app.blob.stat(storageKey)).toBeNull(); // bytes removed
    const list = await agentFiles.listAgentFiles(app.db, aliceId, agentId);
    expect(list.map((f) => f.name)).not.toContain("gone.txt");
  });

  it("requires edit_agents to attach", async () => {
    await expect(agentFiles.requestAgentUpload(env, bobId, agentId, { name: "x.txt" })).rejects.toThrow(
      /not found|agent|edit_agents/i,
    );
  });
});
