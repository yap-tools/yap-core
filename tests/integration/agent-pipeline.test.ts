/**
 * End-to-end wiring (the parts serve.ts assembles): the run worker auto-drains
 * when run_agent kicks it, and creating a scheduled agent over REST registers a
 * job whose ticks enqueue runs the worker then executes — no manual draining.
 */
import { afterAll, beforeAll, expect, it } from "vitest";

import * as agents from "../../src/core/agents.js";
import { enqueueRun } from "../../src/core/agentRuns.js";
import { getCredentialStatus, storeCredential } from "../../src/core/runtimeCredentials.js";
import { FakeExecutor } from "../../src/agent/executor.js";
import { startAgentScheduler, type AgentScheduler } from "../../src/agent/scheduler.js";
import { startAgentWorker, type AgentWorker } from "../../src/agent/worker.js";
import { getAgentRow } from "../../src/core/agents.js";
import { createLogger } from "../../src/logger.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp, type McpTestClient } from "../helpers/mcp.js";

const HOUR = 60 * 60 * 1000;
const quiet = createLogger({ debug() {}, info() {}, log() {}, warn() {}, error() {} });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await wait(40);
  }
}

describeEachAdapter("agent pipeline", (adapter) => {
  let app: TestApp;
  let worker: AgentWorker;
  let scheduler: AgentScheduler;
  let alice: ApiClient;
  let aliceMcp: McpTestClient;
  let aliceId: string;
  let spaceId: string;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    // Wire the worker + scheduler exactly as serve.ts does, but with a fake
    // executor (no Docker) for determinism.
    worker = startAgentWorker(
      { db: app.db, blob: app.blob, config: app.config, executor: new FakeExecutor({ exitCode: 0, output: "ok" }) },
      quiet,
    );
    app.server.agentWorker = worker;
    scheduler = await startAgentScheduler(
      {
        db: app.db,
        fire: async (agentId) => {
          const agent = await getAgentRow(app.db, agentId);
          const cred = await getCredentialStatus({ db: app.db, config: app.config }, agent.runtime);
          if (cred?.status === "stale") return;
          await enqueueRun(app.db, agentId, { trigger: "scheduled" });
          worker.kick();
        },
      },
      quiet,
    );
    app.server.agentScheduler = scheduler;

    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    aliceId = a.body.user.id;
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    aliceMcp = await connectMcp(app.baseUrl, a.body.initialKey.key);
    spaceId = (await alice.post("/v1/spaces", { name: "Pipeline" })).body.id;
    await storeCredential({ db: app.db, config: app.config }, "mock", {
      accessToken: "tok",
      expiresAt: Date.now() + HOUR,
    });
  });

  afterAll(async () => {
    scheduler?.stop();
    await worker?.stop();
    await aliceMcp.close();
    await app.stop();
  });

  it("run_agent kicks the worker, which runs the agent to completion", async () => {
    const agentId = (await agents.createAgent({ db: app.db, config: app.config }, aliceId, spaceId, {
      name: "ondemand",
      runtime: "mock",
      model: "mock-1",
    })).id;
    const { run_id } = await aliceMcp.call("run_agent", { agent_id: agentId });
    const run = await waitFor(async () => {
      const r = (await alice.get(`/v1/runs/${run_id}`)).body;
      return r.status === "succeeded" ? r : undefined;
    });
    expect(run.output).toBe("ok");
  });

  it("a scheduled agent created over REST runs on its own", async () => {
    const created = await alice.post(`/v1/spaces/${spaceId}/agents`, {
      name: "cron",
      runtime: "mock",
      model: "mock-1",
      schedule: "* * * * * *", // every second
    });
    const agentId = created.body.id;
    const run = await waitFor(async () => {
      const runs = (await alice.get(`/v1/agents/${agentId}/runs`)).body.data;
      return runs.find((r: any) => r.trigger === "scheduled" && r.status === "succeeded");
    });
    expect(run.trigger).toBe("scheduled");

    // Clearing the schedule over REST stops further runs.
    await alice.patch(`/v1/agents/${agentId}`, { schedule: null });
    const countAfterClear = (await alice.get(`/v1/agents/${agentId}/runs`)).body.data.length;
    await wait(1500);
    const countLater = (await alice.get(`/v1/agents/${agentId}/runs`)).body.data.length;
    expect(countLater).toBe(countAfterClear);
  });
});
