/**
 * Services over REST: REST-only authoring, an encrypted config that never
 * leaves the server, allowlisted-parameter runs through
 * `POST /v1/services/:id/run`, the SSRF guard at authoring and at run time,
 * the run budget, the run-reading routes, and the capability asymmetries.
 *
 * This is the hooks suite carried onto the services surface — every security
 * property the hook surface pinned is pinned again here, on the routes that
 * replace it. The last block covers the same ground over MCP: `run_service` /
 * `get_run` / `list_runs`, the adapter's wait clamp, and what `load_bundle`
 * shows. (The legacy `/hooks` mounts keep their own suite in
 * `hooks-compat.test.ts`.)
 */
import { createServer, type Server } from "node:http";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encryptSecret } from "../../src/crypto.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, getFreePort, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp, type McpTestClient } from "../helpers/mcp.js";

interface ReceivedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describeEachAdapter("services", (adapter) => {
  let app: TestApp;
  let alice: ApiClient;
  let aliceMcp: McpTestClient;
  let bobRest: ApiClient;
  let bobKey: string;
  let bobId: string;
  let spaceId: string;
  let bundleId: string;
  let siblingBundleId: string;

  let target: Server;
  let targetPort: number;
  const received: ReceivedRequest[] = [];

  /** Authors an http service and returns its id. */
  const authorService = async (bundle: string, body: Record<string, unknown>): Promise<string> => {
    const res = await alice.post(`/v1/bundles/${bundle}/services`, body);
    expect(res.status).toBe(201);
    return res.body.id;
  };

  /** Runs a service and waits long enough for a terminal record. */
  const run = (client: ApiClient, serviceId: string, body: Record<string, unknown> = {}) =>
    client.post(`/v1/services/${serviceId}/run`, { wait_ms: 5_000, ...body });

  beforeAll(async () => {
    targetPort = await getFreePort();
    target = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        if (req.url?.includes("slow")) {
          setTimeout(() => {
            res.writeHead(200).end("slow response");
          }, 2000);
          return;
        }
        if (req.url?.includes("lag")) {
          // Long enough that a run against it cannot be terminal by the time
          // an unwaited dispatch returns, short enough to finish inside the
          // action's 700ms budget.
          setTimeout(() => {
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ received: true }));
          }, 250);
          return;
        }
        if (req.url?.includes("fail")) {
          res.writeHead(502, { "content-type": "text/plain" }).end("upstream exploded");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ received: true }));
      });
    });
    await new Promise<void>((resolve) => target.listen(targetPort, "127.0.0.1", resolve));

    app = await bootTestApp(
      { YAP_HOOK_ALLOW_HOSTS: "127.0.0.1", YAP_HOOK_TIMEOUT_MS: "700" },
      await adapter.makeDb(),
    );
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    aliceMcp = await connectMcp(app.baseUrl, a.body.initialKey.key);
    const b = await sysadmin.post("/v1/users", { name: "Bob" });
    bobRest = apiClient(app.baseUrl, b.body.initialKey.key);
    bobKey = b.body.initialKey.key;
    bobId = b.body.user.id;

    spaceId = (await alice.post("/v1/spaces", { name: "Serviced" })).body.id;
    bundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "notifier" })).body.id;
    siblingBundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "sibling" })).body.id;
  });

  afterAll(async () => {
    await aliceMcp.close();
    await app.stop();
    await new Promise<void>((resolve, reject) => target.close((e) => (e ? reject(e) : resolve())));
  });

  describe("authoring (REST-only, edit_services)", () => {
    let notifyId: string;

    it("creates a service whose config is never returned by any surface", async () => {
      const res = await alice.post(`/v1/bundles/${bundleId}/services`, {
        name: "notify",
        description: "Send a notification",
        params: [
          { name: "message", description: "What to say", required: true },
          { name: "channel", description: "Where to say it" },
        ],
        config: {
          url: `http://127.0.0.1:${targetPort}/notify?channel={{channel}}`,
          method: "POST",
          headers: { authorization: "Bearer super-secret-token", "content-type": "application/json" },
          body_template: `{"text": "{{message}}"}`,
        },
      });
      expect(res.status).toBe(201);
      notifyId = res.body.id;
      expect(res.body.driver).toBe("http"); // defaulted
      expect(JSON.stringify(res.body)).not.toContain("super-secret-token");
      expect(JSON.stringify(res.body)).not.toContain("127.0.0.1");

      const listed = await alice.get(`/v1/bundles/${bundleId}/services`);
      expect(JSON.stringify(listed.body)).not.toContain("super-secret-token");
      const notify = listed.body.data.find((s: any) => s.name === "notify");
      expect(notify.id).toBe(notifyId);
      expect(notify.actions[0].params.map((p: any) => p.name)).toEqual(["message", "channel"]);

      // The MCP bundle view carries the same half — never the config.
      const viaMcp = await aliceMcp.call("load_bundle", { bundle_ids: [bundleId] });
      const serialized = JSON.stringify(viaMcp.bundles[0]);
      expect(serialized).toContain("notify");
      expect(serialized).not.toContain("super-secret-token");
      expect(serialized).not.toContain(String(targetPort));
    });

    it("stores the config encrypted at rest", async () => {
      const { services } = app.db.tables;
      const row = (await app.db.client.select().from(services).where(eq(services.name, "notify")))[0]!;
      expect(row.configEncrypted).toMatch(/^v1\./);
      expect(row.configEncrypted).not.toContain("super-secret-token");
      expect(row.configEncrypted).not.toContain("127.0.0.1");
    });

    it("service authoring is absent from the MCP surface", async () => {
      const tools = await aliceMcp.client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names.some((n) => /service/.test(n))).toBe(false); // no top-level service tools
      for (const tool of ["create_service", "update_service", "delete_service"]) {
        const result = await aliceMcp.call("call", {
          space_id: spaceId,
          calls: [{ bundle_id: bundleId, tool, params: {} }],
        });
        expect(result.results[0].ok).toBe(false);
        expect(result.results[0].error.message).toContain("unknown tool");
      }
    });

    it("requires edit_services to author", async () => {
      await alice.post(`/v1/bundles/${bundleId}/grants`, {
        userId: bobId,
        capabilities: ["run_services", "read_items"],
        effect: "allow",
      });
      const res = await bobRest.post(`/v1/bundles/${bundleId}/services`, {
        name: "bobs-service",
        config: { url: `http://127.0.0.1:${targetPort}/x`, method: "GET" },
      });
      expect(res.status).toBe(403);
      expect(res.body.error.details.capability).toBe("edit_services");
    });

    it("rejects an unknown driver, naming the installed ones", async () => {
      const res = await alice.post(`/v1/bundles/${bundleId}/services`, {
        name: "smoke",
        driver: "smoke-signal",
        config: {},
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/unknown driver "smoke-signal" \(installed: .*http.*\)/);
    });

    it("denies private destinations at creation unless allowlisted", async () => {
      const restricted = await bootTestApp(); // no allow hosts
      try {
        const sysadmin = apiClient(restricted.baseUrl, TEST_SYSADMIN_KEY);
        const u = await sysadmin.post("/v1/users", { name: "U" });
        const user = apiClient(restricted.baseUrl, u.body.initialKey.key);
        const sid = (await user.post("/v1/spaces", { name: "S" })).body.id;
        const bid = (await user.post(`/v1/spaces/${sid}/bundles`, { name: "b" })).body.id;
        const denied = await user.post(`/v1/bundles/${bid}/services`, {
          name: "ssrf",
          config: { url: "http://127.0.0.1:8080/internal", method: "GET" },
        });
        expect(denied.status).toBe(400);
        expect(denied.body.error.message).toMatch(/denied by default/);
        const metadata = await user.post(`/v1/bundles/${bid}/services`, {
          name: "metadata",
          config: { url: "http://169.254.169.254/latest/meta-data/", method: "GET" },
        });
        expect(metadata.status).toBe(400);
      } finally {
        await restricted.stop();
      }
    });

    it("rejects parameterized hosts", async () => {
      const res = await alice.post(`/v1/bundles/${bundleId}/services`, {
        name: "host-injection",
        params: [{ name: "host" }],
        config: { url: "http://{{host}}/x", method: "GET" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/host cannot contain parameters|valid URL/);
    });

    it("rejects a config that sets both body_template and body_json", async () => {
      const res = await alice.post(`/v1/bundles/${bundleId}/services`, {
        name: "both-bodies",
        params: [{ name: "message" }],
        config: {
          url: `http://127.0.0.1:${targetPort}/x`,
          method: "POST",
          body_template: `{"text":"{{message}}"}`,
          body_json: { text: "{{message}}" },
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/body_template or body_json|not both/);
    });

    it("rejects renaming a service onto another service's name in the same bundle", async () => {
      const a = await authorService(bundleId, {
        name: "rename-target-a",
        config: { url: `http://127.0.0.1:${targetPort}/a`, method: "GET" },
      });
      const b = await authorService(bundleId, {
        name: "rename-target-b",
        config: { url: `http://127.0.0.1:${targetPort}/b`, method: "GET" },
      });
      expect(a).not.toBe(b);

      const clash = await alice.patch(`/v1/services/${b}`, { name: "rename-target-a" });
      expect(clash.status).toBe(400);
      expect(clash.body.error.message).toContain("already exists");
    });

    it("allows renaming a service to its own current name (self-rename is a no-op)", async () => {
      const id = await authorService(bundleId, {
        name: "self-rename-service",
        config: { url: `http://127.0.0.1:${targetPort}/self`, method: "GET" },
      });
      const selfRenamed = await alice.patch(`/v1/services/${id}`, { name: "self-rename-service" });
      expect(selfRenamed.status).toBe(200);
      expect(selfRenamed.body.name).toBe("self-rename-service");
    });

    it("accepts an action allowlist naming the driver's actions and rejects anything else", async () => {
      const id = await authorService(bundleId, {
        name: "allowlisted",
        params: [{ name: "message" }],
        actions: ["fire"],
        config: { url: `http://127.0.0.1:${targetPort}/allowlisted`, method: "GET" },
      });
      const listed = (await alice.get(`/v1/bundles/${bundleId}/services`)).body.data.find((s: any) => s.id === id);
      expect(listed.actions.map((a: any) => a.name)).toEqual(["fire"]);

      for (const actions of [[], ["fire", "fire"], ["launch"], "fire", [1]]) {
        const res = await alice.post(`/v1/bundles/${bundleId}/services`, {
          name: "bad-allowlist",
          actions,
          config: { url: `http://127.0.0.1:${targetPort}/x`, method: "GET" },
        });
        expect(res.status, JSON.stringify(actions)).toBe(400);
      }
      expect((await alice.patch(`/v1/services/${id}`, { actions: ["launch"] })).status).toBe(400);
      expect((await alice.patch(`/v1/services/${id}`, { actions: [] })).status).toBe(400);

      const cleared = await alice.patch(`/v1/services/${id}`, { actions: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.actions.map((a: any) => a.name)).toEqual(["fire"]);
      expect((await alice.delete(`/v1/services/${id}`)).status).toBe(200);
    });

    it("updates and deletes a service", async () => {
      const id = await authorService(bundleId, {
        name: "temporary",
        params: [{ name: "message" }],
        config: { url: `http://127.0.0.1:${targetPort}/tmp`, method: "GET" },
      });
      const patched = await alice.patch(`/v1/services/${id}`, {
        description: "now described",
        params: [{ name: "message" }, { name: "channel" }],
      });
      expect(patched.status).toBe(200);
      expect(patched.body.description).toBe("now described");
      expect(patched.body.actions[0].params.map((p: any) => p.name)).toEqual(["message", "channel"]);

      const deleted = await alice.delete(`/v1/services/${id}`);
      expect(deleted.status).toBe(200);
      expect(deleted.body).toEqual({ deleted: true });
      expect((await alice.patch(`/v1/services/${id}`, { name: "x" })).status).toBe(404);
    });
  });

  describe("running (run_services)", () => {
    let notifyId: string;

    beforeAll(async () => {
      const listed = await alice.get(`/v1/bundles/${bundleId}/services`);
      notifyId = listed.body.data.find((s: any) => s.name === "notify").id;
    });

    it("slots allowlisted params into the hidden config and returns the raw result", async () => {
      received.length = 0;
      const res = await run(alice, notifyId, { params: { message: "deploy finished", channel: "ops" } });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("succeeded");
      expect(res.body.serviceId).toBe(notifyId);
      expect(res.body.serviceName).toBe("notify");
      expect(res.body.action).toBe("fire");
      expect(res.body.result.status).toBe(200);
      expect(JSON.parse(res.body.result.body)).toEqual({ received: true });
      expect(res.body.error).toBeNull();

      expect(received).toHaveLength(1);
      const hit = received[0]!;
      expect(hit.method).toBe("POST");
      expect(hit.url).toBe("/notify?channel=ops");
      expect(hit.headers.authorization).toBe("Bearer super-secret-token"); // server-side secret, the caller never saw it
      expect(JSON.parse(hit.body)).toEqual({ text: "deploy finished" });
    });

    it("URL-encodes parameter values substituted into the URL", async () => {
      received.length = 0;
      await run(alice, notifyId, { params: { message: "x", channel: "a b&c=d" } });
      expect(received[0]!.url).toBe("/notify?channel=a%20b%26c%3Dd");
    });

    it("escapes values interpolated into a body_json string leaf", async () => {
      const id = await authorService(bundleId, {
        name: "notify-json",
        params: [{ name: "message", required: true }],
        config: { url: `http://127.0.0.1:${targetPort}/json`, method: "POST", body_json: { text: "{{message}}" } },
      });
      received.length = 0;
      const tricky = 'say "hi"\n\tand a \\ backslash';
      const res = await run(alice, id, { params: { message: tricky } });
      expect(res.body.status).toBe("succeeded");
      expect(received).toHaveLength(1);
      // Valid JSON whose value round-trips exactly, despite quotes/newline/backslash.
      expect(JSON.parse(received[0]!.body)).toEqual({ text: tricky });
      // content-type defaulted because the author set none.
      expect(String(received[0]!.headers["content-type"])).toMatch(/application\/json/);
    });

    it("a crafted body_json value cannot inject JSON structure", async () => {
      const id = await authorService(bundleId, {
        name: "notify-json-inject",
        params: [{ name: "message", required: true }],
        config: { url: `http://127.0.0.1:${targetPort}/json`, method: "POST", body_json: { text: "{{message}}" } },
      });
      received.length = 0;
      const attack = '", "admin": true, "x": "';
      await run(alice, id, { params: { message: attack } });
      const parsed = JSON.parse(received[0]!.body);
      expect(Object.keys(parsed)).toEqual(["text"]); // no injected field
      expect(parsed.text).toBe(attack); // the whole value landed as one string
      expect(parsed.admin).toBeUndefined();
    });

    it("preserves an explicit content-type when body_json is used", async () => {
      const id = await authorService(bundleId, {
        name: "notify-json-ct",
        params: [{ name: "message", required: true }],
        config: {
          url: `http://127.0.0.1:${targetPort}/json`,
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body_json: { text: "{{message}}" },
        },
      });
      received.length = 0;
      await run(alice, id, { params: { message: "x" } });
      expect(received[0]!.headers["content-type"]).toBe("application/json; charset=utf-8");
    });

    it("rejects CR/LF in a substituted header value (no request reaches the target)", async () => {
      const id = await authorService(bundleId, {
        name: "header-inject",
        params: [{ name: "tag", required: true }],
        config: {
          url: `http://127.0.0.1:${targetPort}/hdr`,
          method: "POST",
          headers: { "x-tag": "{{tag}}" },
          body_json: { ok: true },
        },
      });
      received.length = 0;
      const res = await run(alice, id, { params: { tag: "good\r\nx-injected: evil" } });
      expect(res.body.status).toBe("failed");
      expect(res.body.error).toMatch(/line break|header/i);
      expect(received).toHaveLength(0); // nothing was sent
    });

    it("rejects undeclared parameters (allowlisting is the safety hinge)", async () => {
      const res = await run(alice, notifyId, { params: { message: "x", url: "http://evil.example" } });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('unknown parameter "url"');
    });

    it("rejects missing required parameters", async () => {
      const res = await run(alice, notifyId, { params: { channel: "ops" } });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('required parameter "message"');
    });

    it("rejects an unknown action", async () => {
      const res = await run(alice, notifyId, { action: "explode", params: { message: "x" } });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/unknown action "explode"/);
    });

    it("keeps a pinned parameter out of the listing and out of the caller's reach", async () => {
      const id = await authorService(bundleId, {
        name: "pinned",
        params: [{ name: "message", required: true }, { name: "channel" }],
        pins: { channel: "ops" },
        config: {
          url: `http://127.0.0.1:${targetPort}/pinned?channel={{channel}}`,
          method: "POST",
          body_json: { text: "{{message}}" },
        },
      });
      // The pin is configuration: it is not even visible as a parameter name.
      const listed = await alice.get(`/v1/bundles/${bundleId}/services`);
      const pinned = listed.body.data.find((s: any) => s.name === "pinned");
      expect(pinned.actions[0].params.map((p: any) => p.name)).toEqual(["message"]);

      // Supplying it is an explicit error, not a silent override…
      const overridden = await run(alice, id, { params: { message: "x", channel: "attacker" } });
      expect(overridden.status).toBe(400);
      expect(overridden.body.error.message).toMatch(/"channel" is fixed by this service configuration/);

      // …and the fixed value is what the destination sees.
      received.length = 0;
      const ok = await run(alice, id, { params: { message: "hello" } });
      expect(ok.body.status).toBe("succeeded");
      expect(received[0]!.url).toBe("/pinned?channel=ops");
      // The run record shows the caller's half only. A pin is configuration —
      // often a token or a fixed recipient — and the record is readable by
      // anyone who can run the service, so the merged set is never written
      // down: it exists only long enough to reach the driver.
      expect(ok.body.params).toEqual({ message: "hello" });
      expect(ok.body.params).not.toHaveProperty("channel");
      expect(JSON.stringify(ok.body.params)).not.toContain("ops");
    });

    it("returns non-2xx upstream results raw — the caller decides what to do", async () => {
      const id = await authorService(bundleId, {
        name: "failing",
        config: { url: `http://127.0.0.1:${targetPort}/fail`, method: "GET" },
      });
      const res = await run(alice, id);
      expect(res.body.status).toBe("succeeded"); // the call succeeded; the upstream status is data
      expect(res.body.result.status).toBe(502);
      expect(res.body.result.body).toBe("upstream exploded");
    });

    it("times out per the action's budget with no automatic retries", async () => {
      const id = await authorService(bundleId, {
        name: "slow",
        config: { url: `http://127.0.0.1:${targetPort}/slow`, method: "GET" },
      });
      received.length = 0;
      const res = await run(alice, id);
      expect(res.body.status).toBe("failed");
      expect(res.body.error).toMatch(/timed out after 700ms/);
      expect(received).toHaveLength(1); // exactly one attempt — no retries
    });

    it("re-checks the SSRF guard at run time", async () => {
      // Plant a service whose stored destination is private, bypassing the
      // creation check — as if DNS changed after authoring.
      const { services } = app.db.tables;
      await app.db.client.insert(services).values({
        id: "planted-service",
        bundleId,
        name: "rebound",
        description: "",
        driver: "http",
        params: "[]",
        pins: "{}",
        configEncrypted: encryptSecret(
          JSON.stringify({ url: "http://192.168.0.1/internal", method: "GET" }),
          app.config.masterKey,
        ),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const res = await run(alice, "planted-service");
      expect(res.body.status).toBe("failed");
      expect(res.body.error).toMatch(/blocked by the SSRF guard/);
      // The hidden destination (host/IP) must never reach the running caller.
      expect(JSON.stringify(res.body)).not.toContain("192.168.0.1");
      expect(JSON.stringify(res.body)).not.toContain("internal");
    });

    it("requires run_services; discovery needs only read access", async () => {
      const viewer = (await apiClient(app.baseUrl, TEST_SYSADMIN_KEY).post("/v1/users", { name: "Viewer" })).body;
      await alice.post(`/v1/bundles/${bundleId}/grants`, {
        userId: viewer.user.id,
        capabilities: ["read_items"],
        effect: "allow",
      });
      const viewerRest = apiClient(app.baseUrl, viewer.initialKey.key);
      // Can browse services (read access)…
      const listed = await viewerRest.get(`/v1/bundles/${bundleId}/services`);
      expect(listed.status).toBe(200);
      expect(listed.body.data.length).toBeGreaterThan(0);
      // …but cannot run one, nor read the run log.
      const denied = await run(viewerRest, notifyId, { params: { message: "x" } });
      expect(denied.status).toBe(403);
      expect(denied.body.error.details.capability).toBe("run_services");
      const runs = await viewerRest.get(`/v1/bundles/${bundleId}/runs`);
      expect(runs.status).toBe(403);
      expect(runs.body.error.details.capability).toBe("run_services");
    });

    it("acceptance: space-level run_services with a bundle-level deny blocks that bundle, not its sibling", async () => {
      const siblingId = await authorService(siblingBundleId, {
        name: "sibling-service",
        config: { url: `http://127.0.0.1:${targetPort}/sibling`, method: "GET" },
      });
      // Bob: run_services at space level…
      await alice.post(`/v1/spaces/${spaceId}/grants`, {
        userId: bobId,
        capabilities: ["run_services"],
        effect: "allow",
      });
      // …revoked on the notifier bundle specifically.
      const denyRow = await alice.post(`/v1/bundles/${bundleId}/grants`, {
        userId: bobId,
        capabilities: ["run_services"],
        effect: "deny",
      });
      const blocked = await run(bobRest, notifyId, { params: { message: "x" } });
      expect(blocked.status).toBe(403);
      // The deciding row is identifiable for the deny…
      expect(blocked.body.error.details.decidedBy).toEqual({
        grantId: denyRow.body.data[0].id,
        level: "bundle",
        effect: "deny",
      });
      // …and the sibling runs fine under the space baseline.
      const allowed = await run(bobRest, siblingId);
      expect(allowed.body.status).toBe("succeeded");
      expect(allowed.body.result.status).toBe(200);
    });
  });

  describe("the run log", () => {
    it("reads one run back and lists a bundle's runs, newest first, filtered by service", async () => {
      const id = await authorService(bundleId, {
        name: "logged",
        config: { url: `http://127.0.0.1:${targetPort}/logged`, method: "GET" },
      });
      const first = (await run(alice, id)).body;
      const second = (await run(alice, id)).body;

      const one = await alice.get(`/v1/runs/${first.id}`);
      expect(one.status).toBe(200);
      expect(one.body.id).toBe(first.id);
      expect(one.body.status).toBe("succeeded");

      const listed = await alice.get(`/v1/bundles/${bundleId}/runs?service=logged`);
      expect(listed.status).toBe(200);
      expect(listed.body.data.map((r: any) => r.id)).toEqual([second.id, first.id]);
      expect(listed.body.nextCursor).toBeNull();

      // Paging carries a cursor the next page consumes.
      const page = await alice.get(`/v1/bundles/${bundleId}/runs?service=logged&limit=1`);
      expect(page.body.data.map((r: any) => r.id)).toEqual([second.id]);
      expect(page.body.nextCursor).toEqual(expect.any(String));
      const next = await alice.get(
        `/v1/bundles/${bundleId}/runs?service=logged&limit=1&cursor=${page.body.nextCursor}`,
      );
      expect(next.body.data.map((r: any) => r.id)).toEqual([first.id]);

      // A run in a bundle the caller cannot see is indistinguishable from one
      // that never existed.
      const outsider = apiClient(
        app.baseUrl,
        (await apiClient(app.baseUrl, TEST_SYSADMIN_KEY).post("/v1/users", { name: "Outsider" })).body.initialKey.key,
      );
      expect((await outsider.get(`/v1/runs/${first.id}`)).status).toBe(404);
    });

    it("clamps wait_ms to the configured cap and leaves the run to finish on its own", async () => {
      const capped = await bootTestApp({
        YAP_HOOK_ALLOW_HOSTS: "127.0.0.1",
        YAP_HOOK_TIMEOUT_MS: "700",
        YAP_RUN_WAIT_CAP_MS: "50",
      });
      try {
        const sysadmin = apiClient(capped.baseUrl, TEST_SYSADMIN_KEY);
        const u = await sysadmin.post("/v1/users", { name: "Waiter" });
        const user = apiClient(capped.baseUrl, u.body.initialKey.key);
        const sid = (await user.post("/v1/spaces", { name: "S" })).body.id;
        const bid = (await user.post(`/v1/spaces/${sid}/bundles`, { name: "b" })).body.id;
        const created = await user.post(`/v1/bundles/${bid}/services`, {
          name: "slow",
          config: { url: `http://127.0.0.1:${targetPort}/slow`, method: "GET" },
        });
        expect(created.status).toBe(201);

        // The caller asks for 5s; the cap is 50ms, well under the action's own
        // 700ms budget, so the record comes back before the run can finish.
        const started = await user.post(`/v1/services/${created.body.id}/run`, { wait_ms: 5_000 });
        expect(started.status).toBe(200);
        expect(["queued", "running"]).toContain(started.body.status);
        expect(started.body.result).toBeNull();

        // …and the run finishes anyway, on the row, for the caller to poll.
        let polled = started.body;
        for (let i = 0; i < 60 && polled.status !== "failed" && polled.status !== "succeeded"; i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          polled = (await user.get(`/v1/runs/${started.body.id}`)).body;
        }
        expect(polled.status).toBe("failed");
        expect(polled.error).toMatch(/timed out after 700ms/);
      } finally {
        await capped.stop();
      }
    });
  });

  describe("running over MCP", () => {
    /** One second-tier call, returning the per-call result. */
    const mcpCall = async (
      client: McpTestClient,
      bundle: string,
      tool: string,
      params: Record<string, unknown> = {},
    ) => {
      const res = await client.call("call", {
        space_id: spaceId,
        calls: [{ bundle_id: bundle, tool, params }],
      });
      return res.results[0];
    };

    const terminal = (status: string) => status === "succeeded" || status === "failed";

    /** Polls get_run over MCP until the run reaches a terminal status. */
    const pollRun = async (client: McpTestClient, bundle: string, runId: string) => {
      let record: any;
      for (let i = 0; i < 80; i++) {
        const got = await mcpCall(client, bundle, "get_run", { id: runId });
        expect(got.ok).toBe(true);
        record = got.result;
        if (terminal(record.status)) return record;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return record;
    };

    it("run_service with a wait returns the finished run inline", async () => {
      received.length = 0;
      const started = await mcpCall(aliceMcp, bundleId, "run_service", {
        id: "notify",
        params: { message: "over MCP", channel: "ops" },
        wait_ms: 5_000,
      });
      expect(started.ok).toBe(true);
      expect(started.result.status).toBe("succeeded");
      expect(started.result.serviceName).toBe("notify");
      expect(started.result.action).toBe("fire");
      expect(started.result.id).toEqual(expect.any(String));
      expect(started.result.result.status).toBe(200);
      expect(JSON.parse(started.result.result.body)).toEqual({ received: true });
      expect(received).toHaveLength(1);
      // The configuration stays server-side on this surface too.
      expect(JSON.stringify(started)).not.toContain("super-secret-token");
    });

    it("wait_ms: 0 hands back a pending run that get_run polls to terminal", async () => {
      // A destination that answers slowly on purpose: against an instant one
      // the run can legitimately be finished before the dispatch returns, and
      // "still pending" is exactly what this test is about.
      const lagging = await authorService(bundleId, {
        name: "lagging",
        config: { url: `http://127.0.0.1:${targetPort}/lag`, method: "GET" },
      });
      const pending = await mcpCall(aliceMcp, bundleId, "run_service", {
        id: lagging,
        wait_ms: 0,
      });
      expect(pending.ok).toBe(true);
      expect(["queued", "running"]).toContain(pending.result.status);
      expect(pending.result.result).toBeNull();

      const finished = await pollRun(aliceMcp, bundleId, pending.result.id);
      expect(finished.status).toBe("succeeded");
      expect(finished.id).toBe(pending.result.id);
      expect(finished.result.status).toBe(200);
    });

    it("run_service rejects an undeclared parameter as a per-call failure", async () => {
      const bad = await mcpCall(aliceMcp, bundleId, "run_service", {
        id: "notify",
        params: { message: "x", url: "http://evil.example" },
      });
      expect(bad.ok).toBe(false);
      expect(bad.error.code).toBe("invalid_request");
      expect(bad.error.message).toContain('unknown parameter "url"');
    });

    it("get_run hides a run in a bundle the caller cannot see behind a 404", async () => {
      const mine = await mcpCall(aliceMcp, bundleId, "run_service", {
        id: "notify",
        params: { message: "private", channel: "ops" },
        wait_ms: 5_000,
      });
      expect(mine.ok).toBe(true);

      // Carol can reach the space (a grant on the sibling bundle) but has no
      // foothold at all in the bundle that holds the run.
      const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
      const c = await sysadmin.post("/v1/users", { name: "Carol" });
      await alice.post(`/v1/bundles/${siblingBundleId}/grants`, {
        userId: c.body.user.id,
        capabilities: ["run_services"],
        effect: "allow",
      });
      const carolMcp = await connectMcp(app.baseUrl, c.body.initialKey.key);
      try {
        const denied = await mcpCall(carolMcp, siblingBundleId, "get_run", { id: mine.result.id });
        expect(denied.ok).toBe(false);
        expect(denied.error.code).toBe("not_found");
        // Neither the run's bundle nor its service may be named.
        expect(denied.error.message).not.toContain(bundleId);
        expect(denied.error.message).not.toContain("notify");
        // An id that never existed is indistinguishable.
        const missing = await mcpCall(carolMcp, siblingBundleId, "get_run", { id: "no-such-run" });
        expect(missing.error.code).toBe("not_found");
      } finally {
        await carolMcp.close();
      }
    });

    it("list_runs pages the bundle's runs newest-first as {data, nextCursor}", async () => {
      const first = await mcpCall(aliceMcp, bundleId, "list_runs", { service: "notify", limit: 1 });
      expect(first.ok).toBe(true);
      expect(Object.keys(first.result).sort()).toEqual(["data", "nextCursor"]);
      expect(first.result.data).toHaveLength(1);
      expect(first.result.data[0].serviceName).toBe("notify");
      expect(first.result.nextCursor).toEqual(expect.any(String));

      const next = await mcpCall(aliceMcp, bundleId, "list_runs", {
        service: "notify",
        limit: 1,
        cursor: first.result.nextCursor,
      });
      expect(next.ok).toBe(true);
      expect(next.result.data).toHaveLength(1);
      expect(next.result.data[0].id).not.toBe(first.result.data[0].id);

      // Unfiltered, the bundle's other services show up too.
      const all = await mcpCall(aliceMcp, bundleId, "list_runs", {});
      expect(all.result.data.length).toBeGreaterThan(first.result.data.length);
      expect(new Set(all.result.data.map((r: any) => r.serviceName)).size).toBeGreaterThan(1);
    });

    it("clamps wait_ms to the server's cap rather than honouring what the agent asked", async () => {
      const capped = await bootTestApp({
        YAP_HOOK_ALLOW_HOSTS: "127.0.0.1",
        YAP_HOOK_TIMEOUT_MS: "700",
        YAP_RUN_WAIT_CAP_MS: "50",
      });
      let cappedMcp: McpTestClient | undefined;
      try {
        const sysadmin = apiClient(capped.baseUrl, TEST_SYSADMIN_KEY);
        const u = await sysadmin.post("/v1/users", { name: "Waiter" });
        const user = apiClient(capped.baseUrl, u.body.initialKey.key);
        const sid = (await user.post("/v1/spaces", { name: "S" })).body.id;
        const bid = (await user.post(`/v1/spaces/${sid}/bundles`, { name: "b" })).body.id;
        const created = await user.post(`/v1/bundles/${bid}/services`, {
          name: "slow",
          config: { url: `http://127.0.0.1:${targetPort}/slow`, method: "GET" },
        });
        expect(created.status).toBe(201);

        cappedMcp = await connectMcp(capped.baseUrl, u.body.initialKey.key);
        const res = await cappedMcp.call("call", {
          space_id: sid,
          calls: [{ bundle_id: bid, tool: "run_service", params: { id: "slow", wait_ms: 999_999 } }],
        });
        const started = res.results[0];
        expect(started.ok).toBe(true);
        // 50ms cap, well inside the action's own 700ms budget.
        expect(["queued", "running"]).toContain(started.result.status);
        expect(started.durationMs).toBeLessThan(600);

        // …and the run finishes on the row regardless, for get_run to pick up.
        let polled = started.result;
        for (let i = 0; i < 80 && !terminal(polled.status); i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          polled = (await user.get(`/v1/runs/${started.result.id}`)).body;
        }
        expect(polled.status).toBe("failed");
        expect(polled.error).toMatch(/timed out after 700ms/);
      } finally {
        await cappedMcp?.close();
        await capped.stop();
      }
    });

    it("load_bundle lists services with their effective params, plus the legacy hooks key", async () => {
      const loaded = await aliceMcp.call("load_bundle", { bundle_ids: [bundleId] });
      const bundle = loaded.bundles[0];

      const notify = bundle.services.find((s: any) => s.name === "notify");
      expect(Object.keys(notify).sort()).toEqual(["actions", "description", "driver", "id", "name"]);
      expect(notify.driver).toBe("http");
      expect(notify.description).toBe("Send a notification");
      expect(notify.actions.map((a: any) => a.name)).toEqual(["fire"]);
      expect(notify.actions[0].params.map((p: any) => p.name)).toEqual(["message", "channel"]);

      // Pinned parameters are configuration: absent from the effective specs.
      const pinned = bundle.services.find((s: any) => s.name === "pinned");
      expect(pinned.actions[0].params.map((p: any) => p.name)).toEqual(["message"]);

      // Never the config, on this surface either.
      const serialized = JSON.stringify(bundle.services);
      expect(serialized).not.toContain("super-secret-token");
      expect(serialized).not.toContain(String(targetPort));

      // The legacy key still carries the http subset in the old four-field shape.
      expect(Array.isArray(bundle.hooks)).toBe(true);
      for (const hook of bundle.hooks) {
        expect(Object.keys(hook).sort()).toEqual(["description", "id", "name", "params"]);
      }
      const httpIds = bundle.services.filter((s: any) => s.driver === "http").map((s: any) => s.id);
      expect(bundle.hooks.map((h: any) => h.id).sort()).toEqual([...httpIds].sort());
    });

    it("lists a service whose driver is not installed, with no actions and no crash", async () => {
      const { services } = app.db.tables;
      await app.db.client.insert(services).values({
        id: "orphaned-driver-service",
        bundleId: siblingBundleId,
        name: "orphaned",
        description: "authored against a driver this server no longer has",
        driver: "smoke-signal",
        params: JSON.stringify([{ name: "message" }]),
        pins: "{}",
        configEncrypted: encryptSecret(JSON.stringify({ smoke: "grey" }), app.config.masterKey),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const loaded = await aliceMcp.call("load_bundle", { bundle_ids: [siblingBundleId] });
      const bundle = loaded.bundles[0];
      expect(bundle.error).toBeUndefined();
      const orphan = bundle.services.find((s: any) => s.name === "orphaned");
      // The row is real and an operator must see it — the driver's absence is
      // reported as an empty action list, not as a failed listing.
      expect(orphan.driver).toBe("smoke-signal");
      expect(orphan.actions).toEqual([]);
      // It is not an http service, so the legacy view never shows it.
      expect(bundle.hooks.some((h: any) => h.name === "orphaned")).toBe(false);

      // Running it explains the missing driver rather than crashing.
      const attempted = await mcpCall(aliceMcp, siblingBundleId, "run_service", { id: "orphaned" });
      expect(attempted.ok).toBe(false);
      expect(attempted.error.message).toMatch(/"smoke-signal" driver, which is not installed/);
    });
  });
});
