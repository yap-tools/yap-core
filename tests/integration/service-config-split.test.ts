/**
 * Service configs in two parts (src/core/serviceConfig.ts): readable settings
 * and write-only secrets, split by the driver's config schema, merged back for
 * the run. On both adapters. Pinned here:
 *
 * - the boot backfill splits a mail service correctly, leaves the sealed blob
 *   byte-identical, and a second boot changes nothing;
 * - a service on an unknown driver, on a driver without a schema, or with a
 *   blob that cannot be decrypted, parsed or split is left byte-identical and
 *   logged;
 * - an update that leaves secrets out keeps them, null removes one, and the
 *   legacy hook PATCH still replaces the whole transport;
 * - the run gets settings and secrets merged into one config;
 * - no read, for authors or anyone else, contains a secret value, and only
 *   authors see settings.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createHttpDriver } from "../../src/core/drivers/http.js";
import { createMailDriver } from "../../src/core/drivers/mail/index.js";
import { DriverRegistry } from "../../src/core/drivers/registry.js";
import { DRIVER_API, type DriverDefinition } from "../../src/core/drivers/types.js";
import { runService, type RunEnv } from "../../src/core/runs.js";
import { backfillServiceConfigs } from "../../src/core/serviceConfig.js";
import {
  createService,
  listServices,
  listServicesUnchecked,
  updateService,
  type ServiceEnv,
} from "../../src/core/services.js";
import { decryptSecret, encryptSecret } from "../../src/crypto.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";

/** Every config the vault driver's runs were handed, newest last. */
const seen: unknown[] = [];

/** A driver with a schema covering a plain secret, a nested one and a map. */
const vaultDriver: DriverDefinition = {
  name: "vault",
  api: DRIVER_API,
  description: "Test driver with secret fields.",
  egress: false,
  configSchema: {
    jsonSchema: {
      type: "object",
      properties: {
        base_url: { type: "string" },
        token: { type: "string" },
        mode: { type: "string" },
        oauth: { type: "object", properties: { client_id: { type: "string" }, client_secret: { type: "string" } } },
        headers: { type: "object", additionalProperties: { type: "string" } },
      },
    },
    secrets: [
      { path: "token", label: "Token" },
      { path: "oauth.client_secret", label: "Client secret" },
      { path: "headers.*", label: "Header value" },
    ],
  },
  validateConfig(config) {
    const c = config as Record<string, unknown>;
    if (typeof c.base_url !== "string") throw new Error("base_url is required");
    if (c.mode === "token" && typeof c.token !== "string") throw new Error("mode token needs token");
    if (c.mode === "oauth" && c.token !== undefined) throw new Error("mode oauth must not have token");
  },
  actions: { go: { description: "Record the config.", params: [], timeoutMs: 5000 } },
  async run(ctx) {
    seen.push(ctx.config);
    return { ok: true };
  },
};

/** The same contract with no schema: its config stays one sealed blob. */
const sealedDriver: DriverDefinition = {
  name: "sealed",
  api: DRIVER_API,
  description: "Test driver without a schema.",
  egress: false,
  validateConfig() {},
  actions: { go: { description: "Record the config.", params: [], timeoutMs: 5000 } },
  async run(ctx) {
    seen.push(ctx.config);
    return { ok: true };
  },
};

const mailConfig = {
  user: "ops@example.com",
  pass: "app-password-1234",
  from: "ops@example.com",
  imap: { host: "imap.example.com", port: 993 },
  smtp: { host: "smtp.example.com", port: 465 },
};

const SECRET_VALUES = ["tok-SECRET-1", "cs-SECRET-2", "hdr-SECRET-3", "app-password-1234"];

function captureLogger() {
  const lines: { level: "info" | "warn"; text: string }[] = [];
  return {
    lines,
    logger: {
      info: (...a: unknown[]) => lines.push({ level: "info", text: a.join(" ") }),
      warn: (...a: unknown[]) => lines.push({ level: "warn", text: a.join(" ") }),
    },
  };
}

describeEachAdapter("service config split", (adapter) => {
  let app: TestApp;
  let alice: ApiClient;
  let aliceId: string;
  let runnerId: string;
  let spaceId: string;
  let bundleId: string;
  let env: ServiceEnv & RunEnv;

  beforeAll(async () => {
    app = await bootTestApp({ YAP_HOOK_ALLOW_HOSTS: "" }, await adapter.makeDb());
    const registry = new DriverRegistry();
    registry.register(createHttpDriver(app.config));
    registry.register(createMailDriver());
    registry.register(vaultDriver);
    registry.register(sealedDriver);
    const resolver = async (): Promise<string[]> => ["93.184.216.34"];
    env = { db: app.db, blob: app.blob, config: app.config, registry, resolver };

    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    aliceId = a.body.user.id;
    runnerId = (await sysadmin.post("/v1/users", { name: "Runner" })).body.user.id;
    spaceId = (await alice.post("/v1/spaces", { name: "Split" })).body.id;
    bundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "main" })).body.id;
    await alice.post(`/v1/bundles/${bundleId}/grants`, {
      userId: runnerId,
      capabilities: ["run_services", "read_items"],
      effect: "allow",
    });
  });

  afterAll(async () => {
    await app.stop();
  });

  beforeEach(async () => {
    // Each test seeds its own services; the backfill looks at every row.
    await app.db.client.delete(app.db.tables.services);
    seen.length = 0;
  });

  /** A service row as an instance from before the split holds it. */
  async function seedSealed(name: string, driver: string, configEncrypted: string): Promise<string> {
    const id = randomUUID();
    const now = "2026-01-01T00:00:00.000Z";
    await app.db.client.insert(app.db.tables.services).values({
      approvedAt: "2026-01-01T00:00:00.000Z", // a service written before approvals: approved
      id,
      bundleId,
      name,
      description: "",
      driver,
      params: "[]",
      pins: "{}",
      actions: null,
      configEncrypted,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  const seal = (config: unknown): string => encryptSecret(JSON.stringify(config), app.config.masterKey);

  async function row(id: string) {
    const { services } = app.db.tables;
    return (await app.db.client.select().from(services).where(eq(services.id, id)))[0]!;
  }

  async function run(service: string) {
    const record = await runService(env, aliceId, bundleId, { service, waitMs: 5000, source: "rest" });
    expect(record.status).toBe("succeeded");
    return seen[seen.length - 1];
  }

  describe("boot backfill", () => {
    it("splits a mail service by its schema and leaves the sealed blob as it was", async () => {
      const blob = seal(mailConfig);
      const id = await seedSealed("inbox", "mail", blob);
      const { logger, lines } = captureLogger();

      const result = await backfillServiceConfigs(app.db, env.registry, app.config.masterKey, { logger });
      expect(result).toEqual({ split: 1, resplit: 0, skipped: [] });

      const after = await row(id);
      expect(after.configEncrypted).toBe(blob);
      expect(after.updatedAt).toBe("2026-01-01T00:00:00.000Z");
      const { pass: _pass, ...settings } = mailConfig;
      expect(JSON.parse(after.settings!)).toEqual(settings);
      expect(after.settings).not.toContain("app-password-1234");
      expect(JSON.parse(decryptSecret(after.secretsEncrypted!, app.config.masterKey))).toEqual({
        pass: "app-password-1234",
      });
      expect(lines).toEqual([{ level: "info", text: "service configs: split 1 service into settings and secrets" }]);

      const [listed] = await listServices(env, aliceId, bundleId);
      expect(listed).toMatchObject({ settings, secretsSet: ["pass"] });
    });

    it("changes nothing on a second boot", async () => {
      const id = await seedSealed("inbox", "mail", seal(mailConfig));
      const { logger } = captureLogger();
      let backups = 0;
      const first = await backfillServiceConfigs(app.db, env.registry, app.config.masterKey, {
        logger,
        beforeWrite: async () => void backups++,
      });
      expect(first.split).toBe(1);
      const once = await row(id);

      const second = captureLogger();
      const again = await backfillServiceConfigs(app.db, env.registry, app.config.masterKey, {
        logger: second.logger,
        beforeWrite: async () => void backups++,
      });
      expect(again).toEqual({ split: 0, resplit: 0, skipped: [] });
      expect(await row(id)).toEqual(once);
      expect(second.lines).toEqual([]);
      expect(backups).toBe(1); // the backup hook runs only when there is something to write
    });

    it("leaves services it cannot split byte-identical, and logs each", async () => {
      const ids = {
        unknown: await seedSealed("ghost", "not-installed", seal({ token: "x" })),
        noSchema: await seedSealed("sealed", "sealed", seal({ anything: "goes" })),
        undecryptable: await seedSealed("garbled", "vault", "v1.x.y.z"),
        notJson: await seedSealed("not-json", "vault", encryptSecret("{oops", app.config.masterKey)),
        notObject: await seedSealed("array", "vault", seal(["base_url"])),
        doesNotFit: await seedSealed("bad-headers", "vault", seal({ base_url: "u", headers: "Bearer hdr-SECRET-3" })),
      };
      const before = Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, await row(id)])));
      const { logger, lines } = captureLogger();

      const result = await backfillServiceConfigs(app.db, env.registry, app.config.masterKey, { logger });
      expect(result.split).toBe(0);
      expect(Object.fromEntries(result.skipped.map((s) => [s.name, s.reason]))).toEqual({
        ghost: "driver-missing",
        sealed: "no-schema",
        garbled: "undecryptable",
        "not-json": "unparseable",
        array: "unparseable",
        "bad-headers": "does-not-fit",
      });
      for (const [k, id] of Object.entries(ids)) expect(await row(id)).toEqual(before[k]);

      expect(lines).toHaveLength(6);
      expect(lines.filter((l) => l.level === "info").map((l) => l.text)).toEqual([
        expect.stringContaining('"sealed"'),
      ]);
      expect(lines.find((l) => l.text.includes('"bad-headers"'))!.text).toContain("config.headers must be an object");
      for (const secret of SECRET_VALUES) expect(JSON.stringify(lines)).not.toContain(secret);
    });

    it("splits a service on its next boot once its driver ships a schema", async () => {
      const id = await seedSealed("later", "late", seal({ base_url: "u", token: "tok-SECRET-1" }));
      const without = new DriverRegistry();
      without.register({ ...sealedDriver, name: "late" });
      const first = await backfillServiceConfigs(app.db, without, app.config.masterKey, captureLogger());
      expect(first.skipped.map((s) => s.reason)).toEqual(["no-schema"]);
      expect((await row(id)).settings).toBeNull();

      const withSchema = new DriverRegistry();
      withSchema.register({ ...vaultDriver, name: "late" });
      const second = await backfillServiceConfigs(app.db, withSchema, app.config.masterKey, captureLogger());
      expect(second.split).toBe(1);
      expect(JSON.parse((await row(id)).settings!)).toEqual({ base_url: "u" });
    });

    it("rebuilds the parts from the sealed config when an earlier release edited it", async () => {
      const { id } = await createService(env, aliceId, bundleId, {
        name: "vault",
        driver: "vault",
        config: { base_url: "u", mode: "token", token: "tok-SECRET-1" },
      });
      // What a rollback to a release before the split writes: only the sealed column.
      await app.db.client
        .update(app.db.tables.services)
        .set({ configEncrypted: seal({ base_url: "u2", mode: "oauth" }) })
        .where(eq(app.db.tables.services.id, id));
      const { logger, lines } = captureLogger();
      const result = await backfillServiceConfigs(app.db, env.registry, app.config.masterKey, { logger });
      expect(result).toMatchObject({ split: 0, resplit: 1 });
      expect(lines[0]!.level).toBe("warn");
      expect(await run("vault")).toEqual({ base_url: "u2", mode: "oauth" });
    });

    it("moves a field the driver newly marks secret out of the readable settings", async () => {
      const { id } = await createService(env, aliceId, bundleId, { name: "vault", driver: "vault", config: { base_url: "u", mode: "token", token: "t" } });
      const stricter = new DriverRegistry();
      stricter.register({
        ...vaultDriver,
        configSchema: { ...vaultDriver.configSchema!, secrets: [...vaultDriver.configSchema!.secrets, { path: "mode", label: "Mode" }] },
      });
      const result = await backfillServiceConfigs(app.db, stricter, app.config.masterKey, captureLogger());
      expect(result.resplit).toBe(1);
      expect(JSON.parse((await row(id)).settings!)).toEqual({ base_url: "u" });
    });

    it("a split service runs with exactly the config it had", async () => {
      const config = {
        base_url: "https://api.example.com",
        token: "tok-SECRET-1",
        oauth: { client_id: "cid", client_secret: "cs-SECRET-2" },
        headers: { "x-api-key": "hdr-SECRET-3" },
      };
      await seedSealed("vault", "vault", seal(config));
      expect(await run("vault")).toEqual(config);
      await backfillServiceConfigs(app.db, env.registry, app.config.masterKey, captureLogger());
      expect(await run("vault")).toEqual(config);
    });
  });

  describe("authoring", () => {
    const full = {
      base_url: "https://api.example.com",
      mode: "token",
      token: "tok-SECRET-1",
      oauth: { client_id: "cid", client_secret: "cs-SECRET-2" },
      headers: { "x-api-key": "hdr-SECRET-3" },
    };

    it("stores settings readable and secrets encrypted, and returns only set paths", async () => {
      const created = await createService(env, aliceId, bundleId, { name: "vault", driver: "vault", config: full });
      expect(created.settings).toEqual({ base_url: "https://api.example.com", mode: "token", oauth: { client_id: "cid" }, headers: {} });
      expect(created.secretsSet).toEqual(["headers.x-api-key", "oauth.client_secret", "token"]);

      const stored = await row(created.id);
      for (const secret of SECRET_VALUES) {
        expect(stored.settings).not.toContain(secret);
        expect(stored.secretsEncrypted).not.toContain(secret);
        expect(stored.configEncrypted).not.toContain(secret);
      }
      // The whole config stays in the sealed column too, for earlier releases.
      expect(JSON.parse(decryptSecret(stored.configEncrypted, app.config.masterKey))).toEqual(full);
      expect(await run("vault")).toEqual(full);
    });

    it("keeps secrets an update leaves out, and the run sees settings and secrets merged", async () => {
      const { id } = await createService(env, aliceId, bundleId, { name: "vault", driver: "vault", config: full });
      // What an author who only ever saw the settings sends back, edited.
      const updated = await updateService(env, aliceId, id, {
        config: { base_url: "https://api2.example.com", mode: "token", oauth: { client_id: "cid2" }, headers: {} },
      });
      expect(updated.settings).toEqual({ base_url: "https://api2.example.com", mode: "token", oauth: { client_id: "cid2" }, headers: {} });
      expect(updated.secretsSet).toEqual(["headers.x-api-key", "oauth.client_secret", "token"]);
      const merged = { ...full, base_url: "https://api2.example.com", oauth: { client_id: "cid2", client_secret: "cs-SECRET-2" } };
      expect(await run("vault")).toEqual(merged);
      expect(JSON.parse(decryptSecret((await row(id)).configEncrypted, app.config.masterKey))).toEqual(merged);
    });

    it("an update that names no config leaves every part alone", async () => {
      const { id } = await createService(env, aliceId, bundleId, { name: "vault", driver: "vault", config: full });
      const before = await row(id);
      await updateService(env, aliceId, id, { description: "renamed" });
      const after = await row(id);
      expect([after.configEncrypted, after.settings, after.secretsEncrypted]).toEqual([
        before.configEncrypted,
        before.settings,
        before.secretsEncrypted,
      ]);
    });

    it("sets a secret by sending it and removes one with null", async () => {
      const { id } = await createService(env, aliceId, bundleId, { name: "vault", driver: "vault", config: full });
      const updated = await updateService(env, aliceId, id, {
        config: { base_url: "https://api.example.com", mode: "oauth", token: null, oauth: {}, headers: { "x-api-key": null, "x-other": "new-value" } },
      });
      expect(updated.secretsSet).toEqual(["headers.x-other", "oauth.client_secret"]);
      expect(await run("vault")).toEqual({
        base_url: "https://api.example.com",
        mode: "oauth",
        oauth: { client_secret: "cs-SECRET-2" },
        headers: { "x-other": "new-value" },
      });
    });

    it("says which kept secrets were checked when the merged config is refused", async () => {
      const { id } = await createService(env, aliceId, bundleId, { name: "vault", driver: "vault", config: full });
      const before = await row(id);
      await expect(updateService(env, aliceId, id, { config: { base_url: "u", mode: "oauth" } })).rejects.toThrow(
        /mode oauth must not have token \(checked with the stored secrets this write left out: token; set a secret path to null to remove it\)/,
      );
      expect(await row(id)).toEqual(before);
    });

    it("refuses a config whose shape breaks a secret path", async () => {
      await expect(
        createService(env, aliceId, bundleId, { name: "vault", driver: "vault", config: { base_url: "u", headers: "Bearer x" } }),
      ).rejects.toThrow('invalid config for driver "vault": config.headers must be an object');
    });

    it("merges onto a sealed service the boot split has not reached yet", async () => {
      const id = await seedSealed("vault", "vault", seal(full));
      const updated = await updateService(env, aliceId, id, {
        config: { base_url: "https://b.example.com", mode: "token", oauth: {}, headers: {} },
      });
      expect(updated.secretsSet).toEqual(["headers.x-api-key", "oauth.client_secret", "token"]);
      expect(await run("vault")).toEqual({ ...full, base_url: "https://b.example.com", oauth: { client_secret: "cs-SECRET-2" } });
    });

    it("keeps a driver without a schema as one sealed blob", async () => {
      const created = await createService(env, aliceId, bundleId, { name: "sealed", driver: "sealed", config: { k: "v" } });
      expect(created).toMatchObject({ settings: null, secretsSet: null });
      const stored = await row(created.id);
      expect([stored.settings, stored.secretsEncrypted]).toEqual([null, null]);
      expect(await run("sealed")).toEqual({ k: "v" });

      // An update replaces it whole, as before.
      await updateService(env, aliceId, created.id, { config: { other: 1 } });
      expect(await run("sealed")).toEqual({ other: 1 });
    });

    it("drops the secrets inside an object the update leaves out or nulls", async () => {
      const { id } = await createService(env, aliceId, bundleId, { name: "vault", driver: "vault", config: full });
      // Switching away from a block: send the config without it.
      const left = await updateService(env, aliceId, id, { config: { base_url: "u", mode: "token", headers: {} } });
      expect(left.secretsSet).toEqual(["headers.x-api-key", "token"]);
      const nulled = await updateService(env, aliceId, id, { config: { base_url: "u", mode: "token", headers: null } });
      expect(nulled.secretsSet).toEqual(["token"]);
      expect(await run("vault")).toEqual({ base_url: "u", mode: "token", headers: null, token: "tok-SECRET-1" });
    });

    it("what this release writes, a later boot leaves alone", async () => {
      const { id } = await createService(env, aliceId, bundleId, { name: "vault", driver: "vault", config: full });
      await updateService(env, aliceId, id, { config: { base_url: "u", mode: "token", oauth: { client_id: null }, headers: { a: "b" } } });
      const before = await row(id);
      const result = await backfillServiceConfigs(app.db, env.registry, app.config.masterKey, captureLogger());
      expect(result).toEqual({ split: 0, resplit: 0, skipped: [] });
      expect(await row(id)).toEqual(before);
    });

    it("does not touch Object.prototype through a __proto__ key", async () => {
      const mapped: DriverDefinition = {
        ...vaultDriver,
        name: "mapped",
        configSchema: {
          jsonSchema: {
            type: "object",
            properties: {
              base_url: { type: "string" },
              accounts: { type: "object", additionalProperties: { type: "object", properties: { token: { type: "string" } } } },
            },
          },
          secrets: [{ path: "accounts.*.token", label: "Token" }],
        },
      };
      env.registry.register(mapped);
      const config = JSON.parse('{"base_url":"u","accounts":{"__proto__":{"token":"tok-SECRET-1","user":"a"}}}');
      const created = await createService(env, aliceId, bundleId, { name: "mapped", driver: "mapped", config });
      expect(({} as Record<string, unknown>).token).toBeUndefined();
      expect(created.secretsSet).toEqual(["accounts.__proto__.token"]);
      expect(JSON.stringify(created)).not.toContain("tok-SECRET-1");
      expect(await run("mapped")).toEqual(config);
      expect(({} as Record<string, unknown>).token).toBeUndefined();
    });

    it("the legacy hook PATCH still replaces the whole transport, headers included", async () => {
      const hook = await alice.post(`/v1/bundles/${bundleId}/hooks`, {
        name: "legacy",
        transport: { url: "https://example.com/a", method: "POST", headers: { authorization: "Bearer old" } },
      });
      expect(hook.status).toBe(201);
      const patched = await alice.patch(`/v1/hooks/${hook.body.id}`, {
        transport: { url: "https://example.com/b", method: "POST" },
      });
      expect(patched.status).toBe(200);
      const stored = await row(hook.body.id);
      expect(JSON.parse(decryptSecret(stored.configEncrypted, app.config.masterKey))).toEqual({
        url: "https://example.com/b",
        method: "POST",
      });
      expect(JSON.parse(decryptSecret(stored.secretsEncrypted!, app.config.masterKey))).toEqual({});
    });
  });

  describe("reads", () => {
    it("never contain a secret value, and show settings to authors only", async () => {
      await createService(env, aliceId, bundleId, {
        name: "vault",
        driver: "vault",
        config: {
          base_url: "https://hidden.example.com",
          token: "tok-SECRET-1",
          oauth: { client_id: "cid", client_secret: "cs-SECRET-2" },
          headers: { "x-api-key": "hdr-SECRET-3" },
        },
      });
      await seedSealed("inbox", "mail", seal(mailConfig));
      await backfillServiceConfigs(app.db, env.registry, app.config.masterKey, captureLogger());

      const surfaces = {
        authorCore: await listServices(env, aliceId, bundleId),
        runnerCore: await listServices(env, runnerId, bundleId),
        unchecked: await listServicesUnchecked(env, bundleId),
        rest: (await alice.get(`/v1/bundles/${bundleId}/services`)).body,
        restHooks: (await alice.get(`/v1/bundles/${bundleId}/hooks`)).body,
      };
      for (const [surface, body] of Object.entries(surfaces)) {
        const text = JSON.stringify(body);
        for (const secret of SECRET_VALUES) expect(text, `${surface} leaks ${secret}`).not.toContain(secret);
      }
      expect(JSON.stringify(surfaces.authorCore)).toContain("hidden.example.com");
      expect(JSON.stringify(surfaces.rest)).toContain("hidden.example.com");
      // Without edit_services the listing is the agent-visible one: no settings at all.
      expect(surfaces.runnerCore).toEqual(surfaces.unchecked);
      expect(JSON.stringify(surfaces.runnerCore)).not.toContain("hidden.example.com");
      expect(JSON.stringify(surfaces.runnerCore)).not.toContain("imap.example.com");
    });
  });
});
