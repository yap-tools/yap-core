/**
 * Triggering runs: the run_agent MCP tool and the REST run endpoints, the
 * run_agents capability gate (separate from the bound key the run acts with),
 * per-run args override, and run inspection (status/output/logs).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as agents from "../../src/core/agents.js";
import * as creds from "../../src/core/runtimeCredentials.js";
import { FakeExecutor } from "../../src/agent/executor.js";
import { processOneRun, type WorkerDeps } from "../../src/agent/worker.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp, type McpTestClient } from "../helpers/mcp.js";

const HOUR = 60 * 60 * 1000;

describeEachAdapter("agent runs", (adapter) => {
  let app: TestApp;
  let alice: ApiClient;
  let aliceMcp: McpTestClient;
  let bob: ApiClient;
  let bobMcp: McpTestClient;
  let bobId: string;
  let aliceId: string;
  let spaceId: string;
  let agentId: string;

  const drain = async (executor: FakeExecutor) => {
    const deps: WorkerDeps = { db: app.db, blob: app.blob, config: app.config, executor };
    while (await processOneRun(deps)) {
      /* keep draining */
    }
  };

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    aliceId = a.body.user.id;
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    aliceMcp = await connectMcp(app.baseUrl, a.body.initialKey.key);
    const b = await sysadmin.post("/v1/users", { name: "Bob" });
    bobId = b.body.user.id;
    bob = apiClient(app.baseUrl, b.body.initialKey.key);
    bobMcp = await connectMcp(app.baseUrl, b.body.initialKey.key);
    spaceId = (await alice.post("/v1/spaces", { name: "Runs" })).body.id;
    agentId = (await agents.createAgent({ db: app.db, config: app.config }, aliceId, spaceId, {
      name: "worker",
      runtime: "mock",
      model: "mock-1",
      instructions: "go",
    })).id;
    await creds.storeCredential({ db: app.db, config: app.config }, "mock", {
      accessToken: "tok",
      expiresAt: Date.now() + HOUR,
    });
  });

  afterAll(async () => {
    await aliceMcp.close();
    await bobMcp.close();
    await app.stop();
  });

  it("exposes run_agent over MCP but not agent authoring", async () => {
    const names = (await aliceMcp.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("run_agent");
    expect(names.some((n) => /agent_create|create_agent/.test(n))).toBe(false);
  });

  it("run_agent queues a run, the worker executes it, and it is inspectable", async () => {
    const { run_id, status } = await aliceMcp.call("run_agent", { agent_id: agentId });
    expect(status).toBe("queued");

    await drain(new FakeExecutor({ exitCode: 0, output: "done", logs: "log line" }));

    const run = await alice.get(`/v1/runs/${run_id}`);
    expect(run.body.status).toBe("succeeded");
    expect(run.body.output).toBe("done");

    const logs = await alice.get(`/v1/runs/${run_id}/logs`);
    expect(logs.body).toContain("log line");
  });

  it("records a per-run args override", async () => {
    const { run_id } = await aliceMcp.call("run_agent", { agent_id: agentId, args: ["--once"] });
    await drain(new FakeExecutor({ exitCode: 0 }));
    const run = await alice.get(`/v1/runs/${run_id}`);
    expect(run.body.args).toEqual(["--once"]);
  });

  it("triggers over REST and lists runs", async () => {
    const res = await alice.post(`/v1/agents/${agentId}/runs`, { args: { mode: "rest" } });
    expect(res.status).toBe(202);
    expect(res.body.run_id).toBeTruthy();
    const list = await alice.get(`/v1/agents/${agentId}/runs`);
    expect(list.body.data.length).toBeGreaterThanOrEqual(3);
    await drain(new FakeExecutor({ exitCode: 0 }));
  });

  it("requires run_agents — denied to a non-member, allowed once granted", async () => {
    await expect(bobMcp.call("run_agent", { agent_id: agentId })).rejects.toThrow(/not found|run_agents/i);
    expect((await bob.post(`/v1/agents/${agentId}/runs`, {})).status).toBe(404); // existence hidden

    await alice.post(`/v1/spaces/${spaceId}/grants`, { userId: bobId, capabilities: ["run_agents"], effect: "allow" });
    const ok = await bobMcp.call("run_agent", { agent_id: agentId });
    expect(ok.status).toBe("queued");
    await drain(new FakeExecutor({ exitCode: 0 }));
  });
});
