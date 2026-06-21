/**
 * The per-agent scheduler: a scheduled agent fires runs, reload() removes a
 * job when its schedule is cleared, and an invalid cron string is tolerated.
 * Uses a one-second cron so firing is observable without a fake clock.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import * as agents from "../../src/core/agents.js";
import { startAgentScheduler, type AgentScheduler } from "../../src/agent/scheduler.js";
import { createLogger } from "../../src/logger.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";

const EVERY_SECOND = "* * * * * *";
const quiet = createLogger({ debug() {}, info() {}, log() {}, warn() {}, error() {} });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeEachAdapter("agent scheduler", (adapter) => {
  let app: TestApp;
  let scheduler: AgentScheduler;
  let aliceId: string;
  let spaceId: string;
  const env = () => ({ db: app.db, config: app.config });

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    aliceId = a.body.user.id;
    spaceId = (await apiClient(app.baseUrl, a.body.initialKey.key).post("/v1/spaces", { name: "Sched" })).body.id;
  });

  afterAll(async () => {
    scheduler?.stop();
    await app.stop();
  });

  it("fires scheduled agents, tolerates a bad cron, and stops on reload", async () => {
    const good = await agents.createAgent(env(), aliceId, spaceId, {
      name: "ticker",
      runtime: "mock",
      model: "mock-1",
      schedule: EVERY_SECOND,
    });
    await agents.createAgent(env(), aliceId, spaceId, {
      name: "broken",
      runtime: "mock",
      model: "mock-1",
      schedule: "not a cron",
    });

    const fire = vi.fn(async (_agentId: string) => {});
    scheduler = await startAgentScheduler({ db: app.db, fire }, quiet);

    await wait(1500);
    const firedFor = new Set(fire.mock.calls.map((c) => c[0]));
    expect(firedFor.has(good.id)).toBe(true); // the valid schedule fired
    expect([...firedFor]).toHaveLength(1); // the bad cron was never registered

    // Clear the schedule and reload: the job is removed and stops firing.
    await agents.updateAgent(env(), aliceId, good.id, { schedule: null });
    await scheduler.reload(good.id);
    fire.mockClear();
    await wait(1500);
    expect(fire).not.toHaveBeenCalled();
  });
});
