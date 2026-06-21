/**
 * The run worker end to end with a fake executor and the built-in mock
 * runtime: the happy path, the typed failure reasons (unknown runtime, stale
 * credential, timeout), and read-only file staging + secret injection.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as agentFiles from "../../src/core/agentFiles.js";
import * as agents from "../../src/core/agents.js";
import * as runs from "../../src/core/agentRuns.js";
import * as creds from "../../src/core/runtimeCredentials.js";
import { FakeExecutor } from "../../src/agent/executor.js";
import { processOneRun, type WorkerDeps } from "../../src/agent/worker.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";

const HOUR = 60 * 60 * 1000;

describeEachAdapter("agent worker", (adapter) => {
  let app: TestApp;
  let aliceId: string;
  let spaceId: string;

  const agentEnv = () => ({ db: app.db, config: app.config });
  const fileEnv = () => ({ db: app.db, blob: app.blob, config: app.config });
  const credEnv = () => ({ db: app.db, config: app.config });
  const deps = (executor: FakeExecutor): WorkerDeps => ({ db: app.db, blob: app.blob, config: app.config, executor });

  const newAgent = (name: string, overrides: Partial<{ runtime: string; model: string }> = {}) =>
    agents.createAgent(agentEnv(), aliceId, spaceId, {
      name,
      runtime: overrides.runtime ?? "mock",
      model: overrides.model ?? "mock-1",
      instructions: "do the thing",
    });

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    aliceId = a.body.user.id;
    const alice = apiClient(app.baseUrl, a.body.initialKey.key);
    spaceId = (await alice.post("/v1/spaces", { name: "Runs" })).body.id;
    // A valid, non-expiring mock credential for the happy paths.
    await creds.storeCredential(credEnv(), "mock", { accessToken: "live-token", expiresAt: Date.now() + HOUR });
  });

  afterAll(async () => {
    await app.stop();
  });

  it("returns false when the queue is empty", async () => {
    expect(await processOneRun(deps(new FakeExecutor()))).toBe(false);
  });

  it("runs an agent to success, persisting output and logs", async () => {
    const agent = await newAgent("happy");
    const { run_id } = await runs.enqueueRun(app.db, agent.id, { trigger: "manual", triggeredBy: aliceId });
    const executor = new FakeExecutor({ exitCode: 0, output: "the answer is 42", logs: "started\ndone" });

    expect(await processOneRun(deps(executor))).toBe(true);

    const run = await runs.getRun(app.db, aliceId, run_id);
    expect(run.status).toBe("succeeded");
    expect(run.exitCode).toBe(0);
    expect(run.output).toBe("the answer is 42");

    // Logs went to the blob; the run records the key.
    const logsKey = await runs.getRunLogsKey(app.db, aliceId, run_id);
    expect(logsKey).toBeTruthy();
    const buf = await app.blob.getStream(logsKey!);
    let text = "";
    for await (const chunk of buf) text += chunk.toString();
    expect(text).toContain("done");

    // The container saw the injected key + token and the instructions.
    expect(executor.lastSpec!.env.YAP_ACCESS_KEY).toBeTruthy();
    expect(executor.lastSpec!.env.MODEL_TOKEN).toBe("live-token");
    expect(executor.lastSpec!.env.AGENT_INSTRUCTIONS).toBe("do the thing");
  });

  it("fails with runtime_unavailable for an unknown runtime", async () => {
    const agent = await newAgent("badruntime", { runtime: "nope" });
    const { run_id } = await runs.enqueueRun(app.db, agent.id, { trigger: "manual" });
    await processOneRun(deps(new FakeExecutor()));
    const run = await runs.getRun(app.db, aliceId, run_id);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("runtime_unavailable");
  });

  it("fails with stale_credential when refresh is impossible", async () => {
    await creds.storeCredential(credEnv(), "mock", { failRefresh: true, accessToken: "x", expiresAt: Date.now() - 1 });
    try {
      const agent = await newAgent("stale");
      const { run_id } = await runs.enqueueRun(app.db, agent.id, { trigger: "manual" });
      await processOneRun(deps(new FakeExecutor()));
      const run = await runs.getRun(app.db, aliceId, run_id);
      expect(run.status).toBe("failed");
      expect(run.error).toBe("stale_credential");
    } finally {
      // restore a healthy credential for later tests
      await creds.storeCredential(credEnv(), "mock", { accessToken: "live-token", expiresAt: Date.now() + HOUR });
    }
  });

  it("records a timeout", async () => {
    const agent = await newAgent("slow");
    const { run_id } = await runs.enqueueRun(app.db, agent.id, { trigger: "manual" });
    await processOneRun(deps(new FakeExecutor({ exitCode: 124, timedOut: true, logs: "killed" })));
    const run = await runs.getRun(app.db, aliceId, run_id);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("timeout");
  });

  it("stages finalized files read-only into the container", async () => {
    const agent = await newAgent("withfiles");
    const req = await agentFiles.requestAgentUpload(fileEnv(), aliceId, agent.id, { name: "input.txt" });
    await agentFiles.storeAgentUploadedBytes(fileEnv(), req.file_id, new TextEncoder().encode("payload"));
    await agentFiles.completeAgentUpload(fileEnv(), aliceId, req.file_id);

    await runs.enqueueRun(app.db, agent.id, { trigger: "manual" });
    const executor = new FakeExecutor({ exitCode: 0 });
    await processOneRun(deps(executor));

    expect(executor.lastSpec!.files).toHaveLength(1);
    expect(executor.lastSpec!.files[0]!.containerPath).toBe("/agent/files/input.txt");
  });
});
