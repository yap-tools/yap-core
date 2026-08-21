/**
 * Services core: authoring, the agent-visible listing, and the bundle writer.
 *
 * This suite drives `src/core/services.ts` (and the writer half of
 * `src/core/runs.ts`) directly — the REST surface arrives in a later task, so
 * the core functions are the contract under test here. It uses a registry of
 * three drivers: the built-in http one (the only one with an online config
 * check), a plain in-test driver that declares no writes, and a writing driver
 * that reaches the item layer through `ctx.writer`.
 *
 * What is pinned: the capability split (`edit_services` authors,
 * `run_services` does not), the authoring-time validation that would otherwise
 * fail at fire time (unknown driver, bad param names, pins that name nothing
 * or hold non-scalars, configs the driver rejects offline *and* online), the
 * effective per-action parameter view with pins stripped, and the writer —
 * scoped to its run's bundle, audited on the run row, absent for a driver that
 * never declared writes.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHttpDriver } from "../../src/core/drivers/http.js";
import { DriverRegistry } from "../../src/core/drivers/registry.js";
import { DRIVER_API, type BundleWriter, type DriverDefinition, type RunContext } from "../../src/core/drivers/types.js";
import { createItemType } from "../../src/core/itemTypes.js";
import { queryItems } from "../../src/core/items.js";
import { getRun, runService, type RunEnv } from "../../src/core/runs.js";
import {
  createService,
  deleteService,
  getServiceBundleId,
  listServices,
  listServicesUnchecked,
  updateService,
  type ServiceEnv,
} from "../../src/core/services.js";
import { decryptSecret, encryptSecret } from "../../src/crypto.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";

/** A driver with no writes at all: its runs must see `ctx.writer === null`. */
const plainDriver: DriverDefinition = {
  name: "plain",
  api: DRIVER_API,
  description: "In-test driver that declares no write surfaces.",
  egress: false,
  validateConfig(config: unknown): void {
    if ((config as { bad?: boolean } | null)?.bad) throw new Error("field \"bad\" is not allowed");
  },
  actions: {
    inspect: {
      description: "Reports what the run context handed it.",
      params: [{ name: "note" }],
      timeoutMs: 5_000,
    },
    other: {
      description: "A second action, so the effective view has two entries.",
      params: null, // takes the service record's specs
      timeoutMs: 5_000,
    },
  },
  async run(ctx: RunContext): Promise<unknown> {
    return { hasWriter: ctx.writer !== null, hasEgress: ctx.egress !== null, params: ctx.params };
  },
};

/** Set by the `escape` action so a test can use the handle after the run. */
let escapedWriter: BundleWriter | null = null;

const writingDriver: DriverDefinition = {
  name: "writer",
  api: DRIVER_API,
  description: "In-test driver that writes items back into its bundle.",
  egress: false,
  writes: { items: true },
  validateConfig(): void {},
  actions: {
    record: {
      description: "Creates one item of the named item-type.",
      params: [
        { name: "itemType", required: true },
        { name: "title", required: true },
      ],
      timeoutMs: 5_000,
    },
    batch: {
      description: "Creates two items in one call.",
      params: [{ name: "itemType", required: true }],
      timeoutMs: 5_000,
    },
    bogus: {
      description: "Writes an item the item-type's schema will refuse.",
      params: [{ name: "itemType", required: true }],
      timeoutMs: 5_000,
    },
    escape: {
      description: "Stashes its writer handle and returns without writing.",
      params: [],
      timeoutMs: 5_000,
    },
    detached: {
      description: "Starts a write without awaiting it and returns at once.",
      params: [{ name: "itemType", required: true }],
      timeoutMs: 5_000,
    },
  },
  async run(ctx: RunContext): Promise<unknown> {
    const writer = ctx.writer!;
    if (ctx.action === "escape") {
      escapedWriter = writer;
      return { stashed: true };
    }
    if (ctx.action === "detached") {
      // Deliberately not awaited: the write is still in flight when the run
      // ends. The items land regardless, so their audit entry has to reach the
      // run row too — the write handle drains before the outcome is written.
      void writer.createItems(ctx.params.itemType!, [{ title: "landed late" }]).catch(() => {});
      return { detached: true };
    }
    if (ctx.action === "batch") {
      return { ids: await writer.createItems(ctx.params.itemType!, [{ title: "one" }, { title: "two" }]) };
    }
    if (ctx.action === "bogus") {
      return { ids: await writer.createItems(ctx.params.itemType!, [{ nonsense: "no such property" }]) };
    }
    return { ids: await writer.createItems(ctx.params.itemType!, [{ title: ctx.params.title }]) };
  },
};

describeEachAdapter("services core", (adapter) => {
  let app: TestApp;
  let alice: ApiClient;
  let aliceId: string;
  let runnerId: string; // run_services but not edit_services
  let viewerId: string; // read_items only
  let outsiderId: string;
  let spaceId: string;
  let bundleId: string;
  let otherBundleId: string;
  let env: ServiceEnv & RunEnv;

  const httpConfig = { url: "https://example.com/hook", method: "POST" as const, body_json: { text: "{{message}}" } };

  beforeAll(async () => {
    app = await bootTestApp({ YAP_HOOK_ALLOW_HOSTS: "" }, await adapter.makeDb());
    const registry = new DriverRegistry();
    registry.register(createHttpDriver(app.config));
    registry.register(plainDriver);
    registry.register(writingDriver);
    // A resolver that keeps the online config check off the real network:
    // example.com is public, internal.corp is not.
    const resolver = async (hostname: string): Promise<string[]> =>
      hostname === "internal.corp" ? ["10.1.2.3"] : ["93.184.216.34"];
    env = { db: app.db, config: app.config, registry, resolver };

    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    aliceId = a.body.user.id;
    runnerId = (await sysadmin.post("/v1/users", { name: "Runner" })).body.user.id;
    viewerId = (await sysadmin.post("/v1/users", { name: "Viewer" })).body.user.id;
    outsiderId = (await sysadmin.post("/v1/users", { name: "Outsider" })).body.user.id;

    spaceId = (await alice.post("/v1/spaces", { name: "Services" })).body.id;
    bundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "main" })).body.id;
    otherBundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "other" })).body.id;
    for (const [userId, capabilities] of [
      [runnerId, ["run_services", "read_items"]],
      [viewerId, ["read_items"]],
    ] as const) {
      for (const bundle of [bundleId, otherBundleId]) {
        await alice.post(`/v1/bundles/${bundle}/grants`, { userId, capabilities, effect: "allow" });
      }
    }

    // "Note" exists in both bundles; "Ledger" only in the other one — the
    // writer-scoping assertions rest on that asymmetry.
    for (const bundle of [bundleId, otherBundleId]) {
      await createItemType(app.db, aliceId, bundle, {
        name: "Note",
        properties: [{ name: "title", datatype: "text", required: true }],
      });
    }
    await createItemType(app.db, aliceId, otherBundleId, {
      name: "Ledger",
      properties: [{ name: "title", datatype: "text" }],
    });
    // A unique-constrained type: the writer's uniqueness guard is asserted
    // against it below.
    await createItemType(app.db, aliceId, bundleId, {
      name: "Ticket",
      properties: [{ name: "title", datatype: "text", required: true, config: { unique: true } }],
    });
  });

  afterAll(async () => {
    await app.stop();
  });

  describe("authoring", () => {
    it("creates, lists, updates, and deletes a service", async () => {
      const created = await createService(env, aliceId, bundleId, {
        name: "notify",
        description: "Tells the team",
        params: [{ name: "message", required: true }],
        config: httpConfig,
      });
      expect(created.driver).toBe("http"); // defaulted
      expect(created.description).toBe("Tells the team");
      expect(created.actions).toEqual([
        {
          name: "fire",
          description: "Fire the configured HTTP request, substituting declared parameters.",
          params: [{ name: "message", required: true }],
        },
      ]);
      expect(await getServiceBundleId(app.db, created.id)).toBe(bundleId);

      const listed = await listServices(env, aliceId, bundleId);
      expect(listed.map((s) => s.name)).toContain("notify");
      expect(listed).toEqual(await listServicesUnchecked(env, bundleId));

      const renamed = await updateService(env, aliceId, created.id, {
        name: "  announce  ",
        description: "Renamed",
        params: [{ name: "message", required: true }, { name: "channel" }],
      });
      expect(renamed.name).toBe("announce"); // trimmed
      expect(renamed.description).toBe("Renamed");
      expect(renamed.actions[0]!.params.map((p) => p.name)).toEqual(["message", "channel"]);

      await deleteService(env, aliceId, created.id);
      expect((await listServices(env, aliceId, bundleId)).map((s) => s.name)).not.toContain("announce");
      await expect(updateService(env, aliceId, created.id, { name: "x" })).rejects.toMatchObject({
        code: "not_found",
      });
    });

    it("never returns the config, and re-encrypts it on update", async () => {
      const svc = await createService(env, aliceId, bundleId, {
        name: "secretive",
        params: [{ name: "message" }],
        config: { ...httpConfig, headers: { authorization: "Bearer super-secret-token" } },
      });
      expect(JSON.stringify(svc)).not.toContain("super-secret-token");
      expect(JSON.stringify(await listServices(env, aliceId, bundleId))).not.toContain("super-secret-token");

      await updateService(env, aliceId, svc.id, {
        config: { ...httpConfig, headers: { authorization: "Bearer rotated-token" } },
      });
      const { services } = app.db.tables;
      const [row] = await app.db.client.select().from(services).where(eq(services.id, svc.id));
      const stored = JSON.parse(decryptSecret(row!.configEncrypted, app.config.masterKey));
      expect(stored.headers.authorization).toBe("Bearer rotated-token");
      expect(row!.configEncrypted).not.toContain("rotated-token"); // encrypted at rest
    });

    it("requires a name and rejects a clash within the bundle", async () => {
      await expect(createService(env, aliceId, bundleId, { name: "   ", config: httpConfig })).rejects.toThrow(
        /service name is required/,
      );
      const first = await createService(env, aliceId, bundleId, { name: "clashing", config: httpConfig });
      await expect(createService(env, aliceId, bundleId, { name: " clashing ", config: httpConfig })).rejects.toThrow(
        /already exists in this bundle/,
      );
      // The same name in another bundle is fine, and renaming onto itself is
      // not a clash.
      await createService(env, aliceId, otherBundleId, { name: "clashing", config: httpConfig });
      await updateService(env, aliceId, first.id, { name: "clashing" });
      await expect(updateService(env, aliceId, first.id, { name: "  " })).rejects.toThrow(/cannot be empty/);
    });

    it("rejects an unknown driver and names the installed ones", async () => {
      await expect(
        createService(env, aliceId, bundleId, { name: "nope", driver: "smoke-signal", config: {} }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await expect(
        createService(env, aliceId, bundleId, { name: "nope", driver: "smoke-signal", config: {} }),
      ).rejects.toThrow(/unknown driver "smoke-signal" \(installed: .*http.*\)/);
    });

    it("rejects malformed parameter specs", async () => {
      await expect(
        createService(env, aliceId, bundleId, { name: "badparam", params: [{ name: "has space" }], config: httpConfig }),
      ).rejects.toThrow(/invalid service parameter name/);
      await expect(
        createService(env, aliceId, bundleId, {
          name: "dupparam",
          params: [{ name: "a" }, { name: "a" }],
          config: httpConfig,
        }),
      ).rejects.toThrow(/duplicate service parameter "a"/);
    });

    it("rejects a pin that names nothing or holds a non-scalar", async () => {
      await expect(
        createService(env, aliceId, bundleId, {
          name: "ghostpin",
          params: [{ name: "message" }],
          pins: { channel: "ops" },
          config: httpConfig,
        }),
      ).rejects.toThrow(/pinned parameter "channel" is not declared/);
      await expect(
        createService(env, aliceId, bundleId, {
          name: "objectpin",
          params: [{ name: "message" }],
          // Deliberately past the type: the runtime check is the one under test.
          pins: { message: { deep: "value" } } as unknown as Record<string, string>,
          config: httpConfig,
        }),
      ).rejects.toThrow(/pinned parameter "message" must be a string, number, or boolean/);

      // And the same rules hold on update, including when narrowing the params
      // orphans a pin that was legal when it was set.
      const svc = await createService(env, aliceId, bundleId, {
        name: "pinnable",
        params: [{ name: "message" }, { name: "channel" }],
        pins: { channel: "ops" },
        config: httpConfig,
      });
      await expect(updateService(env, aliceId, svc.id, { params: [{ name: "message" }] })).rejects.toThrow(
        /pinned parameter "channel" is not declared/,
      );
      // Clearing the pins first makes the same narrowing legal.
      const cleared = await updateService(env, aliceId, svc.id, { params: [{ name: "message" }], pins: null });
      expect(cleared.actions[0]!.params.map((p) => p.name)).toEqual(["message"]);
    });

    it("accepts a pin naming a parameter the driver's action declares", async () => {
      const svc = await createService(env, aliceId, bundleId, {
        name: "action-pinned",
        driver: "plain",
        pins: { note: "fixed" },
        config: {},
      });
      const inspect = svc.actions.find((a) => a.name === "inspect")!;
      expect(inspect.params).toEqual([]); // the only declared param is pinned away
    });

    it("surfaces the driver's own offline config rejection as an invalid request", async () => {
      await expect(
        createService(env, aliceId, bundleId, { name: "badcfg", driver: "plain", config: { bad: true } }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await expect(
        createService(env, aliceId, bundleId, { name: "badcfg", driver: "plain", config: { bad: true } }),
      ).rejects.toThrow(/invalid config for driver "plain": field "bad" is not allowed/);
      // The http driver throws a YapError of its own; it passes through intact.
      await expect(
        createService(env, aliceId, bundleId, { name: "badhttp", config: { url: "https://x.test/", method: "SEND" } }),
      ).rejects.toThrow(/invalid http service config/);
    });

    it("runs the driver's online config check at create and on config update", async () => {
      // Offline validation passes for both of these — only validateConfigOnline
      // catches them, which is why it has to run at authoring time.
      await expect(
        createService(env, aliceId, bundleId, {
          name: "internal",
          config: { url: "https://internal.corp/webhook", method: "POST" },
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      // Authoring is operator-facing: the detailed guard message is what the
      // operator needs, so it is kept verbatim here (unlike at fire time).
      await expect(
        createService(env, aliceId, bundleId, {
          name: "internal",
          config: { url: "https://internal.corp/webhook", method: "POST" },
        }),
      ).rejects.toThrow(/internal\.corp resolves to a private.*10\.1\.2\.3/s);

      await expect(
        createService(env, aliceId, bundleId, { name: "ftp", config: { url: "ftp://example.com/x", method: "GET" } }),
      ).rejects.toThrow(/must be http\(s\)/);

      // No service row was left behind by either rejection.
      expect((await listServicesUnchecked(env, bundleId)).map((s) => s.name)).not.toContain("internal");

      const svc = await createService(env, aliceId, bundleId, { name: "reachable", config: httpConfig });
      await expect(
        updateService(env, aliceId, svc.id, { config: { url: "https://internal.corp/webhook", method: "POST" } }),
      ).rejects.toThrow(/resolves to a private/);
      // The stored config is untouched by the rejected update.
      const { services } = app.db.tables;
      const [row] = await app.db.client.select().from(services).where(eq(services.id, svc.id));
      expect(JSON.parse(decryptSecret(row!.configEncrypted, app.config.masterKey)).url).toBe(httpConfig.url);
    });

    it("shows every action with its effective parameters, pins removed", async () => {
      const svc = await createService(env, aliceId, bundleId, {
        name: "two-actions",
        driver: "plain",
        params: [{ name: "shared", required: true }, { name: "hidden" }],
        pins: { hidden: "fixed", note: 7 },
        config: {},
      });
      expect(svc.actions).toEqual([
        // `inspect` declares its own specs; `note` is pinned away.
        { name: "inspect", description: plainDriver.actions.inspect!.description, params: [] },
        // `other` declares null, so it adopts the service's specs; `hidden` is
        // pinned away there too.
        {
          name: "other",
          description: plainDriver.actions.other!.description,
          params: [{ name: "shared", required: true }],
        },
      ]);
    });

    it("scopes a pin to the actions that declare its parameter", async () => {
      // `note` is declared by `inspect` alone; `other` adopts the service's
      // specs, which do not include it. A pin is per-parameter, so it reaches
      // exactly the action that has that parameter.
      const svc = await createService(env, aliceId, bundleId, {
        name: "action-scoped-pin",
        driver: "plain",
        params: [{ name: "shared" }],
        pins: { note: "fixed" },
        config: {},
      });
      expect(svc.actions.find((a) => a.name === "inspect")!.params).toEqual([]);
      // The other action is untouched: its own parameter stays callable and the
      // pin adds nothing to it.
      expect(svc.actions.find((a) => a.name === "other")!.params).toEqual([{ name: "shared" }]);

      // The declaring action gets the pinned value injected…
      const injected = await runService(env, aliceId, bundleId, {
        service: svc.id,
        action: "inspect",
        waitMs: 5_000,
      });
      expect(injected.status).toBe("succeeded");
      expect((injected.result as { params: Record<string, string> }).params).toEqual({ note: "fixed" });
      // …and refuses to let the caller name it.
      await expect(
        runService(env, aliceId, bundleId, { service: svc.id, action: "inspect", params: { note: "mine" } }),
      ).rejects.toThrow(/parameter "note" is fixed by this service configuration/);

      // The action that never declared `note` neither receives it…
      const untouched = await runService(env, aliceId, bundleId, {
        service: svc.id,
        action: "other",
        params: { shared: "value" },
        waitMs: 5_000,
      });
      expect(untouched.status).toBe("succeeded");
      expect((untouched.result as { params: Record<string, string> }).params).toEqual({ shared: "value" });
      // …nor treats it as a parameter of its own: it is simply unknown here,
      // not "fixed by configuration".
      await expect(
        runService(env, aliceId, bundleId, { service: svc.id, action: "other", params: { note: "mine" } }),
      ).rejects.toThrow(/unknown parameter "note"/);
    });
  });

  describe("action allowlists", () => {
    it("creates a service exposing only the allowed actions, in the driver's order", async () => {
      const svc = await createService(env, aliceId, bundleId, {
        name: "read-only",
        driver: "plain",
        params: [{ name: "shared" }],
        actions: ["other"],
        config: {},
      });
      expect(svc.actions.map((a) => a.name)).toEqual(["other"]);
      // The listing agrees with the create response, and the driver's full
      // action set is nowhere in it.
      const listed = (await listServices(env, aliceId, bundleId)).find((s) => s.id === svc.id)!;
      expect(listed.actions.map((a) => a.name)).toEqual(["other"]);
      expect(JSON.stringify(listed)).not.toContain("inspect");
    });

    it("rejects an allowlist that is empty, repeats itself, or names an unknown action", async () => {
      const base = { name: "bad-allowlist", driver: "plain", config: {} };
      await expect(createService(env, aliceId, bundleId, { ...base, actions: [] })).rejects.toThrow(
        /service actions must be a non-empty array of action names/,
      );
      await expect(
        createService(env, aliceId, bundleId, { ...base, actions: ["inspect", "inspect"] }),
      ).rejects.toThrow(/duplicate action "inspect"/);
      await expect(createService(env, aliceId, bundleId, { ...base, actions: ["inspect", "nope"] })).rejects.toThrow(
        /unknown action "nope" for driver "plain" \(declared: inspect, other\)/,
      );
      await expect(
        createService(env, aliceId, bundleId, { ...base, actions: [7] as unknown as string[] }),
      ).rejects.toThrow(/service actions must be a non-empty array of action names/);
      await expect(
        createService(env, aliceId, bundleId, { ...base, actions: "inspect" as unknown as string[] }),
      ).rejects.toThrow(/service actions must be a non-empty array of action names/);
    });

    it("updates set, replace, and clear the allowlist", async () => {
      const svc = await createService(env, aliceId, bundleId, { name: "narrowing", driver: "plain", config: {} });
      expect(svc.actions.map((a) => a.name)).toEqual(["inspect", "other"]);

      const narrowed = await updateService(env, aliceId, svc.id, { actions: ["inspect"] });
      expect(narrowed.actions.map((a) => a.name)).toEqual(["inspect"]);
      expect((await listServicesUnchecked(env, bundleId)).find((s) => s.id === svc.id)!.actions.map((a) => a.name)).toEqual(
        ["inspect"],
      );

      await expect(updateService(env, aliceId, svc.id, { actions: ["nope"] })).rejects.toThrow(/unknown action "nope"/);
      await expect(updateService(env, aliceId, svc.id, { actions: [] })).rejects.toThrow(/non-empty array/);
      // A rejected patch leaves the stored allowlist alone.
      expect((await listServicesUnchecked(env, bundleId)).find((s) => s.id === svc.id)!.actions.map((a) => a.name)).toEqual(
        ["inspect"],
      );

      const cleared = await updateService(env, aliceId, svc.id, { actions: null });
      expect(cleared.actions.map((a) => a.name)).toEqual(["inspect", "other"]);
      expect((await listServicesUnchecked(env, bundleId)).find((s) => s.id === svc.id)!.actions.map((a) => a.name)).toEqual(
        ["inspect", "other"],
      );
    });

    it("pins are validated against the driver's full action set, not the allowlist", async () => {
      // `note` is declared only by `inspect`, which this service disables. The
      // pin is legal (inert, like any pin on a parameter another action owns)
      // and does not resurface the disabled action.
      const svc = await createService(env, aliceId, bundleId, {
        name: "pin-past-allowlist",
        driver: "plain",
        params: [{ name: "shared" }],
        pins: { note: "fixed" },
        actions: ["other"],
        config: {},
      });
      expect(svc.actions).toEqual([
        { name: "other", description: plainDriver.actions.other!.description, params: [{ name: "shared" }] },
      ]);
    });

    it("runs: a disabled action is unknown, and a lone allowed action is the default", async () => {
      const svc = await createService(env, aliceId, bundleId, {
        name: "only-other",
        driver: "plain",
        params: [{ name: "shared" }],
        actions: ["other"],
        config: {},
      });
      // The driver has two actions, but this service has one — so it is the
      // implicit default, exactly as if the driver declared only it.
      const run = await runService(env, aliceId, bundleId, {
        service: svc.id,
        params: { shared: "v" },
        waitMs: 5_000,
      });
      expect(run.status).toBe("succeeded");
      expect(run.action).toBe("other");

      // The disabled action reads as unknown, and the "available" list never
      // mentions it.
      await expect(runService(env, aliceId, bundleId, { service: svc.id, action: "inspect" })).rejects.toThrow(
        /^unknown action "inspect" for service "only-other" \(available: other\)$/,
      );
    });

    it("needs the driver installed to set an allowlist", async () => {
      const { services } = app.db.tables;
      await app.db.client.insert(services).values({
        id: "svc-no-driver",
        bundleId,
        name: "driverless",
        description: "",
        driver: "gone",
        params: "[]",
        pins: "{}",
        configEncrypted: "v1.x.y.z",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await expect(updateService(env, aliceId, "svc-no-driver", { actions: ["anything"] })).rejects.toThrow(
        /"gone" driver, which is not installed/,
      );
      // Clearing needs it too: null is a change to the driver-vouched half.
      await expect(updateService(env, aliceId, "svc-no-driver", { actions: null })).rejects.toThrow(
        /"gone" driver, which is not installed/,
      );
      await deleteService(env, aliceId, "svc-no-driver");
    });

    it("tolerates a stale or malformed stored allowlist", async () => {
      const { services } = app.db.tables;
      const plant = async (id: string, actions: string | null) => {
        await app.db.client.insert(services).values({
          id,
          bundleId,
          name: id,
          description: "",
          driver: "plain",
          params: JSON.stringify([{ name: "shared" }]),
          pins: "{}",
          actions,
          configEncrypted: encryptSecret(JSON.stringify({}), app.config.masterKey),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      };
      const names = async (id: string) =>
        (await listServicesUnchecked(env, bundleId)).find((s) => s.id === id)!.actions.map((a) => a.name);

      // A name the driver no longer declares (it was renamed in an upgrade,
      // say) simply drops out; the rest of the allowlist stands.
      await plant("partly-stale", JSON.stringify(["renamed-away", "other"]));
      expect(await names("partly-stale")).toEqual(["other"]);
      const run = await runService(env, aliceId, bundleId, { service: "partly-stale", params: {}, waitMs: 5_000 });
      expect(run.action).toBe("other");

      // Every name stale: nothing to list, nothing to run — with a reason.
      await plant("all-stale", JSON.stringify(["renamed-away"]));
      expect(await names("all-stale")).toEqual([]);
      await expect(runService(env, aliceId, bundleId, { service: "all-stale", action: "inspect" })).rejects.toThrow(
        /^service "all-stale" has no runnable actions$/,
      );
      await expect(runService(env, aliceId, bundleId, { service: "all-stale" })).rejects.toThrow(
        /^service "all-stale" has no runnable actions$/,
      );

      // Not an array (or not JSON at all): a policy that cannot be read fails
      // closed — nothing is allowed, never everything.
      await plant("object-allowlist", JSON.stringify({ inspect: true }));
      expect(await names("object-allowlist")).toEqual([]);
      await plant("garbage-allowlist", "not json");
      expect(await names("garbage-allowlist")).toEqual([]);
      await expect(runService(env, aliceId, bundleId, { service: "garbage-allowlist" })).rejects.toThrow(
        /^service "garbage-allowlist" has no runnable actions$/,
      );
    });
  });

  describe("capability gates", () => {
    let seeded: string;
    beforeAll(async () => {
      seeded = (await createService(env, aliceId, bundleId, { name: "seeded", config: httpConfig })).id;
    });

    it("authoring needs edit_services — run_services is not enough", async () => {
      const gates = [
        () => createService(env, runnerId, bundleId, { name: "sneaky", config: httpConfig }),
        () => updateService(env, runnerId, seeded, { name: "sneaky" }),
        () => deleteService(env, runnerId, seeded),
      ];
      for (const gate of gates) {
        await expect(gate()).rejects.toMatchObject({
          code: "forbidden",
          details: { capability: "edit_services" },
        });
      }
      // The runner can still see it and run it — the split is real.
      expect((await listServices(env, runnerId, bundleId)).map((s) => s.name)).toContain("seeded");
    });

    it("listing needs only read access, and hides the bundle from an outsider", async () => {
      expect((await listServices(env, viewerId, bundleId)).map((s) => s.name)).toContain("seeded");
      await expect(listServices(env, outsiderId, bundleId)).rejects.toMatchObject({ code: "not_found" });
      await expect(
        createService(env, outsiderId, bundleId, { name: "trespass", config: httpConfig }),
      ).rejects.toMatchObject({ code: "not_found" });
    });
  });

  describe("the bundle writer", () => {
    const titles = async (bundle: string): Promise<string[]> =>
      (await queryItems(app.db, aliceId, bundle, { itemType: "Note" })).data.map((i) => i.values.title as string);

    it("writes items into the run's bundle and records them on the run row", async () => {
      const svc = await createService(env, aliceId, bundleId, { name: "recorder", driver: "writer", config: {} });
      const run = await runService(env, aliceId, bundleId, {
        service: "recorder",
        action: "record",
        params: { itemType: "Note", title: "written by a driver" },
        waitMs: 5_000,
      });
      expect(run.status).toBe("succeeded");
      expect(run.serviceId).toBe(svc.id);

      const ids = (run.result as { ids: string[] }).ids;
      expect(ids).toHaveLength(1);
      expect(run.writes).toEqual([{ type: "items", itemType: "Note", ids }]);

      // The item is really there, with the values the driver supplied.
      const items = (await queryItems(app.db, aliceId, bundleId, { itemType: "Note" })).data;
      expect(items.find((i) => i.id === ids[0]!)?.values.title).toBe("written by a driver");
      // …and only there: the writer is bound to the run's bundle.
      expect(await titles(otherBundleId)).not.toContain("written by a driver");
    });

    it("records a multi-item write as one audit entry", async () => {
      await createService(env, aliceId, bundleId, { name: "batcher", driver: "writer", config: {} });
      const run = await runService(env, aliceId, bundleId, {
        service: "batcher",
        action: "batch",
        params: { itemType: "Note" },
        waitMs: 5_000,
      });
      expect(run.status).toBe("succeeded");
      expect(run.writes).toHaveLength(1);
      expect((run.writes[0] as { ids: string[] }).ids).toHaveLength(2);
    });

    it("cannot reach an item-type that lives in another bundle", async () => {
      await createService(env, aliceId, bundleId, { name: "trespasser", driver: "writer", config: {} });
      const run = await runService(env, aliceId, bundleId, {
        service: "trespasser",
        action: "record",
        // "Ledger" exists — but only in the other bundle.
        params: { itemType: "Ledger", title: "should not land" },
        waitMs: 5_000,
      });
      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/item-type Ledger not found/);
      expect(run.writes).toEqual([]);
      const ledger = await queryItems(app.db, aliceId, otherBundleId, { itemType: "Ledger" });
      expect(ledger.data).toHaveLength(0);
    });

    it("applies the item layer's validation to a driver's write", async () => {
      await createService(env, aliceId, bundleId, { name: "sloppy", driver: "writer", config: {} });
      // A driver's write is not privileged past the capability check: the
      // schema still rules. The item-type declares a required "title" and no
      // "nonsense" property, so this batch never lands.
      const before = (await titles(bundleId)).length;
      const run = await runService(env, aliceId, bundleId, {
        service: "sloppy",
        action: "bogus",
        params: { itemType: "Note" },
        waitMs: 5_000,
      });
      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/required property "title" is missing/);
      expect(run.writes).toEqual([]);
      expect(await titles(bundleId)).toHaveLength(before);
    });

    it("keeps a colliding stored value out of the run's error", async () => {
      await createService(env, aliceId, bundleId, { name: "ticketer", driver: "writer", config: {} });
      const first = await runService(env, aliceId, bundleId, {
        service: "ticketer",
        action: "record",
        params: { itemType: "Ticket", title: "SECRET-SERIAL-42" },
        waitMs: 5_000,
      });
      expect(first.status).toBe("succeeded");

      const clash = await runService(env, aliceId, bundleId, {
        service: "ticketer",
        action: "record",
        params: { itemType: "Ticket", title: "SECRET-SERIAL-42" },
        waitMs: 5_000,
      });
      expect(clash.status).toBe("failed");
      // The rule is named…
      expect(clash.error).toMatch(/uniqueness/i);
      // …but the stored value that caused it never reaches the agent-visible row.
      expect(clash.error).not.toContain("SECRET-SERIAL-42");
      expect(clash.writes).toEqual([]);
    });

    it("audits a write the driver never awaited", async () => {
      await createService(env, aliceId, bundleId, { name: "detacher", driver: "writer", config: {} });
      const run = await runService(env, aliceId, bundleId, {
        service: "detacher",
        action: "detached",
        params: { itemType: "Note" },
        waitMs: 5_000,
      });
      expect(run.status).toBe("succeeded");

      // The item really landed…
      const items = (await queryItems(app.db, aliceId, bundleId, { itemType: "Note" })).data;
      const landed = items.filter((i) => i.values.title === "landed late");
      expect(landed).toHaveLength(1);
      // …and it is on the run's trail, not floating in the bundle unexplained.
      const finished = await getRun(env, aliceId, run.id);
      expect(finished.writes).toEqual([{ type: "items", itemType: "Note", ids: [landed[0]!.id] }]);
    });

    it("hands a driver that declared no writes a null writer", async () => {
      await createService(env, aliceId, bundleId, { name: "inspector", driver: "plain", config: {} });
      const run = await runService(env, aliceId, bundleId, {
        service: "inspector",
        action: "inspect",
        params: { note: "hi" },
        waitMs: 5_000,
      });
      expect(run.status).toBe("succeeded");
      expect(run.result).toMatchObject({ hasWriter: false, hasEgress: false });
      expect(run.writes).toEqual([]);
    });

    it("revokes the handle once the run is over", async () => {
      escapedWriter = null;
      await createService(env, aliceId, bundleId, { name: "escapee", driver: "writer", config: {} });
      const run = await runService(env, aliceId, bundleId, {
        service: "escapee",
        action: "escape",
        waitMs: 5_000,
      });
      expect(run.status).toBe("succeeded");
      expect(escapedWriter).not.toBeNull();

      // A driver keeping its handle past the run would write outside the audit
      // trail; the handle is closed with the run instead.
      await expect(escapedWriter!.createItems("Note", [{ title: "after the fact" }])).rejects.toThrow(
        /write handle is no longer usable/,
      );
      expect(await titles(bundleId)).not.toContain("after the fact");
      const finished = await getRun(env, aliceId, run.id);
      expect(finished.writes).toEqual([]);
    });
  });
});
