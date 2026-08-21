/**
 * The legacy `/hooks` mounts, kept byte-compatible on top of services and runs.
 *
 * A hook was a service with the `http` driver, and that is exactly what the
 * legacy routes now author: `transport` becomes the service config, the driver
 * is forced to `http`, and every response keeps the old shape — `{id, name,
 * description, params}` for authoring, `{status, body}` for a fire, and the
 * old error mapping (a blocked destination is a 403, everything else a 500).
 * The dual mount is the point: the same record is reachable, and identical,
 * through both surfaces.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DRIVER_API, type DriverDefinition, type RunContext } from "../../src/core/drivers/types.js";
import { encryptSecret } from "../../src/crypto.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, getFreePort, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp, type McpTestClient } from "../helpers/mcp.js";

/**
 * A live, installed, perfectly usable non-http driver. The legacy mounts must
 * still refuse to speak for a service on it: those routes are the *hook*
 * contract, and a hook was an http service.
 */
const echoDriver: DriverDefinition = {
  name: "echo",
  api: DRIVER_API,
  description: "In-test driver that echoes its parameters.",
  egress: false,
  validateConfig(): void {},
  actions: {
    say: { description: "Echoes.", params: [{ name: "message" }], timeoutMs: 5_000 },
  },
  async run(ctx: RunContext): Promise<unknown> {
    return { echoed: ctx.params };
  },
};

describeEachAdapter("legacy hook routes", (adapter) => {
  let app: TestApp;
  let alice: ApiClient;
  let aliceMcp: McpTestClient;
  let spaceId: string;
  let bundleId: string;

  let target: Server;
  let targetPort: number;
  const received: { method: string; url: string; body: string }[] = [];

  const fireViaMcp = async (params: Record<string, unknown>) => {
    const res = await aliceMcp.call("call", {
      space_id: spaceId,
      calls: [{ bundle_id: bundleId, tool: "fire_hook", params }],
    });
    return res.results[0];
  };

  beforeAll(async () => {
    targetPort = await getFreePort();
    target = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ method: req.method!, url: req.url!, body });
        if (req.url?.includes("slow")) {
          setTimeout(() => res.writeHead(200).end("slow response"), 2000);
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
    app.server.registry.register(echoDriver);
    spaceId = (await alice.post("/v1/spaces", { name: "Legacy" })).body.id;
    bundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "hooked" })).body.id;
  });

  afterAll(async () => {
    await aliceMcp.close();
    await app.stop();
    await new Promise<void>((resolve, reject) => target.close((e) => (e ? reject(e) : resolve())));
  });

  it("authors through transport and answers in the old shape", async () => {
    const created = await alice.post(`/v1/bundles/${bundleId}/hooks`, {
      name: "notify",
      description: "Send a notification",
      params: [
        { name: "message", description: "What to say", required: true },
        { name: "channel", description: "Where to say it" },
      ],
      transport: {
        url: `http://127.0.0.1:${targetPort}/notify?channel={{channel}}`,
        method: "POST",
        headers: { authorization: "Bearer super-secret-token" },
        body_json: { text: "{{message}}" },
      },
    });
    expect(created.status).toBe(201);
    // Byte-for-byte: exactly the four legacy fields, nothing about drivers or
    // actions, and never the transport.
    expect(Object.keys(created.body).sort()).toEqual(["description", "id", "name", "params"]);
    expect(created.body.name).toBe("notify");
    expect(created.body.description).toBe("Send a notification");
    expect(created.body.params).toEqual([
      { name: "message", description: "What to say", required: true },
      { name: "channel", description: "Where to say it" },
    ]);
    expect(JSON.stringify(created.body)).not.toContain("super-secret-token");

    const listed = await alice.get(`/v1/bundles/${bundleId}/hooks`);
    expect(listed.status).toBe(200);
    expect(Object.keys(listed.body)).toEqual(["data"]);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0]).toEqual(created.body);
  });

  it("is the same record the services surface sees", async () => {
    const hook = (await alice.get(`/v1/bundles/${bundleId}/hooks`)).body.data[0];
    const service = (await alice.get(`/v1/bundles/${bundleId}/services`)).body.data.find(
      (s: any) => s.id === hook.id,
    );
    expect(service.driver).toBe("http"); // the legacy mount forces it
    expect(service.name).toBe(hook.name);
    expect(service.actions[0].params).toEqual(hook.params);

    // …and a service authored on the new surface shows up in the legacy list.
    const authored = await alice.post(`/v1/bundles/${bundleId}/services`, {
      name: "new-surface",
      params: [{ name: "message" }],
      config: { url: `http://127.0.0.1:${targetPort}/new`, method: "GET" },
    });
    expect(authored.status).toBe(201);
    const relisted = (await alice.get(`/v1/bundles/${bundleId}/hooks`)).body.data;
    const legacyView = relisted.find((h: any) => h.name === "new-surface");
    expect(Object.keys(legacyView).sort()).toEqual(["description", "id", "name", "params"]);
    expect(legacyView.params).toEqual([{ name: "message" }]);
  });

  it("fires with the old {status, body} shape", async () => {
    received.length = 0;
    const hookId = (await alice.get(`/v1/bundles/${bundleId}/hooks`)).body.data.find(
      (h: any) => h.name === "notify",
    ).id;
    const fired = await alice.post(`/v1/hooks/${hookId}/fire`, {
      params: { message: "deploy finished", channel: "ops" },
    });
    expect(fired.status).toBe(200);
    expect(Object.keys(fired.body).sort()).toEqual(["body", "status"]);
    expect(fired.body.status).toBe(200);
    expect(JSON.parse(fired.body.body)).toEqual({ received: true });

    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe("/notify?channel=ops");
    expect(JSON.parse(received[0]!.body)).toEqual({ text: "deploy finished" });

    // An empty body is still tolerated — it reaches parameter validation as an
    // empty param set, and the old "required parameter" rejection is unchanged.
    const empty = await alice.post(`/v1/hooks/${hookId}/fire`);
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toMatch(/required.*"message"/);
  });

  it("keeps the old error mapping: a blocked destination is a 403, a timeout a 500", async () => {
    // Planted directly, as if DNS had changed since authoring.
    const { services } = app.db.tables;
    await app.db.client.insert(services).values({
      id: "planted-legacy-hook",
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
    const blocked = await alice.post(`/v1/hooks/planted-legacy-hook/fire`, {});
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("forbidden");
    expect(blocked.body.error.message).toMatch(/blocked by the SSRF guard/);
    expect(JSON.stringify(blocked.body)).not.toContain("192.168.0.1");

    const slow = await alice.post(`/v1/bundles/${bundleId}/hooks`, {
      name: "slow",
      transport: { url: `http://127.0.0.1:${targetPort}/slow`, method: "GET" },
    });
    const timedOut = await alice.post(`/v1/hooks/${slow.body.id}/fire`, {});
    expect(timedOut.status).toBe(500);
    expect(timedOut.body.error.code).toBe("internal");
    expect(timedOut.body.error.message).toMatch(/timed out after 700ms/);
  });

  it("patches and deletes through the legacy mounts", async () => {
    const created = await alice.post(`/v1/bundles/${bundleId}/hooks`, {
      name: "editable",
      transport: { url: `http://127.0.0.1:${targetPort}/editable`, method: "GET" },
    });
    expect(created.status).toBe(201);

    const patched = await alice.patch(`/v1/hooks/${created.body.id}`, {
      name: "edited",
      description: "now described",
      params: [{ name: "message" }],
      transport: { url: `http://127.0.0.1:${targetPort}/edited?m={{message}}`, method: "GET" },
    });
    expect(patched.status).toBe(200);
    expect(Object.keys(patched.body).sort()).toEqual(["description", "id", "name", "params"]);
    expect(patched.body).toMatchObject({
      id: created.body.id,
      name: "edited",
      description: "now described",
      params: [{ name: "message" }],
    });

    received.length = 0;
    const fired = await alice.post(`/v1/hooks/${created.body.id}/fire`, { params: { message: "hi" } });
    expect(fired.status).toBe(200);
    expect(received[0]!.url).toBe("/edited?m=hi"); // the patched transport is live

    const deleted = await alice.delete(`/v1/hooks/${created.body.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });
    expect((await alice.post(`/v1/hooks/${created.body.id}/fire`, {})).status).toBe(404);
  });

  it("the fire_hook MCP alias still returns the legacy shape", async () => {
    received.length = 0;
    const ok = await fireViaMcp({ id: "notify", params: { message: "over MCP", channel: "ops" } });
    expect(ok.ok).toBe(true);
    expect(Object.keys(ok.result).sort()).toEqual(["body", "status"]);
    expect(ok.result.status).toBe(200);
    expect(JSON.parse(ok.result.body)).toEqual({ received: true });
    expect(received).toHaveLength(1);

    // Errors keep arriving as per-call failures, not as results.
    const unknownParam = await fireViaMcp({ id: "notify", params: { message: "x", url: "http://evil.example" } });
    expect(unknownParam.ok).toBe(false);
    expect(unknownParam.error.message).toContain('unknown parameter "url"');

    const blocked = await fireViaMcp({ id: "rebound" });
    expect(blocked.ok).toBe(false);
    expect(blocked.error.code).toBe("forbidden");
    expect(blocked.error.message).toMatch(/blocked by the SSRF guard/);
    expect(JSON.stringify(blocked.error)).not.toContain("192.168.0.1");

    // The flattening mistake still gets a shape-explaining error.
    const noId = await fireViaMcp({ params: { message: "x" } });
    expect(noId.ok).toBe(false);
    expect(noId.error.code).toBe("invalid_request");
  });

  it("stays http-only: a service on another driver is not a hook", async () => {
    const echo = await alice.post(`/v1/bundles/${bundleId}/services`, {
      name: "echoer",
      driver: "echo",
      params: [{ name: "message" }],
      config: {},
    });
    expect(echo.status).toBe(201);
    const echoId = echo.body.id;

    // The legacy list never showed it, and none of the legacy mounts speak for
    // it either — the hook shape has nowhere to put an echo driver's result.
    expect((await alice.get(`/v1/bundles/${bundleId}/hooks`)).body.data.map((h: any) => h.id)).not.toContain(echoId);

    for (const res of [
      await alice.post(`/v1/hooks/${echoId}/fire`, { params: { message: "hi" } }),
      await alice.patch(`/v1/hooks/${echoId}`, { description: "reshaped" }),
      await alice.delete(`/v1/hooks/${echoId}`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
      expect(res.body.error.message).toMatch(/hook/);
    }

    // The alias reports it the same way: a per-call not_found, not a run.
    const viaMcp = await fireViaMcp({ id: "echoer", params: { message: "hi" } });
    expect(viaMcp.ok).toBe(false);
    expect(viaMcp.error.code).toBe("not_found");

    // And the service itself is untouched and perfectly usable on its own
    // surface — the legacy 404s are about the mount, not about the record.
    const still = await alice.get(`/v1/bundles/${bundleId}/services`);
    expect(still.body.data.find((s: any) => s.id === echoId)?.description).toBe("");
    const run = await alice.post(`/v1/services/${echoId}/run`, {
      params: { message: "hi" },
      wait_ms: 5000,
    });
    expect(run.body.status).toBe("succeeded");
    expect(run.body.result).toEqual({ echoed: { message: "hi" } });
  });

  it("keeps a rejection raised at fire time a 400 on both fire surfaces", async () => {
    // The driver refuses a CRLF in a substituted header (it would split the
    // header and inject another). That verdict is raised *inside* the run, so
    // it reaches these surfaces as a failed run rather than as a throw — and
    // must still arrive as the caller's mistake, not as a server fault.
    const created = await alice.post(`/v1/bundles/${bundleId}/hooks`, {
      name: "headered",
      params: [{ name: "message", required: true }],
      transport: {
        url: `http://127.0.0.1:${targetPort}/headered`,
        method: "GET",
        headers: { "x-note": "{{message}}" },
      },
    });
    expect(created.status).toBe(201);

    received.length = 0;
    const crlf = { message: "fine\r\nx-injected: yes" };
    const fired = await alice.post(`/v1/hooks/${created.body.id}/fire`, { params: crlf });
    expect(fired.status).toBe(400);
    expect(fired.body.error.code).toBe("invalid_request");
    expect(fired.body.error.message).toMatch(/must not contain a line break/);
    expect(received).toHaveLength(0); // rejected before anything left the process

    const viaMcp = await fireViaMcp({ id: "headered", params: crlf });
    expect(viaMcp.ok).toBe(false);
    expect(viaMcp.error.code).toBe("invalid_request");
    expect(viaMcp.error.message).toMatch(/must not contain a line break/);

    // …and the code the surfaces translate through is on the run record itself,
    // not inferred from the message.
    const runs = (await alice.get(`/v1/bundles/${bundleId}/runs`)).body.data;
    const failed = runs.find((r: any) => r.serviceName === "headered");
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("invalid_request");

    // A timeout is still the server's fault: 500, and `internal` on the row.
    const slowId = (await alice.get(`/v1/bundles/${bundleId}/hooks`)).body.data.find(
      (h: any) => h.name === "slow",
    ).id;
    const timedOut = await alice.post(`/v1/hooks/${slowId}/fire`, {});
    expect(timedOut.status).toBe(500);
    expect(timedOut.body.error.code).toBe("internal");
  });

  it("still exposes hooks to load_bundle in the legacy shape", async () => {
    // Pinned now so Task 8's rewrite of load_bundle cannot quietly drop the
    // key or change its fields: legacy clients read `hooks` and nothing else.
    const loaded = await aliceMcp.call("load_bundle", { bundle_ids: [bundleId] });
    const hooks = loaded.bundles[0].hooks;
    expect(Array.isArray(hooks)).toBe(true);
    expect(hooks.length).toBeGreaterThan(0);
    for (const hook of hooks) {
      expect(Object.keys(hook).sort()).toEqual(["description", "id", "name", "params"]);
    }

    // The same records, under the same ids, as the legacy REST list — which is
    // itself the http-driver subset of the services surface.
    const legacy = (await alice.get(`/v1/bundles/${bundleId}/hooks`)).body.data;
    expect(hooks).toEqual(legacy);
    const serviceIds = (await alice.get(`/v1/bundles/${bundleId}/services`)).body.data
      .filter((s: any) => s.driver === "http")
      .map((s: any) => s.id);
    expect(hooks.map((h: any) => h.id).sort()).toEqual([...serviceIds].sort());
    expect(JSON.stringify(hooks)).not.toContain("super-secret-token");
  });
});
