/**
 * Switching access-key login off, for the whole instance (YAP_KEY_LOGIN=false)
 * and for one user (providerLoginOnly), on both adapters, against a fake
 * login provider. Pinned here:
 *
 * - instance-wide: no page or widget shows a key field or mentions keys; a
 *   posted key gets the provider message; no user key can be made by anyone,
 *   the sysadmin lane included (a new user comes without one); a key on /v1
 *   and on /mcp (Bearer and ?key=) gets 401 with the message; a token from a
 *   provider login works, a key-backed one is refused on use and refresh and
 *   works again once the switch is back on; the sysadmin key still works;
 *   agent-facing text never mentions access keys; startup needs a provider;
 * - per user: that user's key on pages, /v1 and /mcp (an open session on its
 *   next call included), key creation and rotation are refused, other users
 *   are not; setting the flag deletes the user's key-backed grants and leaves
 *   provider grants; clearing it restores the keys but no grant; a claimed
 *   invite and POST /v1/users can set it.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db/index.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, testEnv, type TestApp } from "../helpers/app.js";
import { connectMcp } from "../helpers/mcp.js";
import { connectApp, pkce, postAuthorize, REDIRECT_URI, registerClient, tokenRequest } from "../helpers/oauth.js";
import { followLogin, startFakeProvider, ticketIn, type FakeProvider } from "../helpers/oidc.js";

const KEY_WORDS = /access key|access_key|api key/i;

describe("YAP_KEY_LOGIN", () => {
  const provider = {
    YAP_OIDC_PROVIDERS: "corp",
    YAP_OIDC_CORP_ISSUER: "https://id.example.com",
    YAP_OIDC_CORP_CLIENT_ID: "client",
    YAP_OIDC_CORP_CLIENT_SECRET: "secret",
    YAP_BASE_URL: "https://yap.example.com",
  };
  it("is on unless set to false", () => {
    expect(loadConfig(testEnv()).keyLogin).toBe(true);
    expect(loadConfig(testEnv({ YAP_KEY_LOGIN: "true" })).keyLogin).toBe(true);
    expect(loadConfig(testEnv({ ...provider, YAP_KEY_LOGIN: "false" })).keyLogin).toBe(false);
  });
  it("off without a login provider fails at startup", () => {
    expect(() => loadConfig(testEnv({ YAP_KEY_LOGIN: "false" }))).toThrow(ConfigError);
    expect(() => loadConfig(testEnv({ YAP_KEY_LOGIN: "false" }))).toThrow(/login provider/);
  });
});

describeEachAdapter("key login switched off", (adapter) => {
  let idp: FakeProvider;
  let db: Db;
  /** Key login on: where keys and key-backed grants are made before the switch. */
  let on: TestApp;
  /** The same database with YAP_KEY_LOGIN=false. */
  let off: TestApp;
  let sysOn: ApiClient;
  let sysOff: ApiClient;
  let ada: { id: string; key: string };
  /** Ada's tokens: one from a provider login (no key behind it), one from a key login. */
  let providerToken: { access_token: string; refresh_token: string; client: string };
  let keyToken: { access_token: string; refresh_token: string; clientId: string };

  const authorizeForm = (clientId: string, challenge: string, extra: Record<string, string> = {}) =>
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "role:admin",
      state: "st4te",
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...extra,
    });

  /** The whole consent flow through the provider, for whoever idp.next logs in. */
  async function providerConnect(base: string) {
    const client = (await registerClient(base)).body.client_id as string;
    const { verifier, challenge } = pkce();
    const start = await fetch(`${base}/oidc/test/start`, { method: "POST", body: authorizeForm(client, challenge), redirect: "manual" });
    const { html } = await followLogin(start);
    const decided = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      body: authorizeForm(client, challenge, { decision: "approve", login_ticket: ticketIn(html) }),
      redirect: "manual",
    });
    expect(decided.status).toBe(302);
    const code = new URL(decided.headers.get("location")!).searchParams.get("code")!;
    const token = await tokenRequest(base, {
      grant_type: "authorization_code",
      client_id: client,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    });
    expect(token.status).toBe(200);
    return { ...token.body, client } as { access_token: string; refresh_token: string; client: string };
  }

  beforeAll(async () => {
    idp = await startFakeProvider();
    db = await adapter.makeDb();
    on = await bootTestApp(idp.env("test", { YAP_EGRESS_ALLOW_HOSTS: "127.0.0.1" }), db);
    sysOn = apiClient(on.baseUrl, TEST_SYSADMIN_KEY);
    const created = await sysOn.post("/v1/users", { name: "Ada", email: "ada@example.com" });
    ada = { id: created.body.user.id, key: created.body.initialKey.key };
    idp.next = { sub: "ada-sub", email: "ada@example.com", email_verified: true, name: "Ada" };
    providerToken = await providerConnect(on.baseUrl);
    // The claim set Ada to provider login only; clear it so her key makes a key-backed grant.
    await sysOn.patch(`/v1/users/${ada.id}`, { providerLoginOnly: false });
    keyToken = await connectApp(on.baseUrl, ada.key, "role:admin");

    off = await bootTestApp(idp.env("test", { YAP_KEY_LOGIN: "false", YAP_EGRESS_ALLOW_HOSTS: "127.0.0.1" }), db);
    sysOff = apiClient(off.baseUrl, TEST_SYSADMIN_KEY);
  });

  afterAll(async () => {
    await off.server.stop();
    await on.stop();
    await idp.close();
  });

  it("the consent screen shows only the provider, and refuses a posted key with its message", async () => {
    const client = (await registerClient(off.baseUrl)).body.client_id as string;
    const { challenge } = pkce();
    const page = await (await fetch(`${off.baseUrl}/oauth/authorize?${authorizeForm(client, challenge)}`)).text();
    expect(page).toContain("Continue with TestID");
    expect(page).not.toMatch(KEY_WORDS);
    // Approving needs the provider login first: the button comes with the page after it.
    expect(page).not.toContain('value="approve"');
    expect(page).toContain('value="deny"');

    const posted = await postAuthorize(off.baseUrl, { clientId: client, key: ada.key, challenge });
    expect(posted.status).toBe(401);
    const refused = await posted.text();
    expect(refused).toContain("Sign in with TestID to connect this app.");
    expect(refused).not.toMatch(KEY_WORDS);
  });

  it("the connected-apps page shows only the provider, and refuses a posted key", async () => {
    const page = await (await fetch(`${off.baseUrl}/oauth/connections`)).text();
    expect(page).toContain("Continue with TestID");
    expect(page).not.toMatch(KEY_WORDS);
    const posted = await fetch(`${off.baseUrl}/oauth/connections`, {
      method: "POST",
      body: new URLSearchParams({ access_key: ada.key }),
    });
    expect(posted.status).toBe(401);
    expect(await posted.text()).toContain("Sign in with TestID to see your connections.");
  });

  it("the approve page and the secret form offer only the provider, refuse a key, and agents are told only of the provider", async () => {
    const mcp = await connectMcp(off.baseUrl, providerToken.access_token);
    try {
      const spaceId = (await mcp.call("space_create", { name: "Ops" })).id as string;
      const call = async (tool: string, params: Record<string, unknown>, bundle?: string) =>
        (await mcp.call("call", { space_id: spaceId, calls: [{ ...(bundle ? { bundle_id: bundle } : {}), tool, params }] }))
          .results[0];
      const bundle = await mcp.call("bundle_create", { space_id: spaceId, name: "ops" });
      const bundleId = (bundle.id ?? bundle.bundle?.id) as string;
      const created = await call(
        "create_service",
        {
          name: "hook",
          params: [{ name: "text", required: true }],
          settings: { url: "http://127.0.0.1:9/x", method: "POST", headers: {}, body_json: { text: "{{text}}" } },
        },
        bundleId,
      );
      expect(created.ok, JSON.stringify(created)).toBe(true);

      const approval = await call("approval_request", { id: "hook" }, bundleId);
      const { request_id, token } = approval._meta.data as { request_id: string; token: string };
      const view = await apiClient(off.baseUrl).post(`/v1/service-approvals/${request_id}/view`, { token });
      expect(view.body.logins).toEqual({ providers: [{ id: "test", label: "TestID" }], keyLogin: false });
      const decided = await apiClient(off.baseUrl).post(`/v1/service-approvals/${request_id}/decide`, {
        token,
        decision: "approve",
        access_key: ada.key,
        fingerprint: view.body.fingerprint,
      });
      expect(decided.status).toBe(401);
      expect(decided.body.error.message).toBe("Sign in with TestID to approve.");
      const page = await (await fetch(approval.result.origin_url)).text();
      expect(page).toContain('"keyLogin":false');

      const secret = await call("secret_request", { id: "hook", paths: ["headers.authorization"] }, bundleId);
      expect(secret.ok, JSON.stringify(secret)).toBe(true);
      const form = secret._meta.data as { request_id: string; token: string };
      const saved = await apiClient(off.baseUrl).post(`/v1/secret-requests/${form.request_id}/submit`, {
        token: form.token,
        values: { "headers.authorization": "Bearer x" },
        access_key: ada.key,
      });
      expect(saved.status).toBe(401);
      expect(saved.body.error.message).toBe("Sign in with TestID to save.");

      // Agent-facing text: help, tool and second-tier descriptions, widget resources.
      expect(await mcp.call("help")).not.toMatch(KEY_WORDS);
      const tools = await mcp.client.listTools();
      for (const tool of tools.tools) expect(tool.description ?? "", tool.name).not.toMatch(KEY_WORDS);
      const specs = await mcp.call("get_tools", { names: ["secret_request", "approval_request"] });
      expect(JSON.stringify(specs)).not.toMatch(KEY_WORDS);
      const resources = await mcp.client.listResources();
      for (const r of resources.resources) {
        if (r.name === "widget: secret-input" || r.name === "widget: service-approve") {
          expect(r.description ?? "", r.name).not.toMatch(KEY_WORDS);
        }
      }
    } finally {
      await mcp.close();
    }
  });

  it("no user key can be made, by the user or the sysadmin; a new user comes without one", async () => {
    const viaToken = apiClient(off.baseUrl, providerToken.access_token);
    const minted = await viaToken.post("/v1/keys", { name: "cli" });
    expect(minted.status).toBe(403);
    expect(minted.body.error.details).toEqual({ reason: "key_login_off" });
    const keyId = (await sysOff.get(`/v1/users/${ada.id}/keys`)).body.data[0].id as string;
    const rotated = await viaToken.post(`/v1/keys/${keyId}/rotate`);
    expect(rotated.status).toBe(403);
    // A refused rotation leaves the old key alone.
    expect((await sysOff.get(`/v1/users/${ada.id}/keys`)).body.data.map((k: any) => k.id)).toContain(keyId);

    const issued = await sysOff.post(`/v1/users/${ada.id}/keys`, { name: "ops" });
    expect(issued.status).toBe(403);
    expect(issued.body.error.message).toContain("Access keys can't be made on this instance");

    const user = await sysOff.post("/v1/users", { name: "Keyless" });
    expect(user.status).toBe(201);
    expect(user.body.initialKey).toBeUndefined();
  });

  it("a key on /v1 and /mcp gets 401 with the message; provider tokens and the sysadmin key work", async () => {
    const message = "Access keys can't be used on this instance. Connect with TestID.";
    const v1 = await apiClient(off.baseUrl, ada.key).get("/v1/whoami");
    expect(v1.status).toBe(401);
    expect(v1.body.error).toEqual({ code: "unauthorized", message, details: { reason: "key_login_off" } });
    // A made-up key gets the same answer: the switch does not reveal which keys exist.
    expect((await apiClient(off.baseUrl, "yap_madeup").get("/v1/whoami")).body.error.message).toBe(message);

    const bearer = await fetch(`${off.baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${ada.key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(bearer.status).toBe(401);
    expect(((await bearer.json()) as any).error.message).toBe(message);
    const query = await fetch(`${off.baseUrl}/mcp?key=${encodeURIComponent(ada.key)}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(query.status).toBe(401);
    expect(((await query.json()) as any).error.message).toBe(message);

    expect((await apiClient(off.baseUrl, providerToken.access_token).get("/v1/whoami")).body.id).toBe(ada.id);
    const mcp = await connectMcp(off.baseUrl, providerToken.access_token);
    expect((await mcp.call("whoami")).id).toBe(ada.id);
    await mcp.close();
    expect((await sysOff.get("/v1/users")).status).toBe(200);
  });

  it("a key-backed grant is refused on use and refresh, and works again once key login is back on", async () => {
    expect((await apiClient(off.baseUrl, keyToken.access_token).get("/v1/whoami")).status).toBe(401);
    const refreshed = await tokenRequest(off.baseUrl, {
      grant_type: "refresh_token",
      client_id: keyToken.clientId,
      refresh_token: keyToken.refresh_token,
    });
    expect(refreshed.status).toBe(400);
    expect(refreshed.body.error).toBe("invalid_grant");

    // Nothing was deleted: on the instance with key login on, the same token and refresh token work.
    expect((await apiClient(on.baseUrl, keyToken.access_token).get("/v1/whoami")).body.id).toBe(ada.id);
    const again = await tokenRequest(on.baseUrl, {
      grant_type: "refresh_token",
      client_id: keyToken.clientId,
      refresh_token: keyToken.refresh_token,
    });
    expect(again.status).toBe(200);
  });
});

describeEachAdapter("provider login only, per user", (adapter) => {
  let idp: FakeProvider;
  let app: TestApp;
  let sys: ApiClient;
  let bob: { id: string; key: string };
  let carol: { id: string; key: string };
  let providerToken: string;

  const authorizeForm = (clientId: string, challenge: string, extra: Record<string, string> = {}) =>
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "role:admin",
      state: "st4te",
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...extra,
    });

  beforeAll(async () => {
    idp = await startFakeProvider();
    app = await bootTestApp(idp.env("test"), await adapter.makeDb());
    sys = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const b = await sys.post("/v1/users", { name: "Bob", email: "bob@example.com" });
    bob = { id: b.body.user.id, key: b.body.initialKey.key };
    const c = await sys.post("/v1/users", { name: "Carol" });
    carol = { id: c.body.user.id, key: c.body.initialKey.key };

    // Bob claims his invite through the provider and connects an app with that login.
    idp.next = { sub: "bob-sub", email: "bob@example.com", email_verified: true, name: "Bob" };
    const client = (await registerClient(app.baseUrl)).body.client_id as string;
    const { verifier, challenge } = pkce();
    const start = await fetch(`${app.baseUrl}/oidc/test/start`, { method: "POST", body: authorizeForm(client, challenge), redirect: "manual" });
    const { html } = await followLogin(start);
    const decided = await fetch(`${app.baseUrl}/oauth/authorize`, {
      method: "POST",
      body: authorizeForm(client, challenge, { decision: "approve", login_ticket: ticketIn(html) }),
      redirect: "manual",
    });
    const code = new URL(decided.headers.get("location")!).searchParams.get("code")!;
    const token = await tokenRequest(app.baseUrl, {
      grant_type: "authorization_code",
      client_id: client,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    });
    providerToken = token.body.access_token;
  });

  afterAll(async () => {
    await app.stop();
    await idp.close();
  });

  it("a claimed invite is provider login only, and its key-backed grants are gone", async () => {
    const user = (await sys.get(`/v1/users/${bob.id}`)).body;
    expect(user.providerLoginOnly).toBe(true);
    const me = await apiClient(app.baseUrl, bob.key).get("/v1/whoami");
    expect(me.status).toBe(401);
    expect(me.body.error.details).toEqual({ reason: "provider_login_only" });
    expect((await apiClient(app.baseUrl, providerToken).get("/v1/whoami")).body.providerLoginOnly).toBe(true);
  });

  it("the sysadmin sets and clears it; setting it refuses the keys, live sessions included, and deletes key-backed grants", async () => {
    // Cleared, Bob's key works again, so he gets a key-backed grant and open sessions.
    const cleared = await sys.patch(`/v1/users/${bob.id}`, { providerLoginOnly: false });
    expect(cleared.status).toBe(200);
    expect(cleared.body.providerLoginOnly).toBe(false);
    expect((await apiClient(app.baseUrl, bob.key).get("/v1/whoami")).status).toBe(200);
    const keyToken = await connectApp(app.baseUrl, bob.key, "role:admin");
    const keySession = await connectMcp(app.baseUrl, bob.key);
    const keyTokenSession = await connectMcp(app.baseUrl, keyToken.access_token);
    const providerSession = await connectMcp(app.baseUrl, providerToken);
    const carolSession = await connectMcp(app.baseUrl, carol.key);
    try {
      for (const s of [keySession, keyTokenSession, providerSession]) expect((await s.call("whoami")).id).toBe(bob.id);

      const set = await sys.patch(`/v1/users/${bob.id}`, { providerLoginOnly: true });
      expect(set.status).toBe(200);
      expect(set.body.providerLoginOnly).toBe(true);

      // The key: /v1, a new MCP session, and the session already open.
      const v1 = await apiClient(app.baseUrl, bob.key).get("/v1/whoami");
      expect(v1.status).toBe(401);
      expect(v1.body.error.message).toBe("This account logs in only with TestID: its access keys can't be used. Connect with TestID.");
      await expect(connectMcp(app.baseUrl, bob.key)).rejects.toThrow(/logs in only with TestID/);
      // The open session's next request is refused too (each request is authenticated).
      await expect(keySession.callRaw("whoami")).rejects.toThrow(/logs in only with TestID/);

      // The key-backed grant is gone: its token, its refresh and its open session stop.
      expect((await apiClient(app.baseUrl, keyToken.access_token).get("/v1/whoami")).status).toBe(401);
      const refreshed = await tokenRequest(app.baseUrl, {
        grant_type: "refresh_token",
        client_id: keyToken.clientId,
        refresh_token: keyToken.refresh_token,
      });
      expect(refreshed.body.error).toBe("invalid_grant");
      await expect(keyTokenSession.callRaw("whoami")).rejects.toThrow(/401|revoked/);
      const grants = (await sys.get(`/v1/users/${bob.id}/oauth-grants`)).body.data;
      expect(grants).toHaveLength(1);
      expect(grants[0].expiresAt).not.toBeNull(); // the provider grant

      // The provider grant keeps working; other users are untouched.
      expect((await providerSession.call("whoami")).id).toBe(bob.id);
      expect((await apiClient(app.baseUrl, providerToken).get("/v1/whoami")).status).toBe(200);
      expect((await carolSession.call("whoami")).id).toBe(carol.id);
      expect((await apiClient(app.baseUrl, carol.key).get("/v1/whoami")).status).toBe(200);
    } finally {
      // Closing re-authenticates, so the refused sessions' close is refused too.
      for (const s of [keySession, keyTokenSession, providerSession, carolSession]) await s.close().catch(() => {});
    }

    // Clearing it makes the key work again, but brings no grant back.
    await sys.patch(`/v1/users/${bob.id}`, { providerLoginOnly: false });
    expect((await apiClient(app.baseUrl, bob.key).get("/v1/whoami")).status).toBe(200);
    expect((await apiClient(app.baseUrl, keyToken.access_token).get("/v1/whoami")).status).toBe(401);
    expect((await sys.get(`/v1/users/${bob.id}/oauth-grants`)).body.data).toHaveLength(1);
    await sys.patch(`/v1/users/${bob.id}`, { providerLoginOnly: true });
  });

  it("no key can be made or rotated for the user, the sysadmin lane included", async () => {
    const viaToken = apiClient(app.baseUrl, providerToken);
    const minted = await viaToken.post("/v1/keys", { name: "cli" });
    expect(minted.status).toBe(403);
    expect(minted.body.error.details).toEqual({ reason: "provider_login_only" });
    const keyId = (await sys.get(`/v1/users/${bob.id}/keys`)).body.data[0].id as string;
    expect((await viaToken.post(`/v1/keys/${keyId}/rotate`)).status).toBe(403);
    expect((await sys.get(`/v1/users/${bob.id}/keys`)).body.data.map((k: any) => k.id)).toEqual([keyId]);
    const issued = await sys.post(`/v1/users/${bob.id}/keys`, { name: "cli" });
    expect(issued.status).toBe(403);
    expect(issued.body.error.message).toContain("providerLoginOnly");
    expect(issued.body.error.message).toContain("PATCH /v1/users/:id");
    // Revoking still works.
    expect((await viaToken.delete(`/v1/keys/${keyId}`)).status).toBe(200);
    // Carol is not affected.
    expect((await sys.post(`/v1/users/${carol.id}/keys`, { name: "ops" })).status).toBe(201);
  });

  it("the pages still show the key field, and tell this user to use the provider", async () => {
    await sys.patch(`/v1/users/${carol.id}`, { providerLoginOnly: true });
    const client = (await registerClient(app.baseUrl)).body.client_id as string;
    const { challenge } = pkce();
    const page = await (await fetch(`${app.baseUrl}/oauth/authorize?${authorizeForm(client, challenge)}`)).text();
    expect(page).toContain('name="access_key"');
    const posted = await postAuthorize(app.baseUrl, { clientId: client, key: carol.key, challenge });
    expect(posted.status).toBe(401);
    expect(await posted.text()).toContain("This account logs in with TestID, not with an access key. Use the TestID button.");
    await sys.patch(`/v1/users/${carol.id}`, { providerLoginOnly: false });
  });

  it("POST /v1/users can create a provider-login-only user, without a key; the flag must be a boolean", async () => {
    const created = await sys.post("/v1/users", { name: "Dora", email: "dora@example.com", providerLoginOnly: true });
    expect(created.status).toBe(201);
    expect(created.body.user.providerLoginOnly).toBe(true);
    expect(created.body.initialKey).toBeUndefined();
    expect((await sys.patch(`/v1/users/${created.body.user.id}`, { providerLoginOnly: "yes" })).status).toBe(400);
    expect((await sys.post("/v1/users", { name: "Eve", providerLoginOnly: "yes" })).status).toBe(400);
    // Only the sysadmin may change it.
    expect((await apiClient(app.baseUrl, providerToken).patch(`/v1/users/${bob.id}`, { providerLoginOnly: false })).status).toBe(401);
    const row = await app.db.client.select().from(app.db.tables.users).where(eq(app.db.tables.users.id, bob.id));
    expect(row[0]!.providerLoginOnly).toBe(1);
  });
});
