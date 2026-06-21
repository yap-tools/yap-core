/**
 * Agents core: space-scoped CRUD, the bound dedicated key (encrypted at rest,
 * authenticates as the owner, revoked on delete), name uniqueness, and the
 * authoring/read capability gates. Driven at the core level; REST coverage
 * lives in agent-rest.test.ts.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as agents from "../../src/core/agents.js";
import { authenticateKeyRow } from "../../src/core/keys.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";

describeEachAdapter("agents core", (adapter) => {
  let app: TestApp;
  let env: agents.AgentEnv;
  let aliceId: string;
  let bobId: string;
  let spaceId: string;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    env = { db: app.db, config: app.config };
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    aliceId = a.body.user.id;
    const alice = apiClient(app.baseUrl, a.body.initialKey.key);
    const b = await sysadmin.post("/v1/users", { name: "Bob" });
    bobId = b.body.user.id;
    spaceId = (await alice.post("/v1/spaces", { name: "Workshop" })).body.id;
  });

  afterAll(async () => {
    await app.stop();
  });

  it("creates an agent, hides secrets, and mints a bound key that authenticates as the owner", async () => {
    const info = await agents.createAgent(env, aliceId, spaceId, {
      name: "reporter",
      runtime: "mock",
      model: "mock-1",
      args: ["--report"],
      instructions: "summarize the week",
      schedule: null,
    });
    expect(info.name).toBe("reporter");
    expect(info.runtime).toBe("mock");
    expect(info.args).toEqual(["--report"]);
    expect(JSON.stringify(info)).not.toContain("access_key");
    expect(JSON.stringify(info)).not.toContain("v1.");

    const row = await agents.getAgentRow(app.db, info.id);
    expect(row.accessKeyEncrypted).toMatch(/^v1\./);
    const key = agents.decryptAgentKey(env, row);
    const who = await authenticateKeyRow(app.db, key);
    expect(who?.userId).toBe(aliceId);
  });

  it("rejects a duplicate name in the same space", async () => {
    await expect(
      agents.createAgent(env, aliceId, spaceId, { name: "reporter", runtime: "mock", model: "mock-1" }),
    ).rejects.toThrow(/already exists/);
  });

  it("requires runtime and model", async () => {
    await expect(
      agents.createAgent(env, aliceId, spaceId, { name: "no-runtime", runtime: "", model: "x" }),
    ).rejects.toThrow(/runtime is required/);
    await expect(
      agents.createAgent(env, aliceId, spaceId, { name: "no-model", runtime: "mock", model: "" }),
    ).rejects.toThrow(/model is required/);
  });

  it("lists and gets agents", async () => {
    const list = await agents.listAgents(app.db, aliceId, spaceId);
    expect(list.map((a) => a.name)).toContain("reporter");
    const one = await agents.getAgent(app.db, aliceId, list[0]!.id);
    expect(one.id).toBe(list[0]!.id);
  });

  it("updates fields and rejects a colliding rename", async () => {
    const created = await agents.createAgent(env, aliceId, spaceId, {
      name: "to-update",
      runtime: "mock",
      model: "mock-1",
    });
    const updated = await agents.updateAgent(env, aliceId, created.id, {
      model: "mock-2",
      instructions: "changed",
      schedule: "0 9 * * *",
    });
    expect(updated.model).toBe("mock-2");
    expect(updated.instructions).toBe("changed");
    expect(updated.schedule).toBe("0 9 * * *");

    await expect(agents.updateAgent(env, aliceId, created.id, { name: "reporter" })).rejects.toThrow(/already exists/);
  });

  it("deletes an agent and revokes its bound key", async () => {
    const created = await agents.createAgent(env, aliceId, spaceId, {
      name: "ephemeral",
      runtime: "mock",
      model: "mock-1",
    });
    const row = await agents.getAgentRow(app.db, created.id);
    const key = agents.decryptAgentKey(env, row);
    expect(await authenticateKeyRow(app.db, key)).not.toBeNull();

    await agents.deleteAgent(env, aliceId, created.id);
    await expect(agents.getAgent(app.db, aliceId, created.id)).rejects.toThrow(/not found|agent/i);
    expect(await authenticateKeyRow(app.db, key)).toBeNull();
    const { accessKeys } = app.db.tables;
    const remaining = await app.db.client.select().from(accessKeys).where(eq(accessKeys.id, row.accessKeyId));
    expect(remaining).toHaveLength(0);
  });

  it("hides agents from outsiders: no create, no read", async () => {
    await expect(
      agents.createAgent(env, bobId, spaceId, { name: "bobs", runtime: "mock", model: "mock-1" }),
    ).rejects.toThrow(/edit_agents/);
    const list = await agents.listAgents(app.db, aliceId, spaceId);
    await expect(agents.getAgent(app.db, bobId, list[0]!.id)).rejects.toThrow(/not found|agent/i);
  });
});
