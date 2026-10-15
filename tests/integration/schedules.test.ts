/**
 * Schedules: authoring over REST and MCP (with `run_services` alone, from a
 * key or a member-scoped OAuth token), and the scheduler's tick — firing as
 * the owner, skipping on overlap, disabling on capability loss, several
 * schedules on one service each with their own params — plus the
 * `user_id`/`source`/`schedule_id` every run now records.
 *
 * Most firing tests drive `scheduler.fire(id)` directly: one tick, exactly as
 * the cron job runs it, without waiting for a wall-clock minute. The cron
 * timing itself (time zones, disable/re-enable without a restart, a scheduler
 * that was never started) runs under fake timers against SQLite only — the
 * scheduler's logic is dialect-blind, and the queries it issues are already
 * exercised on both dialects by the direct fires.
 */
import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runWithTokenAuth } from "../../src/core/authScope.js";
import { DRIVER_API, type DriverDefinition, type RunContext } from "../../src/core/drivers/types.js";
import { getRun, listRuns, type RunRecord } from "../../src/core/runs.js";
import { createScheduler } from "../../src/core/scheduler.js";
import { createSchedule, getSchedule, updateSchedule, type ScheduleEnv } from "../../src/core/schedules.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, getFreePort, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp, type McpTestClient } from "../helpers/mcp.js";
import { connectApp } from "../helpers/oauth.js";

/** Runs of the `hang` action wait here until a test lets them go. */
const hanging: Array<() => void> = [];

const schedDriver: DriverDefinition = {
  name: "sched",
  api: DRIVER_API,
  description: "In-test driver for schedules.",
  egress: false,
  validateConfig(): void {},
  actions: {
    tick: {
      description: "Echoes its params.",
      params: [{ name: "message", required: true }, { name: "tag" }],
      timeoutMs: 5_000,
    },
    hang: {
      description: "Stays running until released.",
      params: [],
      timeoutMs: 30_000,
    },
  },
  async run(ctx: RunContext): Promise<unknown> {
    if (ctx.action === "hang") {
      await new Promise<void>((resolve) => hanging.push(resolve));
      return { released: true };
    }
    return { echoed: ctx.params };
  },
};

const releaseAll = (): void => {
  for (const release of hanging.splice(0)) release();
};

/** Resolves once a `hang` run has reached the driver. */
const waitForHang = async (timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (hanging.length === 0) {
    if (Date.now() > deadline) throw new Error(`no hang run reached the driver within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describeEachAdapter("schedules", (adapter) => {
  let app: TestApp;
  let sysadmin: ApiClient;
  let alice: ApiClient;
  let aliceId: string;
  let aliceKey: string;
  /** Holds run_services but not edit_services: a runner, not a service author. */
  let bob: ApiClient;
  let bobId: string;
  let bobKey: string;
  let viewer: ApiClient;
  let viewerId: string;
  let spaceId: string;
  let bundleId: string;
  let serviceId: string;
  let env: ScheduleEnv & { blob: TestApp["blob"] };

  let target: Server;
  let targetPort: number;

  const pollUntilTerminal = async (runId: string, timeoutMs = 8_000): Promise<RunRecord> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await getRun({ ...env, registry: app.server.registry }, aliceId, runId);
      if (run.status === "succeeded" || run.status === "failed") return run;
      if (Date.now() > deadline) throw new Error(`run ${runId} still ${run.status} after ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const runsOfService = async (svc: string) =>
    (await listRuns({ ...env, registry: app.server.registry }, aliceId, bundleId, { service: svc, limit: 100 })).data;

  /** Create, change, disable, re-enable and delete one's own schedule over REST. */
  const expectOwnScheduleLifecycleOverRest = async (api: ApiClient, ownerId: string): Promise<void> => {
    const created = await api.post(`/v1/bundles/${bundleId}/schedules`, {
      service: "jobs",
      action: "tick",
      params: { message: "mine" },
      cron: "0 7 * * *",
    });
    expect(created.status).toBe(201);
    expect(created.body.ownerId).toBe(ownerId);
    const id = created.body.id;

    const changed = await api.patch(`/v1/schedules/${id}`, { cron: "0 8 * * *", params: { message: "changed" } });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ cron: "0 8 * * *", params: { message: "changed" } });
    expect((await api.patch(`/v1/schedules/${id}`, { enabled: false })).body.enabled).toBe(false);
    expect((await api.patch(`/v1/schedules/${id}`, { enabled: true })).body.enabled).toBe(true);

    expect((await api.delete(`/v1/schedules/${id}`)).status).toBe(200);
    expect((await alice.get(`/v1/schedules/${id}`)).status).toBe(404);
  };

  /** One second-tier call over MCP; a refusal comes back as the call's error. */
  const mcpOne = async (agent: McpTestClient, tool: string, params: Record<string, unknown>) =>
    (await agent.call("call", { space_id: spaceId, calls: [{ tool, bundle_id: bundleId, params }] })).results[0];

  /** The same lifecycle through the MCP call tools. */
  const expectOwnScheduleLifecycleOverMcp = async (agent: McpTestClient, ownerId: string): Promise<void> => {
    const created = await mcpOne(agent, "create_schedule", {
      service: "jobs",
      action: "tick",
      params: { message: "mine" },
      cron: "0 7 * * *",
      timezone: "Europe/Copenhagen",
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(created.result).toMatchObject({ ownerId, timezone: "Europe/Copenhagen", enabled: true });
    const id = created.result.id;

    const changed = await mcpOne(agent, "update_schedule", { id, cron: "0 8 * * *", params: { message: "changed" } });
    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    expect(changed.result).toMatchObject({ cron: "0 8 * * *", params: { message: "changed" } });
    expect((await mcpOne(agent, "update_schedule", { id, enabled: false })).result.enabled).toBe(false);
    expect((await mcpOne(agent, "update_schedule", { id, enabled: true })).result.enabled).toBe(true);

    const listed = await mcpOne(agent, "list_schedules", {});
    expect(listed.result.map((s: { id: string }) => s.id)).toContain(id);

    expect((await mcpOne(agent, "delete_schedule", { id })).result).toEqual({ deleted: true });
    expect((await alice.get(`/v1/schedules/${id}`)).status).toBe(404);
  };

  beforeAll(async () => {
    targetPort = await getFreePort();
    target = createServer((req, res) => {
      req.resume();
      req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
    });
    await new Promise<void>((resolve) => target.listen(targetPort, "127.0.0.1", resolve));

    app = await bootTestApp({ YAP_HOOK_ALLOW_HOSTS: "127.0.0.1" }, await adapter.makeDb());
    // The registry is shared by reference with every surface and the scheduler.
    app.server.registry.register(schedDriver);
    env = { db: app.db, config: app.config, registry: app.server.registry, blob: app.blob };

    sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    aliceKey = a.body.initialKey.key;
    alice = apiClient(app.baseUrl, aliceKey);
    aliceId = a.body.user.id;
    const b = await sysadmin.post("/v1/users", { name: "Bob" });
    bobKey = b.body.initialKey.key;
    bob = apiClient(app.baseUrl, bobKey);
    bobId = b.body.user.id;
    const v = await sysadmin.post("/v1/users", { name: "Viewer" });
    viewer = apiClient(app.baseUrl, v.body.initialKey.key);
    viewerId = v.body.user.id;

    spaceId = (await alice.post("/v1/spaces", { name: "Ops" })).body.id;
    bundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "jobs" })).body.id;
    await alice.post(`/v1/bundles/${bundleId}/grants`, {
      userId: bobId,
      capabilities: ["run_services", "read_items"],
      effect: "allow",
    });
    await alice.post(`/v1/bundles/${bundleId}/grants`, {
      userId: viewerId,
      capabilities: ["read_items"],
      effect: "allow",
    });
    const svc = await alice.post(`/v1/bundles/${bundleId}/services`, {
      name: "jobs",
      driver: "sched",
      pins: { tag: "pinned-tag" },
      config: {},
    });
    expect(svc.status).toBe(201);
    serviceId = svc.body.id;
  });

  afterAll(async () => {
    releaseAll();
    await app.stop();
    await new Promise<void>((resolve, reject) => target.close((e) => (e ? reject(e) : resolve())));
  });

  describe("authoring over REST", () => {
    it("creates a schedule owned by its creator, with the action resolved and the next fire computed", async () => {
      const res = await alice.post(`/v1/bundles/${bundleId}/schedules`, {
        service: "jobs",
        action: "tick",
        params: { message: "hello" },
        cron: "0 7 * * 1-5",
        timezone: "Europe/Copenhagen",
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        bundleId,
        serviceId,
        action: "tick",
        params: { message: "hello" },
        cron: "0 7 * * 1-5",
        timezone: "Europe/Copenhagen",
        enabled: true,
        ownerId: aliceId,
        lastFiredAt: null,
        lastRunId: null,
        lastError: null,
        lastSkippedAt: null,
      });
      expect(Date.parse(res.body.nextFireAt)).toBeGreaterThan(Date.now());

      const got = await alice.get(`/v1/schedules/${res.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body.id).toBe(res.body.id);

      const listed = await alice.get(`/v1/bundles/${bundleId}/schedules?service=jobs`);
      expect(listed.body.data.map((s: { id: string }) => s.id)).toContain(res.body.id);
    });

    it("defaults the timezone to UTC and accepts a disabled schedule with no next fire", async () => {
      const res = await alice.post(`/v1/bundles/${bundleId}/schedules`, {
        service: serviceId,
        action: "tick",
        params: { message: "x" },
        cron: "*/5 * * * *",
        enabled: false,
      });
      expect(res.status).toBe(201);
      expect(res.body.timezone).toBe("UTC");
      expect(res.body.enabled).toBe(false);
      expect(res.body.nextFireAt).toBeNull();
    });

    it("validates cron, timezone, action and params at write time, like run_service", async () => {
      const base = { service: "jobs", action: "tick", params: { message: "x" }, cron: "0 7 * * *" };
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{ ...base, cron: "*/5 * * * * *" }, /5-field/],
        [{ ...base, cron: "61 * * * *" }, /invalid cron/],
        [{ ...base, timezone: "Mars/Olympus" }, /unknown timezone/],
        [{ ...base, action: "nope" }, /unknown action/],
        [{ ...base, action: undefined }, /needs an action/],
        [{ ...base, params: {} }, /required parameter "message"/],
        [{ ...base, params: { message: "x", bogus: 1 } }, /unknown parameter "bogus"/],
        [{ ...base, params: { message: "x", tag: "mine" } }, /fixed by this service/],
        [{ ...base, params: { message: { nested: true } } }, /must be a scalar/],
      ];
      for (const [body, message] of cases) {
        const res = await alice.post(`/v1/bundles/${bundleId}/schedules`, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error.message).toMatch(message);
      }
      const missing = await alice.post(`/v1/bundles/${bundleId}/schedules`, { ...base, service: "ghost" });
      expect(missing.status).toBe(404);
    });

    it("needs run_services to author and to read", async () => {
      const body = { service: "jobs", action: "tick", params: { message: "x" }, cron: "0 7 * * *" };
      expect((await viewer.post(`/v1/bundles/${bundleId}/schedules`, body)).status).toBe(403);
      expect((await viewer.get(`/v1/bundles/${bundleId}/schedules`)).status).toBe(403);

      const created = await alice.post(`/v1/bundles/${bundleId}/schedules`, body);
      expect((await viewer.get(`/v1/schedules/${created.body.id}`)).status).toBe(403);

      // A user with no foothold at all learns nothing: the schedule is a 404.
      const stranger = (await sysadmin.post("/v1/users", { name: "Stranger" })).body.initialKey.key;
      const strangerApi = apiClient(app.baseUrl, stranger);
      for (const res of [
        await strangerApi.get(`/v1/schedules/${created.body.id}`),
        await strangerApi.patch(`/v1/schedules/${created.body.id}`, { enabled: false }),
        await strangerApi.delete(`/v1/schedules/${created.body.id}`),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body.error.message).not.toContain(bundleId);
      }
    });

    it("lets only the owner change what a schedule runs; anyone with run_services can disable or delete it", async () => {
      const created = await alice.post(`/v1/bundles/${bundleId}/schedules`, {
        service: "jobs",
        action: "tick",
        params: { message: "x" },
        cron: "0 7 * * *",
      });
      const id = created.body.id;

      expect((await bob.patch(`/v1/schedules/${id}`, { cron: "0 8 * * *" })).status).toBe(403);
      expect((await bob.patch(`/v1/schedules/${id}`, { params: { message: "bob's" } })).status).toBe(403);

      const off = await bob.patch(`/v1/schedules/${id}`, { enabled: false });
      expect(off.status).toBe(200);
      expect(off.body).toMatchObject({ enabled: false, ownerId: aliceId, nextFireAt: null });
      // Turning it back on would resume a standing order as Alice: hers to do.
      expect((await bob.patch(`/v1/schedules/${id}`, { enabled: true })).status).toBe(403);

      const changed = await alice.patch(`/v1/schedules/${id}`, {
        enabled: true,
        cron: "30 6 * * *",
        timezone: "America/New_York",
        params: { message: "changed" },
      });
      expect(changed.status).toBe(200);
      expect(changed.body).toMatchObject({
        enabled: true,
        cron: "30 6 * * *",
        timezone: "America/New_York",
        params: { message: "changed" },
      });
      expect((await alice.patch(`/v1/schedules/${id}`, { params: { message: "x", bogus: 1 } })).status).toBe(400);

      expect((await bob.delete(`/v1/schedules/${id}`)).status).toBe(200);
      expect((await alice.get(`/v1/schedules/${id}`)).status).toBe(404);
    });

    it("lets a run_services holder without edit_services create, change and delete their own schedule", async () => {
      // Bob runs services but cannot author them: that stays edit_services.
      expect((await bob.post(`/v1/bundles/${bundleId}/services`, { name: "bobs", driver: "sched", config: {} })).status).toBe(
        403,
      );
      await expectOwnScheduleLifecycleOverRest(bob, bobId);
    });

    it("deletes a service's schedules with the service", async () => {
      const svc = await alice.post(`/v1/bundles/${bundleId}/services`, { name: "doomed", driver: "sched", config: {} });
      const created = await alice.post(`/v1/bundles/${bundleId}/schedules`, {
        service: "doomed",
        action: "hang",
        cron: "0 7 * * *",
      });
      expect(created.status).toBe(201);
      expect((await alice.delete(`/v1/services/${svc.body.id}`)).status).toBe(200);
      expect((await alice.get(`/v1/schedules/${created.body.id}`)).status).toBe(404);
    });
  });

  describe("MCP", () => {
    it("lets a run_services holder without edit_services create, change and delete their own schedule", async () => {
      const agent = await connectMcp(app.baseUrl, bobKey);
      try {
        await expectOwnScheduleLifecycleOverMcp(agent, bobId);
      } finally {
        await agent.close();
      }
    });

    it("applies the REST validation and owner rules", async () => {
      const created = await alice.post(`/v1/bundles/${bundleId}/schedules`, {
        service: "jobs",
        action: "tick",
        params: { message: "alice's" },
        cron: "0 7 * * *",
      });
      const id = created.body.id;
      const agent = await connectMcp(app.baseUrl, bobKey);
      try {
        const base = { service: "jobs", action: "tick", params: { message: "x" }, cron: "0 7 * * *" };
        const cases: Array<[Record<string, unknown>, RegExp]> = [
          [{ ...base, cron: "*/5 * * * * *" }, /5-field/],
          [{ ...base, timezone: "Mars/Olympus" }, /unknown timezone/],
          [{ ...base, params: {} }, /required parameter "message"/],
          [{ ...base, params: { message: "x", tag: "mine" } }, /fixed by this service/],
          // No coercion of what an agent sends: a string "false" is not false.
          [{ ...base, enabled: "false" }, /enabled must be true or false/],
          [{ ...base, params: "message=x" }, /params must be an object/],
          [{ ...base, cron: 7 }, /cron must be a string/],
        ];
        for (const [params, message] of cases) {
          const res = await mcpOne(agent, "create_schedule", params);
          expect(res.ok, JSON.stringify(params)).toBe(false);
          expect(res.error.message).toMatch(message);
        }

        // Alice's schedule runs as Alice: Bob may stop it, not rewrite or resume it.
        expect((await mcpOne(agent, "update_schedule", { id, cron: "0 8 * * *" })).ok).toBe(false);
        expect((await mcpOne(agent, "update_schedule", { id, enabled: false })).result.enabled).toBe(false);
        const resume = await mcpOne(agent, "update_schedule", { id, enabled: true });
        expect(resume.ok).toBe(false);
        expect(resume.error.message).toMatch(/only the schedule's owner/);
        expect((await mcpOne(agent, "delete_schedule", { id })).ok).toBe(true);
      } finally {
        await agent.close();
      }

      // No run_services, no scheduling.
      const viewerKey = (await sysadmin.post(`/v1/users/${viewerId}/keys`, {})).body.key;
      const readOnly = await connectMcp(app.baseUrl, viewerKey);
      try {
        const denied = await mcpOne(readOnly, "create_schedule", {
          service: "jobs",
          action: "tick",
          params: { message: "x" },
          cron: "0 7 * * *",
        });
        expect(denied.ok).toBe(false);
      } finally {
        await readOnly.close();
      }
    });

    it("advertises the schedule tools in the manifest with run_services", async () => {
      const agent = await connectMcp(app.baseUrl, bobKey);
      try {
        const loaded = await agent.call("load");
        const manifest = loaded.tools.call.second_tier;
        for (const name of ["create_schedule", "update_schedule", "delete_schedule", "list_schedules"]) {
          expect(manifest[name], name).toMatchObject({ capability: "run_services", targets: ["bundle"] });
        }
        const full = await agent.call("get_tools", { names: ["create_schedule"] });
        expect(JSON.stringify(full)).toContain("cron");
      } finally {
        await agent.close();
      }
    });

    it("lists schedules through list_schedules and load_bundle, for run_services holders only", async () => {
      const created = await alice.post(`/v1/bundles/${bundleId}/schedules`, {
        service: "jobs",
        action: "tick",
        params: { message: "via mcp" },
        cron: "15 9 * * *",
      });
      const agent = await connectMcp(app.baseUrl, aliceKey);
      try {
        const listed = await agent.call("call", {
          space_id: spaceId,
          calls: [{ tool: "list_schedules", bundle_id: bundleId, params: { service: "jobs" } }],
        });
        expect(listed.results[0].ok).toBe(true);
        expect(listed.results[0].result.map((s: { id: string }) => s.id)).toContain(created.body.id);

        const loaded = await agent.call("load_bundle", { bundle_ids: [bundleId] });
        expect(loaded.bundles[0].schedules.map((s: { id: string }) => s.id)).toContain(created.body.id);
      } finally {
        await agent.close();
      }

      const viewerKey = (await sysadmin.post(`/v1/users/${viewerId}/keys`, {})).body.key;
      const readOnly = await connectMcp(app.baseUrl, viewerKey);
      try {
        const loaded = await readOnly.call("load_bundle", { bundle_ids: [bundleId] });
        expect(loaded.bundles[0].services.length).toBeGreaterThan(0);
        expect(loaded.bundles[0]).not.toHaveProperty("schedules");
      } finally {
        await readOnly.close();
      }
    });
  });

  describe("firing", () => {
    it("starts a run as the owner, recording source, schedule and user", async () => {
      const created = await bob.post(`/v1/bundles/${bundleId}/schedules`, {
        service: "jobs",
        action: "tick",
        params: { message: "from bob" },
        cron: "0 7 * * *",
      });
      const id = created.body.id;

      const outcome = await app.server.scheduler.fire(id);
      expect(outcome.kind).toBe("started");
      const runId = (outcome as { runId: string }).runId;

      const run = await pollUntilTerminal(runId);
      expect(run).toMatchObject({
        status: "succeeded",
        source: "schedule",
        scheduleId: id,
        userId: bobId,
        action: "tick",
        params: { message: "from bob" },
        result: { echoed: { message: "from bob", tag: "pinned-tag" } },
      });

      const after = (await alice.get(`/v1/schedules/${id}`)).body;
      expect(after.lastRunId).toBe(runId);
      expect(after.lastFiredAt).not.toBeNull();
      expect(after.lastError).toBeNull();

      // REST hands the new fields back too.
      const viaRest = await alice.get(`/v1/runs/${runId}`);
      expect(viaRest.body).toMatchObject({ source: "schedule", scheduleId: id, userId: bobId });
    });

    it("fires two schedules on the same service and action, each with its own params and runs", async () => {
      const make = async (message: string, cron: string) =>
        (await bob.post(`/v1/bundles/${bundleId}/schedules`, { service: "jobs", action: "tick", params: { message }, cron }))
          .body.id as string;
      const morning = await make("morning", "0 7 * * *");
      const evening = await make("evening", "30 18 * * 1-5");

      const first = await app.server.scheduler.fire(morning);
      const second = await app.server.scheduler.fire(evening);
      expect(first.kind).toBe("started");
      expect(second.kind).toBe("started");
      const runIds = [first, second].map((o) => (o as { runId: string }).runId);
      expect(runIds[0]).not.toBe(runIds[1]);

      for (const [runId, scheduleId, message] of [
        [runIds[0]!, morning, "morning"],
        [runIds[1]!, evening, "evening"],
      ]) {
        const run = await pollUntilTerminal(runId!);
        expect(run).toMatchObject({
          status: "succeeded",
          source: "schedule",
          scheduleId,
          userId: bobId,
          params: { message },
          result: { echoed: { message, tag: "pinned-tag" } },
        });
        const schedule = (await alice.get(`/v1/schedules/${scheduleId}`)).body;
        expect(schedule.lastRunId).toBe(runId);
        expect(schedule.cron).toBe(scheduleId === morning ? "0 7 * * *" : "30 18 * * 1-5");
      }
      const scheduled = (await runsOfService(serviceId)).filter((r) => r.scheduleId === morning || r.scheduleId === evening);
      expect(scheduled.map((r) => r.scheduleId).sort()).toEqual([morning, evening].sort());
    });

    it("skips a tick while its previous run is still going, and records the skip rather than a failed run", async () => {
      const created = await alice.post(`/v1/bundles/${bundleId}/schedules`, {
        service: "jobs",
        action: "hang",
        cron: "0 7 * * *",
      });
      const id = created.body.id;
      const before = (await runsOfService(serviceId)).length;

      const first = await app.server.scheduler.fire(id);
      expect(first.kind).toBe("started");
      expect(await app.server.scheduler.fire(id)).toEqual({ kind: "skipped" });

      const skipped = (await alice.get(`/v1/schedules/${id}`)).body;
      expect(skipped.lastSkippedAt).not.toBeNull();
      expect(skipped.lastRunId).toBe((first as { runId: string }).runId);
      expect((await runsOfService(serviceId)).length).toBe(before + 1);

      // Once it finishes, the next tick runs again.
      await waitForHang();
      releaseAll();
      await pollUntilTerminal((first as { runId: string }).runId);
      expect((await app.server.scheduler.fire(id)).kind).toBe("started");
      await waitForHang();
      releaseAll();
    });

    it("does nothing for a disabled schedule", async () => {
      const created = await alice.post(`/v1/bundles/${bundleId}/schedules`, {
        service: "jobs",
        action: "tick",
        params: { message: "x" },
        cron: "0 7 * * *",
        enabled: false,
      });
      expect(await app.server.scheduler.fire(created.body.id)).toEqual({ kind: "disabled" });
      expect(await app.server.scheduler.fire("no-such-schedule")).toEqual({ kind: "gone" });
    });

    it("disables itself, says why, and starts no run when the owner loses run_services", async () => {
      const carol = await sysadmin.post("/v1/users", { name: "Carol" });
      const carolApi = apiClient(app.baseUrl, carol.body.initialKey.key);
      await alice.post(`/v1/bundles/${bundleId}/grants`, {
        userId: carol.body.user.id,
        capabilities: ["run_services"],
        effect: "allow",
      });
      const created = await carolApi.post(`/v1/bundles/${bundleId}/schedules`, {
        service: "jobs",
        action: "tick",
        params: { message: "carol" },
        cron: "0 7 * * *",
      });
      expect(created.status).toBe(201);
      const id = created.body.id;

      // An explicit deny: Carol keeps a foothold, so this is a 403 underneath.
      await alice.post(`/v1/bundles/${bundleId}/grants`, {
        userId: carol.body.user.id,
        capabilities: ["run_services"],
        effect: "deny",
      });
      const before = (await runsOfService(serviceId)).length;
      const outcome = await app.server.scheduler.fire(id);
      expect(outcome.kind).toBe("capability_lost");
      expect((await runsOfService(serviceId)).length).toBe(before);

      const after = (await alice.get(`/v1/schedules/${id}`)).body;
      expect(after.enabled).toBe(false);
      expect(after.lastError).toMatch(/owner no longer holds run_services/);

      // Re-enabling needs the owner to hold run_services again.
      expect((await carolApi.patch(`/v1/schedules/${id}`, { enabled: true })).status).toBe(403);

      // Losing every foothold (a 404 underneath) counts the same.
      const dave = await sysadmin.post("/v1/users", { name: "Dave" });
      const daveApi = apiClient(app.baseUrl, dave.body.initialKey.key);
      const daveGrant = await alice.post(`/v1/bundles/${bundleId}/grants`, {
        userId: dave.body.user.id,
        capabilities: ["run_services"],
        effect: "allow",
      });
      const daves = await daveApi.post(`/v1/bundles/${bundleId}/schedules`, {
        service: "jobs",
        action: "tick",
        params: { message: "dave" },
        cron: "0 7 * * *",
      });
      for (const row of daveGrant.body.data as Array<{ id: string }>) {
        await alice.delete(`/v1/bundles/${bundleId}/grants/${row.id}`);
      }
      expect((await app.server.scheduler.fire(daves.body.id)).kind).toBe("capability_lost");
    });

    it("judges the owner by their own grants, not by the token scope of whoever is calling", async () => {
      const created = await alice.post(`/v1/bundles/${bundleId}/schedules`, {
        service: "jobs",
        action: "tick",
        params: { message: "scoped" },
        cron: "0 7 * * *",
      });
      // A read-only token in scope would deny run_services if it leaked into the tick.
      const outcome = await runWithTokenAuth(
        { userId: viewerId, grantId: "g", scope: { role: "read-only" } },
        () => app.server.scheduler.fire(created.body.id),
      );
      expect(outcome.kind).toBe("started");
      expect((await getSchedule(env, aliceId, created.body.id)).enabled).toBe(true);
    });
  });

  describe("authoring from an OAuth token", () => {
    // A member-scoped login that can run services can schedule them: every
    // fire re-checks the owner's run_services, so no wider role is needed.
    it("lets a member-scoped token create, change, re-enable and delete its owner's schedule over REST", async () => {
      const { access_token, scope } = await connectApp(app.baseUrl, bobKey, "role:member");
      expect(scope).toBe("role:member");
      await expectOwnScheduleLifecycleOverRest(apiClient(app.baseUrl, access_token), bobId);
    });

    it("lets a member-scoped token do the same over MCP", async () => {
      const { access_token } = await connectApp(app.baseUrl, bobKey, "role:member");
      const agent = await connectMcp(app.baseUrl, access_token);
      try {
        await expectOwnScheduleLifecycleOverMcp(agent, bobId);
      } finally {
        await agent.close();
      }
    });

    it("still refuses a read-only token, which cannot run services", async () => {
      const { access_token } = await connectApp(app.baseUrl, bobKey, "role:read-only");
      const res = await apiClient(app.baseUrl, access_token).post(`/v1/bundles/${bundleId}/schedules`, {
        service: "jobs",
        action: "tick",
        params: { message: "x" },
        cron: "0 7 * * *",
      });
      expect(res.status).toBe(403);
    });
  });

  describe("run sources", () => {
    it("records rest, mcp and hook as the source, with the caller as user", async () => {
      const viaRest = await alice.post(`/v1/services/${serviceId}/run`, {
        action: "tick",
        params: { message: "r" },
      });
      expect(viaRest.body).toMatchObject({ source: "rest", userId: aliceId, scheduleId: null });

      const agent = await connectMcp(app.baseUrl, aliceKey);
      try {
        const res = await agent.call("call", {
          space_id: spaceId,
          calls: [
            { tool: "run_service", bundle_id: bundleId, params: { id: "jobs", action: "tick", params: { message: "m" } } },
          ],
        });
        expect(res.results[0].result).toMatchObject({ source: "mcp", userId: aliceId, scheduleId: null });
      } finally {
        await agent.close();
      }

      const hook = await alice.post(`/v1/bundles/${bundleId}/hooks`, {
        name: "legacy",
        transport: { url: `http://127.0.0.1:${targetPort}/hook`, method: "POST" },
      });
      expect(hook.status).toBe(201);
      expect((await alice.post(`/v1/hooks/${hook.body.id}/fire`, {})).status).toBe(200);
      const runs = (await alice.get(`/v1/bundles/${bundleId}/runs?service=legacy`)).body.data;
      expect(runs[0]).toMatchObject({ source: "hook", userId: aliceId });
    });
  });

  describe("cron timing (fake timers)", () => {
    it.runIf(adapter.dialect === "sqlite")(
      "fires at the cron time in the schedule's timezone, stops when disabled and resumes when re-enabled",
      async () => {
        // A bundle of its own, and every earlier schedule switched off: start()
        // arms every enabled schedule in the database, and earlier tests'
        // crons must not share this clock.
        const timedBundle = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "timed" })).body.id;
        const timedService = (
          await alice.post(`/v1/bundles/${timedBundle}/services`, { name: "jobs", driver: "sched", config: {} })
        ).body.id;
        for (const row of await app.db.client.select().from(app.db.tables.schedules)) {
          if (row.enabled === 1) await updateSchedule(env, row.ownerId, row.id, { enabled: false });
        }
        const runsOf = async (scheduleId: string) =>
          (
            await listRuns({ ...env, registry: app.server.registry }, aliceId, timedBundle, { service: timedService })
          ).data.filter((r) => r.scheduleId === scheduleId);

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: new Date("2026-03-02T07:59:30Z") });
        const scheduler = createScheduler({ ...env, registry: app.server.registry });
        const timedEnv: ScheduleEnv = { ...env, scheduler };
        try {
          // 09:00 in Copenhagen is 08:00Z in March (CET); 09:00 in New York is 14:00Z (EST).
          const cph = await createSchedule(timedEnv, aliceId, timedBundle, {
            service: "jobs",
            action: "tick",
            params: { message: "cph" },
            cron: "0 9 * * *",
            timezone: "Europe/Copenhagen",
          });
          const nyc = await createSchedule(timedEnv, aliceId, timedBundle, {
            service: "jobs",
            action: "tick",
            params: { message: "nyc" },
            cron: "0 9 * * *",
            timezone: "America/New_York",
          });
          expect(cph.nextFireAt).toBe("2026-03-02T08:00:00.000Z");
          expect(nyc.nextFireAt).toBe("2026-03-02T14:00:00.000Z");

          await scheduler.start();

          await vi.advanceTimersByTimeAsync(20_000); // 07:59:50Z
          expect(await runsOf(cph.id)).toHaveLength(0);
          await vi.advanceTimersByTimeAsync(15_000); // 08:00:05Z
          const fired = await runsOf(cph.id);
          expect(fired).toHaveLength(1);
          expect(fired[0]).toMatchObject({ source: "schedule", scheduleId: cph.id, userId: aliceId });
          expect(Date.parse(fired[0]!.createdAt)).toBe(Date.parse("2026-03-02T08:00:00.000Z"));
          expect(await runsOf(nyc.id)).toHaveLength(0);

          await vi.advanceTimersByTimeAsync(6 * 3_600_000); // 14:00:05Z
          expect(await runsOf(nyc.id)).toHaveLength(1);

          // Disabled (and moved to every ten minutes, to keep the clock short):
          // half an hour passes with no run, and no restart is involved.
          await updateSchedule(timedEnv, aliceId, cph.id, { enabled: false, cron: "*/10 * * * *" });
          await vi.advanceTimersByTimeAsync(30 * 60_000);
          expect(await runsOf(cph.id)).toHaveLength(1);

          // Re-enabled: it resumes at its next time.
          await updateSchedule(timedEnv, aliceId, cph.id, { enabled: true });
          await vi.advanceTimersByTimeAsync(10 * 60_000);
          expect(await runsOf(cph.id)).toHaveLength(2);
        } finally {
          scheduler.stop();
          vi.useRealTimers();
        }
      },
    );

    it.runIf(adapter.dialect === "sqlite")(
      "fires nothing while the scheduler is not started (YAP_SCHEDULER=off), and authoring still works",
      async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: new Date("2026-03-02T07:59:30Z") });
        const scheduler = createScheduler({ ...env, registry: app.server.registry });
        const offEnv: ScheduleEnv = { ...env, scheduler };
        try {
          const created = await createSchedule(offEnv, aliceId, bundleId, {
            service: "jobs",
            action: "tick",
            params: { message: "off" },
            cron: "* * * * *",
          });
          await updateSchedule(offEnv, aliceId, created.id, { cron: "*/2 * * * *" });
          await vi.advanceTimersByTimeAsync(3 * 60_000);
          const runs = (await runsOfService(serviceId)).filter((r) => r.scheduleId === created.id);
          expect(runs).toHaveLength(0);
          expect(scheduler.started).toBe(false);
          expect((await getSchedule(offEnv, aliceId, created.id)).cron).toBe("*/2 * * * *");
        } finally {
          scheduler.stop();
          vi.useRealTimers();
        }
      },
    );
  });
});
