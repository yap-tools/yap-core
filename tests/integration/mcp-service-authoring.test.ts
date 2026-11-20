/**
 * Service authoring over MCP, and the secret form that goes with it. On both
 * adapters. Pinned here:
 *
 * - create_service / update_service take settings only: a secret value in
 *   them is refused, pointing at secret_request; secrets not set yet are fine,
 *   the driver's checks running as if they were filled in;
 * - a driver without a config schema cannot be authored over MCP;
 * - get_service gives an edit_services holder params, pins, settings and
 *   secretsSet, and anyone else the listing view; load_bundle carries no
 *   settings;
 * - secret_request returns paths, labels and set flags, never a value; its
 *   form takes one successful submission with a login, expires, re-checks the requester
 *   and stays open after a refused one;
 * - the stored secret is never returned over REST or MCP, and the run uses it;
 * - edit_services is the gate, and a driver that writes into the bundle also
 *   needs the matching edit capability.
 */
import { createServer, type Server } from "node:http";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DRIVER_API, type DriverDefinition } from "../../src/core/drivers/types.js";
import { signToken } from "../../src/crypto.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, getFreePort, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp, type McpTestClient } from "../helpers/mcp.js";

const HEADER_SECRET = "Bearer hdr-SECRET-7f3a";
const VAULT_SECRET = "vault-SECRET-91c2";
const SECRETS = [HEADER_SECRET, VAULT_SECRET, "app-SECRET-pass"];

/** A schema driver whose check refuses one token value, so a refused submission can be pinned. */
const vaultDriver: DriverDefinition = {
  name: "vault",
  api: DRIVER_API,
  description: "Test driver with a token secret.",
  egress: false,
  configSchema: {
    jsonSchema: {
      type: "object",
      properties: {
        base_url: { type: "string" },
        token: { type: "string" },
        oauth: { type: "object", properties: { client_id: { type: "string" }, client_secret: { type: "string" } } },
      },
    },
    secrets: [
      { path: "token", label: "API token", description: "From the vault's settings page." },
      { path: "oauth.client_secret", label: "Client secret" },
    ],
  },
  validateConfig(config) {
    const c = config as Record<string, unknown>;
    if (typeof c.base_url !== "string") throw new Error("base_url is required");
    if (typeof c.token !== "string") throw new Error("token is required");
    if (c.token === "refused-token") throw new Error("token is not accepted");
  },
  actions: { go: { description: "Echo whether the token is the expected one.", params: [], timeoutMs: 5000 } },
  async run(ctx) {
    const c = ctx.config as Record<string, unknown>;
    return { tokenMatches: c.token === VAULT_SECRET };
  },
};

/** No schema: its config is one sealed secret, REST-only. */
const sealedDriver: DriverDefinition = {
  name: "sealed",
  api: DRIVER_API,
  description: "Test driver without a schema.",
  egress: false,
  validateConfig() {},
  actions: { go: { description: "Nothing.", params: [], timeoutMs: 5000 } },
  async run() {
    return {};
  },
};

/** Writes items with the service's authority. */
const scribeDriver: DriverDefinition = {
  name: "scribe",
  api: DRIVER_API,
  description: "Test driver that writes items.",
  egress: false,
  writes: { items: true },
  configSchema: { jsonSchema: { type: "object", properties: {} }, secrets: [] },
  validateConfig() {},
  actions: { go: { description: "Nothing.", params: [], timeoutMs: 5000 } },
  async run() {
    return {};
  },
};

describeEachAdapter("service authoring over MCP", (adapter) => {
  let app: TestApp;
  let alice: ApiClient;
  let aliceKey: string;
  let aliceMcp: McpTestClient;
  let bobMcp: McpTestClient;
  let bobRest: ApiClient;
  let bobId: string;
  let spaceId: string;
  let bundleId: string;
  let target: Server;
  let targetPort: number;
  const authHeaders: Array<string | undefined> = [];

  const one = async (client: McpTestClient, tool: string, params: Record<string, unknown>) =>
    (await client.call("call", { space_id: spaceId, calls: [{ bundle_id: bundleId, tool, params }] })).results[0];

  const submit = (requestId: string, token: string, values: Record<string, unknown>, accessKey: string | null = aliceKey) =>
    apiClient(app.baseUrl).post(`/v1/secret-requests/${requestId}/submit`, {
      token,
      values,
      ...(accessKey !== null ? { access_key: accessKey } : {}),
    });

  /** A service written over MCP runs once a person approves it: Alice, on its approve page. */
  const approve = async (service: string) => {
    const req = await one(aliceMcp, "approval_request", { id: service });
    expect(req.ok, JSON.stringify(req)).toBe(true);
    const { request_id, token } = req._meta.data;
    const anon = apiClient(app.baseUrl);
    const view = await anon.post(`/v1/service-approvals/${request_id}/view`, { token });
    const decided = await anon.post(`/v1/service-approvals/${request_id}/decide`, {
      token,
      decision: "approve",
      access_key: aliceKey,
      fingerprint: view.body.fingerprint,
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  };

  beforeAll(async () => {
    targetPort = await getFreePort();
    target = createServer((req, res) => {
      authHeaders.push(req.headers.authorization);
      req.resume();
      req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
    });
    await new Promise<void>((resolve) => target.listen(targetPort, "127.0.0.1", resolve));

    app = await bootTestApp({ YAP_HOOK_ALLOW_HOSTS: "127.0.0.1" }, await adapter.makeDb());
    app.server.registry.register(vaultDriver);
    app.server.registry.register(sealedDriver);
    app.server.registry.register(scribeDriver);
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    aliceKey = a.body.initialKey.key;
    alice = apiClient(app.baseUrl, aliceKey);
    aliceMcp = await connectMcp(app.baseUrl, a.body.initialKey.key);
    const b = await sysadmin.post("/v1/users", { name: "Bob" });
    bobId = b.body.user.id;
    bobRest = apiClient(app.baseUrl, b.body.initialKey.key);
    bobMcp = await connectMcp(app.baseUrl, b.body.initialKey.key);
    spaceId = (await alice.post("/v1/spaces", { name: "Authored" })).body.id;
    bundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "ops" })).body.id;
    // Bob can read and run, not author.
    await alice.post(`/v1/bundles/${bundleId}/grants`, {
      userId: bobId,
      capabilities: ["read_items", "run_services"],
      effect: "allow",
    });
  });

  afterAll(async () => {
    await aliceMcp.close();
    await bobMcp.close();
    await app.stop();
    await new Promise<void>((resolve, reject) => target.close((e) => (e ? reject(e) : resolve())));
  });

  const httpSettings = () => ({
    url: `http://127.0.0.1:${targetPort}/notify`,
    method: "POST",
    headers: {},
    body_json: { text: "{{text}}" },
  });

  describe("create_service and update_service", () => {
    it("creates a service without its secrets, and returns the author's view", async () => {
      const res = await one(aliceMcp, "create_service", {
        name: "notify",
        params: [{ name: "text", required: true }],
        settings: httpSettings(),
      });
      expect(res.ok).toBe(true);
      expect(res.result).toMatchObject({
        name: "notify",
        driver: "http",
        params: [{ name: "text", required: true }],
        pins: {},
        settings: httpSettings(),
        secretsSet: [],
      });
    });

    it("refuses a secret value in create_service, pointing at secret_request", async () => {
      const res = await one(aliceMcp, "create_service", {
        name: "leaky",
        settings: { ...httpSettings(), headers: { authorization: HEADER_SECRET } },
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("invalid_request");
      expect(res.error.message).toContain("settings.headers.authorization holds a secret value");
      expect(res.error.message).toContain("secret_request");
      expect(res.error.message).not.toContain(HEADER_SECRET);
    });

    it("refuses a secret value in update_service", async () => {
      const res = await one(aliceMcp, "update_service", {
        id: "notify",
        settings: { ...httpSettings(), headers: { authorization: HEADER_SECRET } },
      });
      expect(res.ok).toBe(false);
      expect(res.error.message).toContain("holds a secret value");
    });

    it("still runs the driver's online check (the http SSRF guard) at authoring", async () => {
      const res = await one(aliceMcp, "create_service", {
        name: "internal",
        settings: { url: "http://10.0.0.1/x", method: "GET" },
      });
      expect(res.ok).toBe(false);
      expect(res.error.message).toMatch(/destination 10\.0\.0\.1/);
    });

    it("accepts a config whose secrets are missing, checked as if they were filled in", async () => {
      const mail = {
        user: "ops@example.com",
        from: "ops@example.com",
        imap: { host: "imap.example.com", port: 993 },
        smtp: { host: "smtp.example.com", port: 465 },
      };
      // Password login: pass is the one missing secret.
      expect((await one(aliceMcp, "create_service", { name: "mail-pass", driver: "mail", settings: mail })).ok).toBe(true);
      // OAuth: the block's two secrets are missing, and pass must stay absent.
      const oauth = {
        ...mail,
        oauth2: { client_id: "cid", token_url: "https://oauth2.example.com/token" },
      };
      const created = await one(aliceMcp, "create_service", { name: "mail-oauth", driver: "mail", settings: oauth });
      expect(created.ok).toBe(true);
      expect(created.result.settings.oauth2).toEqual(oauth.oauth2);
      // A real mistake still fails, naming the field and the placeholders.
      const bad = await one(aliceMcp, "create_service", {
        name: "mail-bad",
        driver: "mail",
        settings: { ...mail, from: "not an address" },
      });
      expect(bad.ok).toBe(false);
      expect(bad.error.message).toContain("from");
      expect(bad.error.message).toContain("secrets not set yet were filled in: pass");
    });

    it("refuses a driver without a config schema", async () => {
      const res = await one(aliceMcp, "create_service", { name: "blob", driver: "sealed", settings: {} });
      expect(res.ok).toBe(false);
      expect(res.error.message).toContain("can only be authored over REST");
      // And a sealed service made over REST cannot be changed over MCP either.
      const rest = await alice.post(`/v1/bundles/${bundleId}/services`, { name: "blob", driver: "sealed", config: {} });
      expect(rest.status).toBe(201);
      const upd = await one(aliceMcp, "update_service", { id: "blob", description: "x" });
      expect(upd.ok).toBe(false);
      expect(upd.error.message).toContain("over REST");
      // Deleting it is fine.
      expect((await one(aliceMcp, "delete_service", { id: "blob" })).ok).toBe(true);
    });

    it("updates settings, pins and description, keeping what it does not touch", async () => {
      const res = await one(aliceMcp, "update_service", {
        id: "notify",
        description: "Tells the team",
        settings: { ...httpSettings(), method: "PUT" },
      });
      expect(res.ok).toBe(true);
      expect(res.result).toMatchObject({ description: "Tells the team", settings: { method: "PUT" } });
      const back = await one(aliceMcp, "update_service", { id: "notify", settings: httpSettings() });
      expect(back.ok).toBe(true);
    });

    it("a driver that writes items needs edit_items as well as edit_services", async () => {
      await alice.post(`/v1/bundles/${bundleId}/grants`, {
        userId: bobId,
        capabilities: ["edit_services"],
        effect: "allow",
      });
      try {
        const denied = await one(bobMcp, "create_service", { name: "scribe", driver: "scribe", settings: {} });
        expect(denied.ok).toBe(false);
        expect(denied.error.code).toBe("forbidden");
        expect(denied.error.message).toContain("edit_items");
        // The same rule on REST.
        const rest = await bobRest.post(`/v1/bundles/${bundleId}/services`, { name: "scribe", driver: "scribe", config: {} });
        expect(rest.status).toBe(403);
        // A driver that writes nothing is fine with edit_services alone.
        const ok = await one(bobMcp, "create_service", { name: "bobs", driver: "vault", settings: { base_url: "x" } });
        expect(ok.ok).toBe(true);
        expect((await one(bobMcp, "delete_service", { id: "bobs" })).ok).toBe(true);
      } finally {
        const grants = await alice.get(`/v1/bundles/${bundleId}/grants`);
        for (const g of grants.body.data.filter((g: any) => g.userId === bobId && g.capability === "edit_services")) {
          await alice.delete(`/v1/bundles/${bundleId}/grants/${g.id}`);
        }
      }
    });
  });

  describe("get_service and load_bundle", () => {
    it("gives an edit_services holder settings and secretsSet, and anyone else the listing view", async () => {
      const mine = await one(aliceMcp, "get_service", { id: "notify" });
      expect(mine.ok).toBe(true);
      expect(mine.result).toMatchObject({ settings: httpSettings(), secretsSet: [], pins: {} });
      const bobs = await one(bobMcp, "get_service", { id: "notify" });
      expect(bobs.ok).toBe(true);
      expect(bobs.result.name).toBe("notify");
      expect(bobs.result).not.toHaveProperty("settings");
      expect(bobs.result).not.toHaveProperty("secretsSet");
      expect(bobs.result).not.toHaveProperty("pins");
    });

    it("load_bundle carries no settings", async () => {
      const loaded = await aliceMcp.call("load_bundle", { bundle_ids: [bundleId] });
      const notify = loaded.bundles[0].services.find((s: any) => s.name === "notify");
      expect(notify).toBeTruthy();
      expect(notify).not.toHaveProperty("settings");
      expect(JSON.stringify(loaded)).not.toContain("/notify");
    });

    it("refuses authoring to a member without edit_services", async () => {
      for (const [tool, params] of [
        ["create_service", { name: "bobs", settings: httpSettings() }],
        ["update_service", { id: "notify", description: "mine now" }],
        ["delete_service", { id: "notify" }],
        ["secret_request", { id: "notify", paths: ["headers.authorization"] }],
      ] as const) {
        const res = await one(bobMcp, tool, params);
        expect(res.ok, tool).toBe(false);
        expect(res.error.code, tool).toBe("forbidden");
        expect(res.error.details?.capability, tool).toBe("edit_services");
      }
    });

    it("refuses authoring to a read-only scoped key of the author herself, and reads only the listing view", async () => {
      const minted = await alice.post("/v1/keys", { name: "reader", scope: { role: "read-only" } });
      const reader = await connectMcp(app.baseUrl, minted.body.key);
      try {
        for (const [tool, params] of [
          ["create_service", { name: "readers", settings: httpSettings() }],
          ["update_service", { id: "notify", description: "mine now" }],
          ["delete_service", { id: "notify" }],
          ["secret_request", { id: "notify", paths: ["headers.authorization"] }],
        ] as const) {
          const res = await one(reader, tool, params);
          expect(res.ok, tool).toBe(false);
          expect(res.error.code, tool).toBe("forbidden");
          expect(res.error.details?.decidedBy, tool).toBe("key_scope");
        }
        const view = await one(reader, "get_service", { id: "notify" });
        expect(view.ok, JSON.stringify(view)).toBe(true);
        expect(view.result.settings).toBeUndefined();
      } finally {
        await reader.close();
      }
    });
  });

  describe("secret_request and its form", () => {
    let requestId: string;
    let token: string;

    it("returns paths, labels and set flags, a widget pointer and an origin URL, never a value", async () => {
      const res = await one(aliceMcp, "secret_request", { id: "notify", paths: ["headers.authorization"] });
      expect(res.ok).toBe(true);
      expect(res.result).toMatchObject({
        service: { name: "notify" },
        fields: [{ path: "headers.authorization", label: "Header value", set: false }],
        expires_in: 600,
      });
      expect(res.result.origin_url).toMatch(/\/w\/secret-input\?token=/);
      expect(res._meta.widget).toBe("ui://yap/secret-input");
      expect(res._meta.data).toMatchObject({ service_name: "notify", submit_url: expect.stringContaining("/submit") });
      requestId = res.result.request_id;
      token = res._meta.data.token;
    });

    it("refuses a path the driver does not mark secret, and a map path without its key", async () => {
      for (const paths of [["url"], ["headers.*"], []]) {
        const res = await one(aliceMcp, "secret_request", { id: "notify", paths });
        expect(res.ok, JSON.stringify(paths)).toBe(false);
      }
      // http has no plain secret path to default to.
      const none = await one(aliceMcp, "secret_request", { id: "notify" });
      expect(none.ok).toBe(false);
      expect(none.error.message).toContain("headers.authorization");
    });

    it("serves the form on its origin page", async () => {
      const res = await one(aliceMcp, "secret_request", { id: "notify", paths: ["headers.authorization"] });
      const page = await fetch(res.result.origin_url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Header value");
      expect(html).toContain("headers.authorization");
      expect(html).toContain('type=\\"password\\"');
      // The origin token is for the page, not for submitting.
      const pageToken = new URL(res.result.origin_url).searchParams.get("token")!;
      expect((await submit(res.result.request_id, pageToken, { "headers.authorization": "x" })).status).toBe(401);
    });

    it("refuses values for paths the form did not ask for, and a forged or expired token", async () => {
      expect((await submit(requestId, token, { "headers.other": "x" })).status).toBe(400);
      expect((await submit(requestId, token, {})).status).toBe(400);
      expect((await submit(requestId, `${token}x`, { "headers.authorization": "x" })).status).toBe(401);
      const expired = signToken({ scope: "secret-submit", requestId }, app.config.masterKey, -10);
      expect((await submit(requestId, expired, { "headers.authorization": "x" })).status).toBe(401);
    });

    it("stores the secret once, and the form cannot be used again", async () => {
      const res = await submit(requestId, token, { "headers.authorization": HEADER_SECRET });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ saved: true, paths: ["headers.authorization"] });
      const again = await submit(requestId, token, { "headers.authorization": "Bearer other" });
      expect(again.status).toBe(409);
      const view = await one(aliceMcp, "get_service", { id: "notify" });
      expect(view.result.secretsSet).toEqual(["headers.authorization"]);
      expect(view.result.settings.headers).toEqual({});
    });

    it("the run uses the stored secret", async () => {
      await approve("notify");
      authHeaders.length = 0;
      const run = await one(aliceMcp, "run_service", { id: "notify", params: { text: "hi" }, wait_ms: 5000 });
      expect(run.ok).toBe(true);
      expect(run.result.status).toBe("succeeded");
      expect(authHeaders).toEqual([HEADER_SECRET]);
    });

    it("an update that sends the settings back keeps the secret", async () => {
      const upd = await one(aliceMcp, "update_service", { id: "notify", settings: httpSettings() });
      expect(upd.ok).toBe(true);
      expect(upd.result.secretsSet).toEqual(["headers.authorization"]);
    });

    it("an update that moves the url drops the header secret bound to it", async () => {
      // Another service, so "notify" keeps its secret for the reads below.
      expect((await one(aliceMcp, "create_service", { name: "moved", settings: httpSettings() })).ok).toBe(true);
      const req = await one(aliceMcp, "secret_request", { id: "moved", paths: ["headers.authorization"] });
      expect((await submit(req.result.request_id, req._meta.data.token, { "headers.authorization": HEADER_SECRET })).status).toBe(
        200,
      );
      // A settings change elsewhere keeps it...
      const kept = await one(aliceMcp, "update_service", { id: "moved", settings: { ...httpSettings(), method: "PUT" } });
      expect(kept.result.secretsSet).toEqual(["headers.authorization"]);
      // ...a new url drops it, so it cannot be sent to a server the agent picked.
      const moved = await one(aliceMcp, "update_service", {
        id: "moved",
        settings: { ...httpSettings(), url: `http://127.0.0.1:${targetPort}/elsewhere` },
      });
      expect(moved.ok).toBe(true);
      expect(moved.result.secretsSet).toEqual([]);
      await approve("moved");
      authHeaders.length = 0;
      const ran = await one(aliceMcp, "run_service", { id: "moved", wait_ms: 5000 });
      expect(ran.result.status, JSON.stringify(ran.result)).toBe("succeeded");
      expect(authHeaders).toEqual([undefined]);
      expect((await one(aliceMcp, "delete_service", { id: "moved" })).ok).toBe(true);
    });

    it("an expired form is refused even with a valid token", async () => {
      const res = await one(aliceMcp, "secret_request", { id: "notify", paths: ["headers.authorization"] });
      const { secretRequests } = app.db.tables;
      await app.db.client
        .update(secretRequests)
        .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(secretRequests.id, res.result.request_id));
      const out = await submit(res.result.request_id, res._meta.data.token, { "headers.authorization": "x" });
      expect(out.status).toBe(401);
      const page = await fetch(res.result.origin_url);
      expect(page.status).toBe(401);
    });

    it("a refused submission leaves the form open, and a corrected one lands", async () => {
      expect((await one(aliceMcp, "create_service", { name: "vault", driver: "vault", settings: { base_url: "x" } })).ok).toBe(
        true,
      );
      const req = await one(aliceMcp, "secret_request", { id: "vault" });
      expect(req.ok).toBe(true);
      // Defaults to the plain secret paths whose object is in the settings.
      expect(req.result.fields).toEqual([
        { path: "token", label: "API token", description: "From the vault's settings page.", set: false },
      ]);
      const id = req.result.request_id;
      const tok = req._meta.data.token;
      const refused = await submit(id, tok, { token: "refused-token" });
      expect(refused.status).toBe(400);
      expect(refused.body.error.message).toContain("token is not accepted");
      expect((await submit(id, tok, { token: VAULT_SECRET })).status).toBe(200);
      await approve("vault");
      const run = await one(aliceMcp, "run_service", { id: "vault", wait_ms: 5000 });
      expect(run.result.status).toBe("succeeded");
      expect(run.result.result).toEqual({ tokenMatches: true });
    });

    it("a config change closes the service's open forms", async () => {
      expect((await one(aliceMcp, "create_service", { name: "bait", settings: httpSettings() })).ok).toBe(true);
      const req = await one(aliceMcp, "secret_request", { id: "bait", paths: ["headers.authorization"] });
      // A rename alone leaves the form open...
      expect((await one(aliceMcp, "update_service", { id: "bait", description: "still bait" })).ok).toBe(true);
      // ...pointing the service elsewhere closes it before anyone fills it in.
      const moved = await one(aliceMcp, "update_service", {
        id: "bait",
        settings: { ...httpSettings(), url: `http://127.0.0.1:${targetPort}/attacker` },
      });
      expect(moved.ok).toBe(true);
      const out = await submit(req.result.request_id, req._meta.data.token, { "headers.authorization": HEADER_SECRET });
      expect(out.status).toBe(401);
      expect((await one(aliceMcp, "get_service", { id: "bait" })).result.secretsSet).toEqual([]);
      expect((await one(aliceMcp, "delete_service", { id: "bait" })).ok).toBe(true);
    });

    it("asks for an oauth2 block's secrets by default, not pass", async () => {
      const req = await one(aliceMcp, "secret_request", { id: "mail-oauth" });
      expect(req.ok).toBe(true);
      expect(req.result.fields.map((f: any) => f.path)).toEqual(["oauth2.client_secret", "oauth2.refresh_token"]);
      const pass = await one(aliceMcp, "secret_request", { id: "mail-pass" });
      expect(pass.result.fields.map((f: any) => f.path)).toEqual(["pass"]);
    });

    it("a driver that writes files needs edit_files to ask for its secrets", async () => {
      await alice.post(`/v1/bundles/${bundleId}/grants`, { userId: bobId, capabilities: ["edit_services"], effect: "allow" });
      try {
        const denied = await one(bobMcp, "secret_request", { id: "mail-pass" });
        expect(denied.ok).toBe(false);
        expect(denied.error.code).toBe("forbidden");
        expect(denied.error.message).toContain("edit_files");
      } finally {
        const grants = await alice.get(`/v1/bundles/${bundleId}/grants`);
        for (const g of grants.body.data.filter((g: any) => g.userId === bobId && g.capability === "edit_services")) {
          await alice.delete(`/v1/bundles/${bundleId}/grants/${g.id}`);
        }
      }
    });

    it("re-checks that the requester still holds edit_services", async () => {
      await alice.post(`/v1/bundles/${bundleId}/grants`, { userId: bobId, capabilities: ["edit_services"], effect: "allow" });
      const req = await one(bobMcp, "secret_request", { id: "vault" });
      expect(req.ok).toBe(true);
      const grants = await alice.get(`/v1/bundles/${bundleId}/grants`);
      for (const g of grants.body.data.filter((g: any) => g.userId === bobId && g.capability === "edit_services")) {
        await alice.delete(`/v1/bundles/${bundleId}/grants/${g.id}`);
      }
      const out = await submit(req.result.request_id, req._meta.data.token, { token: "Bearer other" });
      expect(out.status).toBe(403);
    });

    it("no read over REST or MCP contains a stored secret value", async () => {
      const reads = [
        await alice.get(`/v1/bundles/${bundleId}/services`),
        await bobRest.get(`/v1/bundles/${bundleId}/services`),
        await alice.get(`/v1/bundles/${bundleId}/runs`),
        await one(aliceMcp, "get_service", { id: "notify" }),
        await one(aliceMcp, "get_service", { id: "vault" }),
        await one(aliceMcp, "secret_request", { id: "vault" }),
        await one(aliceMcp, "list_runs", {}),
        await aliceMcp.call("load_bundle", { bundle_ids: [bundleId] }),
        await aliceMcp.call("list_drivers", {}),
      ];
      const serialized = JSON.stringify(reads);
      for (const secret of SECRETS) expect(serialized).not.toContain(secret);
      // Nor does the database hold one in clear text.
      const rows = await app.db.client.select().from(app.db.tables.services);
      const dump = JSON.stringify(rows);
      for (const secret of SECRETS) expect(dump).not.toContain(secret);
    });

    it("deleting the service deletes its open forms", async () => {
      const req = await one(aliceMcp, "secret_request", { id: "vault" });
      expect((await one(aliceMcp, "delete_service", { id: "vault" })).ok).toBe(true);
      const { secretRequests } = app.db.tables;
      const left = await app.db.client.select().from(secretRequests).where(eq(secretRequests.id, req.result.request_id));
      expect(left).toEqual([]);
      expect((await submit(req.result.request_id, req._meta.data.token, { token: "x" })).status).toBe(401);
    });
  });
});
