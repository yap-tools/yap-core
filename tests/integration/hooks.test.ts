/**
 * Hooks: REST-only authoring, encrypted transport that never leaves the
 * server, allowlisted-parameter firing through call, SSRF guard at create
 * and fire time, timeout behavior, and the capability asymmetries.
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

describeEachAdapter("hooks", (adapter) => {
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

  const fireViaMcp = async (client: McpTestClient, bundle: string, params: Record<string, unknown>) => {
    const res = await client.call("call", {
      space_id: spaceId,
      calls: [{ bundle_id: bundle, tool: "fire_hook", params }],
    });
    return res.results[0];
  };

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

    spaceId = (await alice.post("/v1/spaces", { name: "Hooked" })).body.id;
    bundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "notifier" })).body.id;
    siblingBundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "sibling" })).body.id;
  });

  afterAll(async () => {
    await aliceMcp.close();
    await app.stop();
    await new Promise<void>((resolve, reject) => target.close((e) => (e ? reject(e) : resolve())));
  });

  describe("authoring (REST-only, edit_hooks)", () => {
    it("creates a hook whose transport is never returned by any surface", async () => {
      const res = await alice.post(`/v1/bundles/${bundleId}/hooks`, {
        name: "notify",
        description: "Send a notification",
        params: [
          { name: "message", description: "What to say", required: true },
          { name: "channel", description: "Where to say it" },
        ],
        transport: {
          url: `http://127.0.0.1:${targetPort}/notify?channel={{channel}}`,
          method: "POST",
          headers: { authorization: "Bearer super-secret-token", "content-type": "application/json" },
          body_template: `{"text": "{{message}}"}`,
        },
      });
      expect(res.status).toBe(201);
      expect(JSON.stringify(res.body)).not.toContain("super-secret-token");
      expect(JSON.stringify(res.body)).not.toContain("127.0.0.1");

      const listed = await alice.get(`/v1/bundles/${bundleId}/hooks`);
      expect(JSON.stringify(listed.body)).not.toContain("super-secret-token");
      expect(listed.body.data[0].params.map((p: any) => p.name)).toEqual(["message", "channel"]);

      const viaMcp = await aliceMcp.call("load_bundle", { bundle_ids: [bundleId] });
      const hooks = viaMcp.bundles[0].hooks;
      expect(hooks[0].name).toBe("notify");
      expect(JSON.stringify(hooks)).not.toContain("super-secret-token");
      expect(JSON.stringify(hooks)).not.toContain(String(targetPort));
    });

    it("stores the transport encrypted at rest", async () => {
      const { hooks } = app.db.tables;
      const row = (await app.db.client.select().from(hooks).where(eq(hooks.name, "notify")))[0]!;
      expect(row.transportEncrypted).toMatch(/^v1\./);
      expect(row.transportEncrypted).not.toContain("super-secret-token");
      expect(row.transportEncrypted).not.toContain("127.0.0.1");
    });

    it("hook authoring is absent from the MCP surface", async () => {
      const tools = await aliceMcp.client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names.some((n) => /hook/.test(n))).toBe(false); // no top-level hook tools
      const result = await aliceMcp.call("call", {
        space_id: spaceId,
        calls: [{ bundle_id: bundleId, tool: "create_hook", params: {} }],
      });
      expect(result.results[0].ok).toBe(false);
      expect(result.results[0].error.message).toContain("unknown tool");
    });

    it("requires edit_hooks to author", async () => {
      await alice.post(`/v1/bundles/${bundleId}/grants`, {
        userId: bobId,
        capabilities: ["fire_hooks", "read_items"],
        effect: "allow",
      });
      const res = await bobRest.post(`/v1/bundles/${bundleId}/hooks`, {
        name: "bobs-hook",
        transport: { url: `http://127.0.0.1:${targetPort}/x`, method: "GET" },
      });
      expect(res.status).toBe(403);
      expect(res.body.error.details.capability).toBe("edit_hooks");
    });

    it("denies private destinations at creation unless allowlisted", async () => {
      const restricted = await bootTestApp(); // no allow hosts
      try {
        const sysadmin = apiClient(restricted.baseUrl, TEST_SYSADMIN_KEY);
        const u = await sysadmin.post("/v1/users", { name: "U" });
        const user = apiClient(restricted.baseUrl, u.body.initialKey.key);
        const sid = (await user.post("/v1/spaces", { name: "S" })).body.id;
        const bid = (await user.post(`/v1/spaces/${sid}/bundles`, { name: "b" })).body.id;
        const denied = await user.post(`/v1/bundles/${bid}/hooks`, {
          name: "ssrf",
          transport: { url: "http://127.0.0.1:8080/internal", method: "GET" },
        });
        expect(denied.status).toBe(400);
        expect(denied.body.error.message).toMatch(/denied by default/);
        const metadata = await user.post(`/v1/bundles/${bid}/hooks`, {
          name: "metadata",
          transport: { url: "http://169.254.169.254/latest/meta-data/", method: "GET" },
        });
        expect(metadata.status).toBe(400);
      } finally {
        await restricted.stop();
      }
    });

    it("rejects parameterized hosts", async () => {
      const res = await alice.post(`/v1/bundles/${bundleId}/hooks`, {
        name: "host-injection",
        params: [{ name: "host" }],
        transport: { url: "http://{{host}}/x", method: "GET" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/host cannot contain parameters|valid URL/);
    });

    it("rejects a transport that sets both body_template and body_json", async () => {
      const res = await alice.post(`/v1/bundles/${bundleId}/hooks`, {
        name: "both-bodies",
        params: [{ name: "message" }],
        transport: {
          url: `http://127.0.0.1:${targetPort}/x`,
          method: "POST",
          body_template: `{"text":"{{message}}"}`,
          body_json: { text: "{{message}}" },
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/body_template or body_json|not both/);
    });

    it("rejects renaming a hook to a name already used by another hook in the same bundle", async () => {
      // Create two hooks in the same bundle.
      const hookA = await alice.post(`/v1/bundles/${bundleId}/hooks`, {
        name: "rename-target-a",
        transport: { url: `http://127.0.0.1:${targetPort}/a`, method: "GET" },
      });
      expect(hookA.status).toBe(201);
      const hookB = await alice.post(`/v1/bundles/${bundleId}/hooks`, {
        name: "rename-target-b",
        transport: { url: `http://127.0.0.1:${targetPort}/b`, method: "GET" },
      });
      expect(hookB.status).toBe(201);

      // Renaming B to A's name must be rejected.
      const clash = await alice.patch(`/v1/hooks/${hookB.body.id}`, { name: "rename-target-a" });
      expect(clash.status).toBe(400);
      expect(clash.body.error.message).toContain("already exists");
    });

    it("allows renaming a hook to its own current name (self-rename is a no-op)", async () => {
      const created = await alice.post(`/v1/bundles/${bundleId}/hooks`, {
        name: "self-rename-hook",
        transport: { url: `http://127.0.0.1:${targetPort}/self`, method: "GET" },
      });
      expect(created.status).toBe(201);

      const selfRenamed = await alice.patch(`/v1/hooks/${created.body.id}`, { name: "self-rename-hook" });
      expect(selfRenamed.status).toBe(200);
      expect(selfRenamed.body.name).toBe("self-rename-hook");
    });
  });

  describe("firing (fire_hooks, via call)", () => {
    it("slots allowlisted params into the hidden template and returns the raw result", async () => {
      received.length = 0;
      const result = await fireViaMcp(aliceMcp, bundleId, {
        hook: "notify",
        params: { message: "deploy finished", channel: "ops" },
      });
      expect(result.ok).toBe(true);
      expect(result.result.status).toBe(200);
      expect(JSON.parse(result.result.body)).toEqual({ received: true });

      expect(received).toHaveLength(1);
      const hit = received[0]!;
      expect(hit.method).toBe("POST");
      expect(hit.url).toBe("/notify?channel=ops");
      expect(hit.headers.authorization).toBe("Bearer super-secret-token"); // server-side secret, agent never saw it
      expect(JSON.parse(hit.body)).toEqual({ text: "deploy finished" });
    });

    it("URL-encodes parameter values substituted into the URL", async () => {
      received.length = 0;
      await fireViaMcp(aliceMcp, bundleId, {
        hook: "notify",
        params: { message: "x", channel: "a b&c=d" },
      });
      expect(received[0]!.url).toBe("/notify?channel=a%20b%26c%3Dd");
    });

    it("escapes values interpolated into a body_json string leaf", async () => {
      await alice.post(`/v1/bundles/${bundleId}/hooks`, {
        name: "notify-json",
        params: [{ name: "message", required: true }],
        transport: {
          url: `http://127.0.0.1:${targetPort}/json`,
          method: "POST",
          body_json: { text: "{{message}}" },
        },
      });
      received.length = 0;
      const tricky = 'say "hi"\n\tand a \\ backslash';
      const result = await fireViaMcp(aliceMcp, bundleId, { hook: "notify-json", params: { message: tricky } });
      expect(result.ok).toBe(true);
      expect(received).toHaveLength(1);
      // Valid JSON whose value round-trips exactly, despite quotes/newline/backslash.
      expect(JSON.parse(received[0]!.body)).toEqual({ text: tricky });
      // content-type defaulted because the author set none.
      expect(String(received[0]!.headers["content-type"])).toMatch(/application\/json/);
    });

    it("a crafted body_json value cannot inject JSON structure", async () => {
      await alice.post(`/v1/bundles/${bundleId}/hooks`, {
        name: "notify-json-inject",
        params: [{ name: "message", required: true }],
        transport: {
          url: `http://127.0.0.1:${targetPort}/json`,
          method: "POST",
          body_json: { text: "{{message}}" },
        },
      });
      received.length = 0;
      const attack = '", "admin": true, "x": "';
      await fireViaMcp(aliceMcp, bundleId, { hook: "notify-json-inject", params: { message: attack } });
      const parsed = JSON.parse(received[0]!.body);
      expect(Object.keys(parsed)).toEqual(["text"]); // no injected field
      expect(parsed.text).toBe(attack); // the whole value landed as one string
      expect(parsed.admin).toBeUndefined();
    });

    it("preserves an explicit content-type when body_json is used", async () => {
      await alice.post(`/v1/bundles/${bundleId}/hooks`, {
        name: "notify-json-ct",
        params: [{ name: "message", required: true }],
        transport: {
          url: `http://127.0.0.1:${targetPort}/json`,
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body_json: { text: "{{message}}" },
        },
      });
      received.length = 0;
      await fireViaMcp(aliceMcp, bundleId, { hook: "notify-json-ct", params: { message: "x" } });
      expect(received[0]!.headers["content-type"]).toBe("application/json; charset=utf-8");
    });

    it("rejects CR/LF in a substituted header value (no request reaches the target)", async () => {
      await alice.post(`/v1/bundles/${bundleId}/hooks`, {
        name: "header-inject",
        params: [{ name: "tag", required: true }],
        transport: {
          url: `http://127.0.0.1:${targetPort}/hdr`,
          method: "POST",
          headers: { "x-tag": "{{tag}}" },
          body_json: { ok: true },
        },
      });
      received.length = 0;
      const result = await fireViaMcp(aliceMcp, bundleId, {
        hook: "header-inject",
        params: { tag: "good\r\nx-injected: evil" },
      });
      expect(result.ok).toBe(false);
      expect(result.error.message).toMatch(/line break|header/i);
      expect(received).toHaveLength(0); // nothing was sent
    });

    it("rejects undeclared parameters (allowlisting is the safety hinge)", async () => {
      const result = await fireViaMcp(aliceMcp, bundleId, {
        hook: "notify",
        params: { message: "x", url: "http://evil.example" },
      });
      expect(result.ok).toBe(false);
      expect(result.error.message).toContain('unknown hook parameter "url"');
    });

    it("rejects missing required parameters", async () => {
      const result = await fireViaMcp(aliceMcp, bundleId, { hook: "notify", params: { channel: "ops" } });
      expect(result.ok).toBe(false);
      expect(result.error.message).toContain('required hook parameter "message"');
    });

    it("returns non-2xx upstream results raw — the agent decides what to do", async () => {
      await alice.post(`/v1/bundles/${bundleId}/hooks`, {
        name: "failing",
        transport: { url: `http://127.0.0.1:${targetPort}/fail`, method: "GET" },
      });
      const result = await fireViaMcp(aliceMcp, bundleId, { hook: "failing" });
      expect(result.ok).toBe(true); // the call succeeded; the upstream status is data
      expect(result.result.status).toBe(502);
      expect(result.result.body).toBe("upstream exploded");
    });

    it("times out per config with no automatic retries", async () => {
      await alice.post(`/v1/bundles/${bundleId}/hooks`, {
        name: "slow",
        transport: { url: `http://127.0.0.1:${targetPort}/slow`, method: "GET" },
      });
      received.length = 0;
      const result = await fireViaMcp(aliceMcp, bundleId, { hook: "slow" });
      expect(result.ok).toBe(false);
      expect(result.error.message).toMatch(/timed out after 700ms/);
      expect(received).toHaveLength(1); // exactly one attempt — no retries
    });

    it("re-checks the SSRF guard at fire time", async () => {
      // Plant a hook whose stored destination is private, bypassing the
      // creation check — as if DNS changed after authoring.
      const { hooks } = app.db.tables;
      await app.db.client.insert(hooks).values({
        id: "planted-hook",
        bundleId,
        name: "rebound",
        description: "",
        params: "[]",
        transportEncrypted: encryptSecret(
          JSON.stringify({ url: "http://192.168.0.1/internal", method: "GET" }),
          app.config.masterKey,
        ),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const result = await fireViaMcp(aliceMcp, bundleId, { hook: "rebound" });
      expect(result.ok).toBe(false);
      expect(result.error.message).toMatch(/blocked by the SSRF guard/);
      // The hidden destination (host/IP) must never reach the firing agent.
      expect(JSON.stringify(result.error)).not.toContain("192.168.0.1");
      expect(JSON.stringify(result.error)).not.toContain("internal");
    });

    it("requires fire_hooks; discovery needs only read access", async () => {
      const { user: viewer } = (await apiClient(app.baseUrl, TEST_SYSADMIN_KEY).post("/v1/users", {
        name: "Viewer",
      }).then((r) => ({ user: r.body })))!;
      await alice.post(`/v1/bundles/${bundleId}/grants`, {
        userId: viewer.user.id,
        capabilities: ["read_items"],
        effect: "allow",
      });
      const viewerRest = apiClient(app.baseUrl, viewer.initialKey.key);
      // Can browse hooks (read access)…
      const listed = await viewerRest.get(`/v1/bundles/${bundleId}/hooks`);
      expect(listed.status).toBe(200);
      expect(listed.body.data.length).toBeGreaterThan(0);
      // …but cannot fire.
      const hookId = listed.body.data[0].id;
      const denied = await viewerRest.post(`/v1/hooks/${hookId}/fire`, { params: { message: "x" } });
      expect(denied.status).toBe(403);
      expect(denied.body.error.details.capability).toBe("fire_hooks");
    });

    it("acceptance: space-level fire_hooks with a bundle-level deny blocks that bundle, not its sibling", async () => {
      await alice.post(`/v1/bundles/${siblingBundleId}/hooks`, {
        name: "sibling-hook",
        transport: { url: `http://127.0.0.1:${targetPort}/sibling`, method: "GET" },
      });
      // Bob: fire_hooks at space level…
      await alice.post(`/v1/spaces/${spaceId}/grants`, {
        userId: bobId,
        capabilities: ["fire_hooks"],
        effect: "allow",
      });
      // …revoked on the notifier bundle specifically.
      const denyRow = await alice.post(`/v1/bundles/${bundleId}/grants`, {
        userId: bobId,
        capabilities: ["fire_hooks"],
        effect: "deny",
      });
      const bobMcp = await connectMcp(app.baseUrl, bobKey);
      const blocked = await fireViaMcp(bobMcp, bundleId, { hook: "notify", params: { message: "x" } });
      expect(blocked.ok).toBe(false);
      expect(blocked.error.code).toBe("forbidden");
      // The deciding row is identifiable for the deny…
      expect(blocked.error.details.decidedBy).toEqual({
        grantId: denyRow.body.data[0].id,
        level: "bundle",
        effect: "deny",
      });
      // …and the sibling fires fine under the space baseline.
      const allowed = await fireViaMcp(bobMcp, siblingBundleId, { hook: "sibling-hook" });
      expect(allowed.ok).toBe(true);
      expect(allowed.result.status).toBe(200);
      await bobMcp.close();
    });
  });
});
