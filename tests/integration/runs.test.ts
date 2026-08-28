/**
 * Runs: the always-async service executor. Services are authored through REST
 * only from Task 7 onwards, so this suite plants service rows directly and
 * drives `src/core/runs.ts` against a registry holding the built-in http
 * driver plus a tiny in-test driver: short budgets, a well-behaved sleeper, a
 * thrower, and the misbehaving trio the runner has to survive on its own — a
 * driver that ignores its abort signal forever, one that succeeds after the
 * deadline, and one whose result cannot be serialized.
 *
 * What is pinned here: the wait/poll contract, the timeout budget, pinned and
 * declared parameter handling, the audit rows a run leaves behind, the
 * capability gates, and the boot/retention helpers.
 */
import { createServer, type Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DriverRegistry } from "../../src/core/drivers/registry.js";
import { createHttpDriver } from "../../src/core/drivers/http.js";
import { DRIVER_API, type DriverDefinition, type RunContext } from "../../src/core/drivers/types.js";
import {
  getRun,
  listRuns,
  pruneRuns,
  recoverInterruptedRuns,
  runService,
  type RunEnv,
  type RunRecord,
} from "../../src/core/runs.js";
import { encryptSecret } from "../../src/crypto.js";
import { createLogger } from "../../src/logger.js";
import type { Db } from "../../src/db/index.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, getFreePort, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";

interface ReceivedRequest {
  method: string;
  url: string;
  body: string;
}

/** In-test driver: no egress, deterministic actions with short budgets. */
const testDriver: DriverDefinition = {
  name: "test",
  api: DRIVER_API,
  description: "In-test driver with deterministic actions.",
  egress: false,
  validateConfig(): void {},
  actions: {
    echo: {
      description: "Echoes the supplied parameters.",
      params: [
        { name: "message", required: true },
        { name: "tag" },
      ],
      timeoutMs: 5_000,
    },
    sleep: {
      description: "Sleeps past its own budget.",
      params: [],
      timeoutMs: 100,
    },
    boom: {
      description: "Throws a non-YapError.",
      params: [],
      timeoutMs: 5_000,
    },
    stuck: {
      description: "Ignores the abort signal and never settles at all.",
      params: [],
      timeoutMs: 100,
    },
    late: {
      description: "Ignores the abort signal and succeeds well after the deadline.",
      params: [],
      timeoutMs: 100,
    },
    circular: {
      description: "Succeeds with a result JSON cannot represent.",
      params: [],
      timeoutMs: 5_000,
    },
    abortive: {
      description: "Throws its own AbortError while the budget is still live.",
      params: [],
      timeoutMs: 5_000,
    },
    missing: {
      description: "Fails through ctx.fail — the agent-safe way.",
      params: [],
      timeoutMs: 5_000,
    },
    overreach: {
      description: "Fails through ctx.fail with a code a driver may not claim.",
      params: [],
      timeoutMs: 5_000,
    },
  },
  async run(ctx: RunContext): Promise<unknown> {
    // Deliberately signal-deaf: the runner's deadline, not the driver, has to
    // end these two runs.
    if (ctx.action === "stuck") return await new Promise(() => {});
    if (ctx.action === "late") {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { finished: "too late" };
    }
    if (ctx.action === "circular") {
      const cycle: Record<string, unknown> = { name: "loop" };
      cycle.self = cycle;
      return cycle;
    }
    if (ctx.action === "abortive") {
      throw Object.assign(new Error("driver's own abort, nothing to do with the budget"), { name: "AbortError" });
    }
    if (ctx.action === "sleep") {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ slept: true }), 10_000);
        ctx.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }
    if (ctx.action === "boom") {
      ctx.log("about to explode");
      throw new Error("secret internal detail");
    }
    if (ctx.action === "missing") throw ctx.fail("message 42 is not in INBOX", "not_found");
    // A plain-JS driver can pass any string; the runner must not mint it.
    if (ctx.action === "overreach") throw ctx.fail("nice try", "forbidden" as never);
    return { echoed: ctx.params, config: ctx.config, pinned: ctx.pinned };
  },
};

/**
 * Wraps a drizzle query builder so `effect` runs after the query resolves and
 * before the awaiting caller sees the rows. Every chained method (`.from`,
 * `.where`, …) hands back another wrapper, so the hook survives the chain.
 */
function afterResolve<T extends object>(builder: T, effect: () => Promise<void>): T {
  return new Proxy(builder, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop === "then") {
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          (target as unknown as Promise<unknown>)
            .then(async (rows) => {
              await effect();
              return rows;
            })
            .then(onFulfilled, onRejected);
      }
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const next = (value as (...a: unknown[]) => unknown).apply(target, args);
          return next !== null && typeof next === "object" ? afterResolve(next as object, effect) : next;
        };
      }
      return value;
    },
  });
}

/**
 * A `Db` that runs `effect` the first time a SELECT resolves — the only way to
 * land something *between* the two statements `recoverInterruptedRuns` issues
 * without depending on scheduling luck.
 */
function dbFinishingAfterSelect(db: Db, effect: () => Promise<void>): Db {
  const client = new Proxy(db.client, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== "function") return value;
      const method = value as (...a: unknown[]) => unknown;
      if (prop !== "select") return method.bind(target);
      return (...args: unknown[]) => afterResolve(method.apply(target, args) as object, effect);
    },
  });
  return { ...db, client };
}

describeEachAdapter("runs", (adapter) => {
  let app: TestApp;
  let alice: ApiClient;
  let aliceId: string;
  let viewerId: string;
  let outsiderId: string;
  let spaceId: string;
  let bundleId: string;
  let env: RunEnv;
  /** Everything the runs layer wrote operator-side, newest last. */
  const logged: string[] = [];

  let target: Server;
  let targetPort: number;
  const received: ReceivedRequest[] = [];

  const plantService = async (input: {
    name: string;
    driver?: string;
    params?: Array<{ name: string; required?: boolean }>;
    pins?: Record<string, string>;
    /** Stored verbatim: a test can plant a stale or malformed allowlist. */
    actions?: string | null;
    config: unknown;
    bundle?: string;
  }): Promise<string> => {
    const { services } = app.db.tables;
    const id = `svc-${input.name}`;
    const now = new Date().toISOString();
    await app.db.client.insert(services).values({
      id,
      bundleId: input.bundle ?? bundleId,
      name: input.name,
      description: "",
      driver: input.driver ?? "http",
      params: JSON.stringify(input.params ?? []),
      pins: JSON.stringify(input.pins ?? {}),
      actions: input.actions ?? null,
      configEncrypted: encryptSecret(JSON.stringify(input.config), app.config.masterKey),
      createdAt: now,
      updatedAt: now,
    });
    return id;
  };

  const pollUntilTerminal = async (runId: string, timeoutMs = 8_000): Promise<RunRecord> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await getRun(env, aliceId, runId);
      if (run.status === "succeeded" || run.status === "failed") return run;
      if (Date.now() > deadline) throw new Error(`run ${runId} still ${run.status} after ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  beforeAll(async () => {
    targetPort = await getFreePort();
    target = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ method: req.method!, url: req.url!, body });
        if (req.url?.includes("slow")) {
          setTimeout(() => res.writeHead(200).end("slow response"), 400);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ received: true }));
      });
    });
    await new Promise<void>((resolve) => target.listen(targetPort, "127.0.0.1", resolve));

    app = await bootTestApp(
      { YAP_HOOK_ALLOW_HOSTS: "127.0.0.1", YAP_HOOK_TIMEOUT_MS: "5000" },
      await adapter.makeDb(),
    );
    const registry = new DriverRegistry();
    registry.register(createHttpDriver(app.config));
    registry.register(testDriver);
    // The operator-side sink: a failed run's only readable detail. Captured
    // rather than silenced, so the "failed" tests can assert what it says.
    env = {
      db: app.db,
      blob: app.blob,
      config: app.config,
      registry,
      logger: createLogger({
        debug() {},
        info() {},
        log() {},
        warn: (...args: unknown[]) => void logged.push(args.map(String).join(" ")),
        error: (...args: unknown[]) => void logged.push(args.map(String).join(" ")),
      }),
    };

    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    aliceId = a.body.user.id;
    viewerId = (await sysadmin.post("/v1/users", { name: "Viewer" })).body.user.id;
    outsiderId = (await sysadmin.post("/v1/users", { name: "Outsider" })).body.user.id;

    spaceId = (await alice.post("/v1/spaces", { name: "Runner" })).body.id;
    bundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "services" })).body.id;
    await alice.post(`/v1/bundles/${bundleId}/grants`, {
      userId: viewerId,
      capabilities: ["read_items"],
      effect: "allow",
    });
  });

  afterAll(async () => {
    await app.stop();
    await new Promise<void>((resolve, reject) => target.close((e) => (e ? reject(e) : resolve())));
  });

  describe("executing", () => {
    it("completes within the wait window and records the driver's result", async () => {
      await plantService({
        name: "notify",
        params: [{ name: "message", required: true }],
        config: {
          url: `http://127.0.0.1:${targetPort}/notify`,
          method: "POST",
          headers: { authorization: "Bearer super-secret-token" },
          body_json: { text: "{{message}}" },
        },
      });
      received.length = 0;

      const run = await runService(env, aliceId, bundleId, {
        service: "notify",
        params: { message: "deploy finished" },
        waitMs: 8_000,
      });

      expect(run.status).toBe("succeeded");
      expect(run.serviceName).toBe("notify");
      expect(run.action).toBe("fire"); // the http driver's single action, resolved implicitly
      expect(run.result).toEqual({ status: 200, body: JSON.stringify({ received: true }) });
      expect(run.error).toBeNull();
      expect(run.params).toEqual({ message: "deploy finished" });
      expect(run.startedAt).not.toBeNull();
      expect(run.finishedAt).not.toBeNull();
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0]!.body)).toEqual({ text: "deploy finished" });
    });

    it("returns immediately with waitMs 0 and completes in the background", async () => {
      await plantService({
        name: "slowcall",
        config: { url: `http://127.0.0.1:${targetPort}/slow`, method: "GET" },
      });

      const queued = await runService(env, aliceId, bundleId, { service: "slowcall", waitMs: 0 });
      expect(["queued", "running"]).toContain(queued.status);
      expect(queued.result).toBeNull();
      expect(queued.finishedAt).toBeNull();

      const finished = await pollUntilTerminal(queued.id);
      expect(finished.status).toBe("succeeded");
      expect(finished.result).toEqual({ status: 200, body: "slow response" });
    });

    it("fails a run that outlives its action budget", async () => {
      await plantService({ name: "sleeper", driver: "test", config: {} });
      const run = await runService(env, aliceId, bundleId, {
        service: "sleeper",
        action: "sleep",
        waitMs: 5_000,
      });
      expect(run.status).toBe("failed");
      expect(run.error).toBe("run timed out after 100ms");
      expect(run.result).toBeNull();
      expect(run.finishedAt).not.toBeNull();
    });

    it("fails a run whose driver ignores the signal and never settles", async () => {
      await plantService({ name: "deaf", driver: "test", config: {} });
      // The driver's promise never settles and it never looks at ctx.signal:
      // only the runner owning the budget can end this run. If it did not, the
      // wait below would expire with the row still `running`.
      const run = await runService(env, aliceId, bundleId, {
        service: "deaf",
        action: "stuck",
        waitMs: 3_000,
      });
      expect(run.status).toBe("failed");
      expect(run.error).toBe("run timed out after 100ms");
      expect(run.result).toBeNull();
      expect(run.finishedAt).not.toBeNull();
    });

    it("fails a signal-ignoring run that succeeds after the deadline", async () => {
      await plantService({ name: "tardy", driver: "test", config: {} });
      const run = await runService(env, aliceId, bundleId, {
        service: "tardy",
        action: "late",
        waitMs: 3_000,
      });
      expect(run.status).toBe("failed");
      expect(run.error).toBe("run timed out after 100ms");
      expect(run.result).toBeNull();

      // And it stays failed: the driver's late success must not overwrite the
      // row after the fact.
      await new Promise((resolve) => setTimeout(resolve, 400));
      const later = await getRun(env, aliceId, run.id);
      expect(later.status).toBe("failed");
      expect(later.error).toBe("run timed out after 100ms");
    });

    it("fails a run whose result cannot be serialized instead of stranding it", async () => {
      await plantService({ name: "knotted", driver: "test", config: {} });
      const run = await runService(env, aliceId, bundleId, {
        service: "knotted",
        action: "circular",
        waitMs: 5_000,
      });
      expect(run.status).toBe("failed");
      expect(run.error).toBe("run result could not be serialized");
      expect(run.result).toBeNull();
      expect(run.finishedAt).not.toBeNull();
    });

    it("does not call a driver's own AbortError a timeout", async () => {
      await plantService({ name: "self-aborter", driver: "test", config: {} });
      // The budget here is 5s and never fires; the AbortError is the driver's
      // own, so it must collapse to the generic failure like any other throw.
      const run = await runService(env, aliceId, bundleId, {
        service: "self-aborter",
        action: "abortive",
        waitMs: 5_000,
      });
      expect(run.status).toBe("failed");
      expect(run.error).toBe("run failed");
      expect(run.error).not.toMatch(/timed out/);
    });

    it("caps an action's budget with runTimeoutCapMs", async () => {
      // The cap is read at boot, so this case needs its own app. That second
      // bootTestApp takes no adapter db, so it always runs on SQLite — this
      // leg exercises sqlite even when the outer matrix is on Postgres.
      const capped = await bootTestApp({ YAP_RUN_TIMEOUT_CAP_MS: "80" });
      try {
        const registry = new DriverRegistry();
        registry.register(testDriver);
        const cappedEnv: RunEnv = { db: capped.db, blob: capped.blob, config: capped.config, registry };
        const sysadmin = apiClient(capped.baseUrl, TEST_SYSADMIN_KEY);
        const u = await sysadmin.post("/v1/users", { name: "U" });
        const user = apiClient(capped.baseUrl, u.body.initialKey.key);
        const sid = (await user.post("/v1/spaces", { name: "S" })).body.id;
        const bid = (await user.post(`/v1/spaces/${sid}/bundles`, { name: "b" })).body.id;
        const { services } = capped.db.tables;
        const now = new Date().toISOString();
        await capped.db.client.insert(services).values({
          id: "capped-svc",
          bundleId: bid,
          name: "sleeper",
          description: "",
          driver: "test",
          params: "[]",
          pins: "{}",
          configEncrypted: encryptSecret("{}", capped.config.masterKey),
          createdAt: now,
          updatedAt: now,
        });
        // The action declares 5000ms; the operator cap wins.
        const run = await runService(cappedEnv, u.body.user.id, bid, {
          service: "sleeper",
          action: "sleep",
          waitMs: 5_000,
        });
        expect(run.status).toBe("failed");
        expect(run.error).toBe("run timed out after 80ms");
      } finally {
        await capped.stop();
      }
    });

    it("collapses a non-YapError into a generic failure that leaks nothing", async () => {
      await plantService({ name: "exploder", driver: "test", config: {} });
      const run = await runService(env, aliceId, bundleId, {
        service: "exploder",
        action: "boom",
        waitMs: 5_000,
      });
      expect(run.status).toBe("failed");
      expect(run.error).toBe("run failed");
      expect(JSON.stringify(run)).not.toContain("secret internal detail");
    });

    it("keeps a ctx.fail message and code verbatim on the row", async () => {
      await plantService({ name: "honest-failer", driver: "test", config: {} });
      const run = await runService(env, aliceId, bundleId, {
        service: "honest-failer",
        action: "missing",
        waitMs: 5_000,
      });
      expect(run.status).toBe("failed");
      expect(run.error).toBe("message 42 is not in INBOX");
      expect(run.errorCode).toBe("not_found");

      const overreach = await runService(env, aliceId, bundleId, {
        service: "honest-failer",
        action: "overreach",
        waitMs: 5_000,
      });
      expect(overreach.error).toBe("nice try");
      expect(overreach.errorCode).toBe("invalid_request");
    });

    it("writes a failed run's detail to the operator log and nothing but the flat line to the row", async () => {
      await plantService({ name: "loud-exploder", driver: "test", config: {} });
      logged.length = 0;
      const run = await runService(env, aliceId, bundleId, {
        service: "loud-exploder",
        action: "boom",
        waitMs: 5_000,
      });
      expect(run.status).toBe("failed");

      // One line, naming the run, the service, the action and the verdict…
      const line = logged.find((l) => l.includes(run.id));
      expect(line, logged.join("\n")).toBeDefined();
      expect(line).toContain('service "loud-exploder"');
      expect(line).toContain('action "boom"');
      expect(line).toContain("[internal]");
      expect(line).toContain("run failed");
      // …and carrying the log ring, which is where the real cause lives: what
      // the driver logged itself, and what the collapse threw away.
      expect(line).toContain("about to explode");
      expect(line).toContain("secret internal detail");

      // The agent-visible record still says only the generic thing.
      expect(run.error).toBe("run failed");
      expect(JSON.stringify(await getRun(env, aliceId, run.id))).not.toContain("secret internal detail");
    });

    it("carries the network cause the row collapses into the operator log", async () => {
      // A port nothing is listening on: the http driver collapses the
      // transport error (it can name a hidden host), so ECONNREFUSED reaches
      // the operator only through the ring.
      const deadPort = await getFreePort();
      await plantService({ name: "unreachable", config: { url: `http://127.0.0.1:${deadPort}/x`, method: "GET" } });
      logged.length = 0;
      const run = await runService(env, aliceId, bundleId, { service: "unreachable", waitMs: 8_000 });

      expect(run.status).toBe("failed");
      expect(run.error).toBe("service request failed to reach its destination");

      const line = logged.find((l) => l.includes(run.id));
      expect(line, logged.join("\n")).toBeDefined();
      expect(line).toContain('service "unreachable"');
      expect(line).toMatch(/fetch failed|ECONNREFUSED/);
      // The row learns none of it — not the cause, not the port it tried.
      expect(JSON.stringify(run)).not.toMatch(/fetch failed|ECONNREFUSED/);
      expect(JSON.stringify(run)).not.toContain(String(deadPort));
    });

    it("keeps a driver's agent-safe YapError message", async () => {
      // Planted private destination: the http driver collapses the guard
      // rejection itself, and the run records that message verbatim.
      await plantService({ name: "rebound", config: { url: "http://192.168.0.1/internal", method: "GET" } });
      const run = await runService(env, aliceId, bundleId, { service: "rebound", waitMs: 5_000 });
      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/blocked by the SSRF guard/);
      expect(JSON.stringify(run)).not.toContain("192.168.0.1");
    });
  });

  describe("parameters", () => {
    it("blocks a pinned parameter and injects its value instead", async () => {
      await plantService({
        name: "pinned",
        params: [
          { name: "to", required: true },
          { name: "message", required: true },
        ],
        pins: { to: "ops" },
        config: { url: `http://127.0.0.1:${targetPort}/notify?to={{to}}&message={{message}}`, method: "GET" },
      });

      await expect(
        runService(env, aliceId, bundleId, { service: "pinned", params: { to: "elsewhere", message: "x" } }),
      ).rejects.toThrow(/parameter "to" is fixed by this service configuration/);

      received.length = 0;
      const run = await runService(env, aliceId, bundleId, {
        service: "pinned",
        params: { message: "hi" },
        waitMs: 8_000,
      });
      expect(run.status).toBe("succeeded");
      expect(received[0]!.url).toBe("/notify?to=ops&message=hi");
      // The pinned value reached the driver but not the row: a run record is
      // readable by every run_services holder, so echoing pins back there would
      // hand out the very values pinning exists to keep private.
      expect(run.params).toEqual({ message: "hi" });
      expect(JSON.stringify(run)).not.toContain("ops");
    });

    it("tells the driver which of its parameters were pinned", async () => {
      await plantService({ name: "pin-aware", driver: "test", pins: { tag: "fixed" }, config: {} });
      const run = await runService(env, aliceId, bundleId, {
        service: "pin-aware",
        action: "echo",
        params: { message: "hi" },
        waitMs: 5_000,
      });
      expect(run.status).toBe("succeeded");
      expect((run.result as { pinned: string[] }).pinned).toEqual(["tag"]);
      // An unpinned service sees an empty list, never undefined.
      await plantService({ name: "pin-free", driver: "test", config: {} });
      const plain = await runService(env, aliceId, bundleId, {
        service: "pin-free",
        action: "echo",
        params: { message: "hi" },
        waitMs: 5_000,
      });
      expect((plain.result as { pinned: string[] }).pinned).toEqual([]);
    });

    it("rejects unknown and missing parameters", async () => {
      await expect(
        runService(env, aliceId, bundleId, { service: "notify", params: { message: "x", url: "http://evil" } }),
      ).rejects.toThrow(/unknown parameter "url"/);
      await expect(runService(env, aliceId, bundleId, { service: "notify", params: {} })).rejects.toThrow(
        /required parameter "message" is missing/,
      );
      await expect(
        runService(env, aliceId, bundleId, { service: "notify", params: { message: { a: 1 } } }),
      ).rejects.toThrow(/must be a scalar/);
    });

    it("takes the parameter specs from the driver action when it declares them", async () => {
      await plantService({
        name: "echoer",
        driver: "test",
        params: [{ name: "ignored" }], // the action's own specs win
        config: { some: "config" },
      });
      await expect(
        runService(env, aliceId, bundleId, { service: "echoer", action: "echo", params: { ignored: "x" } }),
      ).rejects.toThrow(/unknown parameter "ignored"/);
      const run = await runService(env, aliceId, bundleId, {
        service: "echoer",
        action: "echo",
        params: { message: "hello", tag: 7 },
        waitMs: 5_000,
      });
      expect(run.status).toBe("succeeded");
      expect(run.result).toMatchObject({ echoed: { message: "hello", tag: "7" } });
    });
  });

  describe("resolution", () => {
    it("names the actions when the driver has more than one and none was given", async () => {
      await expect(runService(env, aliceId, bundleId, { service: "echoer" })).rejects.toThrow(
        /echo.*sleep|sleep.*echo/s,
      );
    });

    it("rejects an unknown action", async () => {
      await expect(runService(env, aliceId, bundleId, { service: "echoer", action: "nope" })).rejects.toThrow(
        /unknown action "nope"/,
      );
    });

    it("resolves over the service's allowlist, not the driver's full action set", async () => {
      await plantService({ name: "echo-only", driver: "test", actions: JSON.stringify(["echo"]), config: {} });
      // The driver has seven actions; this service has one, so it is implicit.
      const run = await runService(env, aliceId, bundleId, {
        service: "echo-only",
        params: { message: "hi" },
        waitMs: 5_000,
      });
      expect(run.status).toBe("succeeded");
      expect(run.action).toBe("echo");
      // A disabled action is unknown, and the hint never names it.
      await expect(runService(env, aliceId, bundleId, { service: "echo-only", action: "sleep" })).rejects.toThrow(
        /^unknown action "sleep" for service "echo-only" \(available: echo\)$/,
      );

      await plantService({ name: "two-of-seven", driver: "test", actions: JSON.stringify(["echo", "boom"]), config: {} });
      await expect(runService(env, aliceId, bundleId, { service: "two-of-seven" })).rejects.toThrow(
        /^service "two-of-seven" needs an action — one of: echo, boom$/,
      );

      // The stale / malformed allowlist matrix lives in services-core.test.ts
      // (allowedActions is the one computation); here it is enough that the
      // runner's "nothing to run" verdict comes out of it.
      await plantService({ name: "all-stale", driver: "test", actions: JSON.stringify(["gone"]), config: {} });
      await expect(runService(env, aliceId, bundleId, { service: "all-stale", action: "echo" })).rejects.toThrow(
        /^service "all-stale" has no runnable actions$/,
      );
    });

    it("resolves a service by id as well as by name, and explains an empty ref", async () => {
      const byId = await runService(env, aliceId, bundleId, {
        service: "svc-notify",
        params: { message: "by id" },
        waitMs: 8_000,
      });
      expect(byId.status).toBe("succeeded");

      // Shape-explaining, and deliberately free of any tool's own field names:
      // the same message surfaces through run_service, fire_hook, and REST.
      await expect(runService(env, aliceId, bundleId, { service: "  " })).rejects.toThrow(
        /no service specified — pass the service name or id/,
      );
      await expect(runService(env, aliceId, bundleId, { service: "ghost" })).rejects.toThrow(/not found/);
    });

    it("keeps a run after its service is deleted", async () => {
      const serviceId = await plantService({ name: "doomed", driver: "test", config: {} });
      const run = await runService(env, aliceId, bundleId, {
        service: "doomed",
        action: "echo",
        params: { message: "last words" },
        waitMs: 5_000,
      });
      expect(run.status).toBe("succeeded");
      expect(run.serviceId).toBe(serviceId);

      const { services } = app.db.tables;
      await app.db.client.delete(services).where(eq(services.id, serviceId));

      const survivor = await getRun(env, aliceId, run.id);
      expect(survivor.serviceId).toBeNull();
      expect(survivor.serviceName).toBe("doomed");
      expect(survivor.status).toBe("succeeded");
    });
  });

  describe("listing", () => {
    it("lists newest-first, filters by service, and paginates", async () => {
      const listBundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "listing" })).body.id;
      await plantService({ name: "l-one", driver: "test", bundle: listBundleId, config: {} });
      await plantService({ name: "l-two", driver: "test", bundle: listBundleId, config: {} });
      for (const service of ["l-one", "l-one", "l-two"]) {
        await runService(env, aliceId, listBundleId, {
          service,
          action: "echo",
          params: { message: service },
          waitMs: 5_000,
        });
        // Distinct created_at values: the ordering assertion below is about
        // recency, not about the id tiebreaker.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const all = await listRuns(env, aliceId, listBundleId, {});
      expect(all.data).toHaveLength(3);
      expect(all.data[0]!.serviceName).toBe("l-two"); // newest first
      expect(all.nextCursor).toBeNull();

      const filtered = await listRuns(env, aliceId, listBundleId, { service: "l-one" });
      expect(filtered.data.map((r) => r.serviceName)).toEqual(["l-one", "l-one"]);

      const firstPage = await listRuns(env, aliceId, listBundleId, { limit: 2 });
      expect(firstPage.data).toHaveLength(2);
      expect(firstPage.nextCursor).toBeTruthy();
      const secondPage = await listRuns(env, aliceId, listBundleId, {
        limit: 2,
        cursor: firstPage.nextCursor!,
      });
      expect(secondPage.data).toHaveLength(1);
      expect(secondPage.nextCursor).toBeNull();
      const ids = [...firstPage.data, ...secondPage.data].map((r) => r.id);
      expect(new Set(ids).size).toBe(3);
    });
  });

  describe("capability gates", () => {
    it("a member without run_services gets a 403 naming the capability", async () => {
      await expect(runService(env, viewerId, bundleId, { service: "notify" })).rejects.toMatchObject({
        code: "forbidden",
        details: { capability: "run_services" },
      });
      const run = await runService(env, aliceId, bundleId, {
        service: "notify",
        params: { message: "x" },
        waitMs: 8_000,
      });
      await expect(getRun(env, viewerId, run.id)).rejects.toMatchObject({ code: "forbidden" });
      await expect(listRuns(env, viewerId, bundleId, {})).rejects.toMatchObject({ code: "forbidden" });
    });

    it("an outsider gets a not_found that hides the bundle's existence", async () => {
      await expect(runService(env, outsiderId, bundleId, { service: "notify" })).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(listRuns(env, outsiderId, bundleId, {})).rejects.toMatchObject({ code: "not_found" });
    });

    it("an unknown run id is a not_found", async () => {
      await expect(getRun(env, aliceId, "no-such-run")).rejects.toMatchObject({ code: "not_found" });
    });

    it("a run in an invisible bundle 404s as the run, never naming the bundle", async () => {
      const run = await runService(env, aliceId, bundleId, {
        service: "notify",
        params: { message: "private" },
        waitMs: 8_000,
      });
      // An outsider polling a real run id must not be able to tell it apart
      // from an unknown one — the message names the run, never the bundle id
      // the bundle-level not_found would have handed over.
      await expect(getRun(env, outsiderId, run.id)).rejects.toMatchObject({
        code: "not_found",
        message: `run ${run.id} not found`,
      });
    });
  });

  describe("boot recovery and retention", () => {
    it("fails runs interrupted by a restart", async () => {
      const { runs } = app.db.tables;
      const now = new Date().toISOString();
      await app.db.client.insert(runs).values([
        {
          id: "interrupted-running",
          bundleId,
          serviceId: null,
          serviceName: "ghost",
          action: "fire",
          status: "running",
          params: "{}",
          writes: "[]",
          createdAt: now,
          startedAt: now,
        },
        {
          id: "interrupted-queued",
          bundleId,
          serviceId: null,
          serviceName: "ghost",
          action: "fire",
          status: "queued",
          params: "{}",
          writes: "[]",
          createdAt: now,
        },
      ]);

      const recovered = await recoverInterruptedRuns(app.db);
      expect(recovered).toBeGreaterThanOrEqual(2);

      const row = await getRun(env, aliceId, "interrupted-running");
      expect(row.status).toBe("failed");
      expect(row.error).toBe("interrupted by server restart");
      expect(row.finishedAt).not.toBeNull();

      // Idempotent, asserted over the planted rows only: the suite's own
      // waitMs:0 runs may legitimately be in flight when this executes, so the
      // global return count is not something to pin.
      const planted = ["interrupted-running", "interrupted-queued"];
      const before = await app.db.client.select().from(runs).where(inArray(runs.id, planted));
      await recoverInterruptedRuns(app.db);
      const after = await app.db.client.select().from(runs).where(inArray(runs.id, planted));
      const summarize = (rows: typeof after) =>
        rows
          .map((r) => `${r.id}:${r.status}:${r.error}:${r.finishedAt}`)
          .sort()
          .join("|");
      expect(summarize(after)).toBe(summarize(before));
    });

    it("leaves a run that finished between the select and the update alone", async () => {
      const { runs } = app.db.tables;
      const now = new Date().toISOString();
      await app.db.client.insert(runs).values([
        {
          id: "race-finisher",
          bundleId,
          serviceId: null,
          serviceName: "ghost",
          action: "fire",
          status: "running",
          params: "{}",
          writes: "[]",
          createdAt: now,
          startedAt: now,
        },
        {
          id: "race-stranded",
          bundleId,
          serviceId: null,
          serviceName: "ghost",
          action: "fire",
          status: "running",
          params: "{}",
          writes: "[]",
          createdAt: now,
          startedAt: now,
        },
      ]);

      // The window the UPDATE's status condition exists for: both ids are
      // already named by the SELECT when one of the two runs succeeds on its
      // own. Reusing the ids alone would overwrite that good result with
      // "interrupted by server restart".
      let raced = false;
      const racingDb = dbFinishingAfterSelect(app.db, async () => {
        if (raced) return;
        raced = true;
        await app.db.client
          .update(runs)
          .set({ status: "succeeded", result: '{"ok":true}', finishedAt: new Date().toISOString() })
          .where(eq(runs.id, "race-finisher"));
      });

      // Only race-stranded is actually flipped by the UPDATE; the return
      // value must reflect that, not the pre-race SELECT's count of 2.
      const recovered = await recoverInterruptedRuns(racingDb);
      expect(raced).toBe(true);
      expect(recovered).toBe(1);

      const finisher = await getRun(env, aliceId, "race-finisher");
      expect(finisher.status).toBe("succeeded");
      expect(finisher.result).toEqual({ ok: true });
      expect(finisher.error).toBeNull();

      const stranded = await getRun(env, aliceId, "race-stranded");
      expect(stranded.status).toBe("failed");
      expect(stranded.error).toBe("interrupted by server restart");
    });

    it("prunes terminal runs older than the retention window only", async () => {
      const pruneBundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "pruning" })).body.id;
      const { runs } = app.db.tables;
      const nowMs = Date.parse("2026-01-10T00:00:00.000Z");
      const iso = (offsetDays: number) => new Date(nowMs - offsetDays * 86_400_000).toISOString();
      await app.db.client.insert(runs).values([
        {
          id: "old-succeeded",
          bundleId: pruneBundleId,
          serviceName: "s",
          action: "fire",
          status: "succeeded",
          params: "{}",
          writes: "[]",
          createdAt: iso(30),
          startedAt: iso(30),
          finishedAt: iso(30),
        },
        {
          id: "old-failed",
          bundleId: pruneBundleId,
          serviceName: "s",
          action: "fire",
          status: "failed",
          params: "{}",
          writes: "[]",
          createdAt: iso(9),
          startedAt: iso(9),
          finishedAt: iso(9),
        },
        {
          id: "young-succeeded",
          bundleId: pruneBundleId,
          serviceName: "s",
          action: "fire",
          status: "succeeded",
          params: "{}",
          writes: "[]",
          createdAt: iso(1),
          startedAt: iso(1),
          finishedAt: iso(1),
        },
        {
          id: "old-running",
          bundleId: pruneBundleId,
          serviceName: "s",
          action: "fire",
          status: "running",
          params: "{}",
          writes: "[]",
          createdAt: iso(30),
          startedAt: iso(30),
        },
      ]);

      const deleted = await pruneRuns(app.db, 7, nowMs);
      expect(deleted).toBe(2);
      const left = await app.db.client.select().from(runs).where(eq(runs.bundleId, pruneBundleId));
      expect(left.map((r) => r.id).sort()).toEqual(["old-running", "young-succeeded"]);
    });

    it("leaves fresh rows in other bundles alone when pruning by age", async () => {
      const { runs } = app.db.tables;
      const scoped = () =>
        app.db.client
          .select()
          .from(runs)
          .where(and(eq(runs.bundleId, bundleId), eq(runs.status, "succeeded")));
      const before = await scoped();
      expect(before.length).toBeGreaterThan(0);

      // Pruning is age-scoped, not bundle-scoped: a real sweep against the
      // real clock must leave every run this suite just made, wherever it is.
      await pruneRuns(app.db, 7);

      const after = await scoped();
      expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
    });
  });
});
