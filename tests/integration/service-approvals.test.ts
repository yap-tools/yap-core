/**
 * Services written over MCP stay off until a person approves them. On both
 * adapters. Pinned here:
 *
 * - an MCP-created service refuses to run and to be scheduled, and listings
 *   say approved: false; REST-written services run as before;
 * - approval_request opens a one-off page; the page shows the service as the
 *   server has it, destinations first; approving needs a user access key whose
 *   user holds edit_services, never the token alone, an OAuth token or the
 *   sysadmin key; a refused approval leaves the page open;
 * - the page takes one decision, expires, and approves only the service it
 *   showed: a change in between fails it;
 * - an MCP change to params, pins, actions or settings revokes approval and
 *   stops a schedule's runs; a rename, a no-op write, or a secret entered
 *   through the form does not; a REST config write approves;
 * - the secret form needs the same login, so the agent holding its token
 *   cannot enter a secret itself, and it shows where its secrets are sent,
 *   with pins filled in.
 */
import { createServer, type Server } from "node:http";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signToken } from "../../src/crypto.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, getFreePort, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp, type McpTestClient } from "../helpers/mcp.js";
import { connectApp } from "../helpers/oauth.js";

const HEADER_SECRET = "Bearer approval-SECRET-55c1";

describeEachAdapter("service approvals", (adapter) => {
  let app: TestApp;
  let alice: ApiClient;
  let aliceKey: string;
  let aliceId: string;
  let aliceMcp: McpTestClient;
  let bobKey: string;
  let bobMcp: McpTestClient;
  let oauthMcp: McpTestClient;
  let oauthToken: string;
  let spaceId: string;
  let bundleId: string;
  let target: Server;
  let targetPort: number;
  const hits: Array<{ url?: string; auth?: string }> = [];
  const anon = () => apiClient(app.baseUrl);

  const one = async (client: McpTestClient, tool: string, params: Record<string, unknown>) =>
    (await client.call("call", { space_id: spaceId, calls: [{ bundle_id: bundleId, tool, params }] })).results[0];

  const settings = (path = "notify") => ({
    url: `http://127.0.0.1:${targetPort}/${path}/{{slot}}`,
    method: "POST",
    headers: {},
    body_json: { text: "{{text}}" },
  });
  const params = [
    { name: "slot", required: true },
    { name: "text", required: true },
  ];

  const create = async (name: string, extra: Record<string, unknown> = {}) => {
    const res = await one(aliceMcp, "create_service", { name, params, pins: { slot: "alerts" }, settings: settings(), ...extra });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    return res.result;
  };
  const run = (name: string, client = aliceMcp) => one(client, "run_service", { id: name, params: { text: "hi" }, wait_ms: 5000 });
  const openPage = async (name: string) => {
    const req = await one(aliceMcp, "approval_request", { id: name });
    expect(req.ok, JSON.stringify(req)).toBe(true);
    const { request_id, token } = req._meta.data as { request_id: string; token: string };
    const view = await anon().post(`/v1/service-approvals/${request_id}/view`, { token });
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    return { req, request_id, token, view: view.body.view, fingerprint: view.body.fingerprint as string };
  };
  const decide = (page: { request_id: string; token: string; fingerprint?: string }, body: Record<string, unknown>) =>
    anon().post(`/v1/service-approvals/${page.request_id}/decide`, {
      token: page.token,
      fingerprint: page.fingerprint,
      ...body,
    });
  const approve = async (name: string) => {
    const page = await openPage(name);
    const res = await decide(page, { decision: "approve", access_key: aliceKey });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };

  beforeAll(async () => {
    targetPort = await getFreePort();
    target = createServer((req, res) => {
      hits.push({ url: req.url, auth: req.headers.authorization });
      req.resume();
      req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
    });
    await new Promise<void>((resolve) => target.listen(targetPort, "127.0.0.1", resolve));

    app = await bootTestApp({ YAP_EGRESS_ALLOW_HOSTS: "127.0.0.1" }, await adapter.makeDb());
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    aliceKey = a.body.initialKey.key;
    aliceId = a.body.user.id;
    alice = apiClient(app.baseUrl, aliceKey);
    aliceMcp = await connectMcp(app.baseUrl, aliceKey);
    const b = await sysadmin.post("/v1/users", { name: "Bob" });
    bobKey = b.body.initialKey.key;
    bobMcp = await connectMcp(app.baseUrl, bobKey);
    spaceId = (await alice.post("/v1/spaces", { name: "Approvals" })).body.id;
    bundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "ops" })).body.id;
    // Bob can run services, not author or approve them.
    await alice.post(`/v1/bundles/${bundleId}/grants`, {
      userId: b.body.user.id,
      capabilities: ["read_items", "run_services"],
      effect: "allow",
    });
    // Alice's agent, connected over OAuth: it holds a token, never her key.
    oauthToken = (await connectApp(app.baseUrl, aliceKey, "role:admin")).access_token;
    oauthMcp = await connectMcp(app.baseUrl, oauthToken);
  });

  afterAll(async () => {
    await aliceMcp.close();
    await bobMcp.close();
    await oauthMcp.close();
    await app.stop();
    await new Promise<void>((resolve, reject) => target.close((e) => (e ? reject(e) : resolve())));
  });

  describe("a service written over MCP", () => {
    it("is created off, says so, and refuses to run or be scheduled", async () => {
      const created = await create("notify");
      expect(created).toMatchObject({ approved: false, approvedAt: null, approvedBy: null });
      expect((await one(aliceMcp, "get_service", { id: "notify" })).result.approved).toBe(false);
      expect((await one(bobMcp, "get_service", { id: "notify" })).result).toMatchObject({ approved: false });
      const listed = (await alice.get(`/v1/bundles/${bundleId}/services`)).body.data;
      expect(listed.find((s: any) => s.name === "notify")).toMatchObject({ approved: false });

      hits.length = 0;
      const refused = await run("notify");
      expect(refused.ok).toBe(false);
      expect(refused.error.code).toBe("forbidden");
      expect(refused.error.message).toContain("waiting for approval");
      expect(refused.error.message).toContain("approval_request");
      const rest = await alice.post(`/v1/services/${created.id}/run`, { params: { text: "hi" } });
      expect(rest.status).toBe(403);
      const schedule = await one(aliceMcp, "create_schedule", { service: "notify", params: { text: "hi" }, cron: "0 9 * * *" });
      expect(schedule.ok).toBe(false);
      expect(schedule.error.message).toContain("waiting for approval");
      expect(hits).toEqual([]);
    });

    it("a REST-written service is approved by its write and runs", async () => {
      const res = await alice.post(`/v1/bundles/${bundleId}/services`, {
        name: "rest-notify",
        params,
        pins: { slot: "rest" },
        config: settings("rest"),
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ approved: true });
      expect(typeof res.body.approvedAt).toBe("string");
      expect((await run("rest-notify")).result.status).toBe("succeeded");
    });
  });

  describe("the approve page", () => {
    it("shows the service as the server has it, destination first, pins filled in", async () => {
      const page = await openPage("notify");
      expect(page.req.result).toMatchObject({ service: { name: "notify" }, expires_in: 600 });
      expect(page.req.result.origin_url).toContain("/w/service-approve?token=");
      // The widget is handed nothing it could be fooled into showing.
      expect(Object.keys(page.req._meta.data).sort()).toEqual(["request_id", "token"]);
      expect(page.view).toMatchObject({
        service: { name: "notify" },
        driver: { name: "http", egress: true, writes: [] },
        approved: false,
        destinations: [
          { label: "URL", value: `http://127.0.0.1:${targetPort}/notify/alerts`, chosenPerRun: [] },
        ],
        actions: [{ name: "fire", params: [{ name: "text", required: true }] }],
        pins: { slot: "alerts" },
        settings: settings(),
        secrets_set: [],
      });
      const html = await (await fetch(page.req.result.origin_url)).text();
      expect(html).toContain("window.__YAP_BASE__");
      expect(html).toContain(`/notify/alerts`);
    });

    it("refuses to approve without a valid user key, leaving the page open", async () => {
      const page = await openPage("notify");
      // The token alone is not a login.
      expect((await decide(page, { decision: "approve" })).status).toBe(401);
      expect((await decide(page, { decision: "approve", access_key: "not-a-key" })).status).toBe(401);
      const sys = await decide(page, { decision: "approve", access_key: TEST_SYSADMIN_KEY });
      expect(sys.status).toBe(401);
      expect(sys.body.error.message).toContain("sysadmin");
      // An OAuth token, the agent's own credential, is never a login here.
      const viaToken = await decide(page, { decision: "approve", access_key: oauthToken });
      expect(viaToken.status).toBe(401);
      expect(viaToken.body.error.message).toContain("token");
      // Bob may run services but not edit them.
      const bob = await decide(page, { decision: "approve", access_key: bobKey });
      expect(bob.status).toBe(403);
      expect(bob.body.error.message).toContain("edit_services");
      // A bad or expired page token never reaches the login.
      expect((await decide({ ...page, token: `${page.token}x` }, { decision: "approve", access_key: aliceKey })).status).toBe(401);
      const expired = signToken({ scope: "service-approve", requestId: page.request_id }, app.config.masterKey, -10);
      expect((await decide({ ...page, token: expired }, { decision: "approve", access_key: aliceKey })).status).toBe(401);
      // Still off after all of that.
      expect((await one(aliceMcp, "get_service", { id: "notify" })).result.approved).toBe(false);

      // The same page still works for the right person.
      const ok = await decide(page, { decision: "approve", access_key: aliceKey });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body).toMatchObject({ decision: "approved", service: { name: "notify" } });
      // One decision per page.
      expect((await decide(page, { decision: "approve", access_key: aliceKey })).status).toBe(409);
    });

    it("an approved service runs, and records who approved it", async () => {
      const view = (await one(aliceMcp, "get_service", { id: "notify" })).result;
      expect(view).toMatchObject({ approved: true });
      expect(typeof view.approvedAt).toBe("string");
      expect(view.approvedBy).toBe(aliceId);
      hits.length = 0;
      const ran = await run("notify");
      expect(ran.result.status, JSON.stringify(ran.result)).toBe("succeeded");
      expect(hits.map((h) => h.url)).toEqual(["/notify/alerts"]);
      // Approved already: there is nothing to ask for.
      const again = await one(aliceMcp, "approval_request", { id: "notify" });
      expect(again.ok).toBe(false);
      expect(again.error.message).toContain("approved already");
    });

    it("an agent connected over OAuth can write a service and ask, but not approve it", async () => {
      const res = await one(oauthMcp, "create_service", { name: "oauth-written", params, pins: { slot: "o" }, settings: settings() });
      expect(res.ok, JSON.stringify(res)).toBe(true);
      expect(res.result.approved).toBe(false);
      const req = await one(oauthMcp, "approval_request", { id: "oauth-written" });
      expect(req.ok).toBe(true);
      const { request_id, token } = req._meta.data;
      const view = await anon().post(`/v1/service-approvals/${request_id}/view`, { token });
      const attempt = await anon().post(`/v1/service-approvals/${request_id}/decide`, {
        token,
        decision: "approve",
        access_key: oauthToken,
        fingerprint: view.body.fingerprint,
      });
      expect(attempt.status).toBe(401);
      expect((await run("oauth-written", oauthMcp)).ok).toBe(false);
    });

    it("an agent holding a scoped admin key can write a service and ask, but not approve it or enter its secrets", async () => {
      // Scoped admin masks no capability, but a scoped key is never the person.
      const minted = await alice.post("/v1/keys", { name: "agent", scope: { role: "admin" } });
      expect(minted.status, JSON.stringify(minted.body)).toBe(201);
      const scopedKey = minted.body.key as string;
      const agent = await connectMcp(app.baseUrl, scopedKey);
      try {
        const res = await one(agent, "create_service", { name: "scoped-written", params, pins: { slot: "k" }, settings: settings() });
        expect(res.ok, JSON.stringify(res)).toBe(true);
        expect(res.result.approved).toBe(false);

        const secret = await one(agent, "secret_request", { id: "scoped-written", paths: ["headers.authorization"] });
        expect(secret.ok, JSON.stringify(secret)).toBe(true);
        const submit = await anon().post(`/v1/secret-requests/${secret.result.request_id}/submit`, {
          token: secret._meta.data.token,
          values: { "headers.authorization": HEADER_SECRET },
          access_key: scopedKey,
        });
        expect(submit.status).toBe(401);
        expect(submit.body.error.message).toBe("This key is limited. Log in with a full key.");

        const req = await one(agent, "approval_request", { id: "scoped-written" });
        expect(req.ok, JSON.stringify(req)).toBe(true);
        const { request_id, token } = req._meta.data;
        const view = await anon().post(`/v1/service-approvals/${request_id}/view`, { token });
        const attempt = await anon().post(`/v1/service-approvals/${request_id}/decide`, {
          token,
          decision: "approve",
          access_key: scopedKey,
          fingerprint: view.body.fingerprint,
        });
        expect(attempt.status).toBe(401);
        expect(attempt.body.error.message).toBe("This key is limited. Log in with a full key.");
        expect((await run("scoped-written", agent)).ok).toBe(false);
        // The page stays open for the person, whose full key approves it.
        expect((await decide({ request_id, token, fingerprint: view.body.fingerprint }, { decision: "approve", access_key: aliceKey })).status).toBe(200);
      } finally {
        await agent.close();
      }
    });

    it("a scoped key's REST write waits for a person, where a full key's write is its approval", async () => {
      const scoped = apiClient(app.baseUrl, (await alice.post("/v1/keys", { name: "rest-agent", scope: { role: "member" } })).body.key);
      const config = { url: `http://127.0.0.1:${targetPort}/notify/{{slot}}`, method: "POST", headers: {}, body_json: { text: "{{text}}" } };
      const created = await scoped.post(`/v1/bundles/${bundleId}/services`, { name: "rest-scoped", params, pins: { slot: "r" }, config });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.approved).toBe(false);
      expect((await run("rest-scoped")).ok).toBe(false);

      await approve("rest-scoped");
      const rewritten = await scoped.patch(`/v1/services/${created.body.id}`, { config });
      expect(rewritten.status, JSON.stringify(rewritten.body)).toBe(200);
      expect(rewritten.body.approved).toBe(false);

      // Without a config, a change to what it does waits too; a rename does not.
      await approve("rest-scoped");
      expect((await scoped.patch(`/v1/services/${created.body.id}`, { description: "renamed" })).body.approved).toBe(true);
      for (const change of [{ pins: { slot: "elsewhere" } }, { params: [...params, { name: "extra" }] }]) {
        expect((await alice.patch(`/v1/services/${created.body.id}`, { config })).body.approved).toBe(true);
        const res = await scoped.patch(`/v1/services/${created.body.id}`, change);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.approved, JSON.stringify(change)).toBe(false);
      }

      // The same write with Alice's full key is her approval.
      const byAlice = await alice.patch(`/v1/services/${created.body.id}`, { config });
      expect(byAlice.body.approved).toBe(true);
      expect((await run("rest-scoped")).ok).toBe(true);
    });

    it("reject leaves the service off and uses the page up", async () => {
      await create("rejected");
      const page = await openPage("rejected");
      const res = await decide(page, { decision: "reject" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ decision: "rejected", service: { name: "rejected" } });
      expect((await decide(page, { decision: "approve", access_key: aliceKey })).status).toBe(409);
      expect((await one(aliceMcp, "get_service", { id: "rejected" })).result.approved).toBe(false);
      expect((await run("rejected")).ok).toBe(false);
    });

    it("expires, and an expired page is refused even with a valid token", async () => {
      await create("expiring");
      const page = await openPage("expiring");
      const { serviceApprovals } = app.db.tables;
      await app.db.client
        .update(serviceApprovals)
        .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(serviceApprovals.id, page.request_id));
      expect((await decide(page, { decision: "approve", access_key: aliceKey })).status).toBe(401);
      expect((await anon().post(`/v1/service-approvals/${page.request_id}/view`, { token: page.token })).status).toBe(401);
      expect((await fetch(page.req.result.origin_url)).status).toBe(401);
    });

    it("approves only what it showed: a change in between fails it", async () => {
      await create("moving");
      const page = await openPage("moving");
      // An MCP change to where data goes closes the page outright...
      const moved = await one(aliceMcp, "update_service", { id: "moving", pins: { slot: "elsewhere" } });
      expect(moved.ok).toBe(true);
      expect((await decide(page, { decision: "approve", access_key: aliceKey })).status).toBe(401);
      // ...and a page whose fingerprint no longer matches is refused and stays open.
      const second = await openPage("moving");
      const stale = await decide({ ...second, fingerprint: "0".repeat(64) }, { decision: "approve", access_key: aliceKey });
      expect(stale.status).toBe(409);
      expect(stale.body.error.message).toContain("changed");
      expect((await decide(second, { decision: "approve", access_key: aliceKey })).status).toBe(200);
      expect((await one(aliceMcp, "get_service", { id: "moving" })).result.approved).toBe(true);
    });
  });

  describe("what revokes approval", () => {
    it("an MCP change to pins, params, actions or settings turns the service off again", async () => {
      await create("revoked");
      for (const change of [
        { pins: { slot: "other" } },
        { params: [...params, { name: "extra" }] },
        { actions: ["fire"] },
        { settings: { ...settings(), method: "PUT" } },
      ]) {
        await approve("revoked");
        expect((await run("revoked")).result.status).toBe("succeeded");
        const upd = await one(aliceMcp, "update_service", { id: "revoked", ...change });
        expect(upd.ok, JSON.stringify(upd)).toBe(true);
        expect(upd.result.approved, JSON.stringify(change)).toBe(false);
        expect((await run("revoked")).ok, JSON.stringify(change)).toBe(false);
      }
    });

    it("a rename, or sending back what is stored, keeps it approved", async () => {
      await create("kept");
      await approve("kept");
      const current = (await one(aliceMcp, "get_service", { id: "kept" })).result;
      const renamed = await one(aliceMcp, "update_service", { id: "kept", name: "kept2", description: "renamed" });
      expect(renamed.result.approved).toBe(true);
      const same = await one(aliceMcp, "update_service", {
        id: "kept2",
        params: current.params,
        pins: current.pins,
        settings: current.settings,
      });
      expect(same.ok).toBe(true);
      expect(same.result.approved).toBe(true);
      expect((await run("kept2")).result.status).toBe("succeeded");
    });

    it("a secret entered through the form keeps it approved", async () => {
      await create("secretive");
      await approve("secretive");
      const req = await one(aliceMcp, "secret_request", { id: "secretive", paths: ["headers.authorization"] });
      const saved = await anon().post(`/v1/secret-requests/${req.result.request_id}/submit`, {
        token: req._meta.data.token,
        values: { "headers.authorization": HEADER_SECRET },
        access_key: aliceKey,
      });
      expect(saved.status).toBe(200);
      const view = (await one(aliceMcp, "get_service", { id: "secretive" })).result;
      expect(view).toMatchObject({ approved: true, secretsSet: ["headers.authorization"] });
      hits.length = 0;
      expect((await run("secretive")).result.status).toBe("succeeded");
      expect(hits.map((h) => h.auth)).toEqual([HEADER_SECRET]);
    });

    it("a schedule on a revoked service records why it did not run", async () => {
      await create("scheduled");
      await approve("scheduled");
      const created = await one(aliceMcp, "create_schedule", {
        service: "scheduled",
        params: { text: "hi" },
        cron: "0 9 * * *",
      });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      expect((await one(aliceMcp, "update_service", { id: "scheduled", pins: { slot: "moved" } })).ok).toBe(true);
      const outcome = await app.server.scheduler!.fire(created.result.id);
      expect(outcome).toMatchObject({ kind: "error" });
      const listed = (await one(aliceMcp, "list_schedules", {})).result;
      const row = (listed.data ?? listed).find((s: any) => s.id === created.result.id);
      expect(row.lastError).toContain("waiting for approval");
      expect(row.enabled).toBe(true);
    });

    it("a REST write of the config approves a service an agent wrote", async () => {
      const svc = await create("rest-fixed");
      const res = await alice.patch(`/v1/services/${svc.id}`, { config: settings() });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ approved: true });
      // A REST rename alone does not.
      const other = await create("rest-renamed");
      expect((await alice.patch(`/v1/services/${other.id}`, { name: "rest-renamed2" })).body.approved).toBe(false);
    });
  });

  describe("the secret form needs a login", () => {
    it("refuses the token alone, the sysadmin key, an OAuth token and a user without edit_services, leaving the form open", async () => {
      await create("keyed");
      const req = await one(aliceMcp, "secret_request", { id: "keyed", paths: ["headers.authorization"] });
      const url = `/v1/secret-requests/${req.result.request_id}/submit`;
      const body = (extra: Record<string, unknown>) => ({
        token: req._meta.data.token,
        values: { "headers.authorization": HEADER_SECRET },
        ...extra,
      });
      // What an agent holding the form's token could do on its own: nothing.
      expect((await anon().post(url, body({}))).status).toBe(401);
      expect((await anon().post(url, body({ access_key: TEST_SYSADMIN_KEY }))).status).toBe(401);
      const viaToken = await anon().post(url, body({ access_key: oauthToken }));
      expect(viaToken.status).toBe(401);
      expect(viaToken.body.error.message).toContain("token");
      const bob = await anon().post(url, body({ access_key: bobKey }));
      expect(bob.status).toBe(403);
      expect(bob.body.error.message).toContain("edit_services");
      expect((await one(aliceMcp, "get_service", { id: "keyed" })).result.secretsSet).toEqual([]);
      // The same form takes the person's login, and records who it was.
      expect((await anon().post(url, body({ access_key: aliceKey }))).status).toBe(200);
      const { secretRequests } = app.db.tables;
      const [row] = await app.db.client.select().from(secretRequests).where(eq(secretRequests.id, req.result.request_id));
      expect(row!.submittedBy).toBe(aliceId);
    });
  });

  describe("the secret form shows where its secrets go", () => {
    it("names the url the header is sent to, with pins filled in", async () => {
      await create("dest");
      const req = await one(aliceMcp, "secret_request", { id: "dest", paths: ["headers.authorization"] });
      expect(req._meta.data.destinations).toEqual([
        { label: "URL", value: `http://127.0.0.1:${targetPort}/notify/alerts`, chosenPerRun: [] },
      ]);
      // The widget in a host's frame reads the form from the server, not from its data.
      const view = await anon().post(`/v1/secret-requests/${req.result.request_id}/view`, { token: req._meta.data.token });
      expect(view.status).toBe(200);
      expect(view.body).toMatchObject({ service_name: "dest", destinations: req._meta.data.destinations });
      expect((await anon().post(`/v1/secret-requests/${req.result.request_id}/view`, { token: "x" })).status).toBe(401);
    });

    it("names what a run fills in when no pin does", async () => {
      await create("dest-open", { pins: {} });
      const req = await one(aliceMcp, "secret_request", { id: "dest-open", paths: ["headers.authorization"] });
      expect(req._meta.data.destinations).toEqual([
        { label: "URL", value: `http://127.0.0.1:${targetPort}/notify/{{slot}}`, chosenPerRun: ["slot"] },
      ]);
    });
  });
});
