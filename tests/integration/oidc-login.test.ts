/**
 * Provider (OIDC) login on the pages Core serves itself, against a fake
 * provider, on both adapters. Pinned here:
 *
 * - with a provider configured, each page offers "Continue with {label}"
 *   before the key; the callback identifies the person and renders the page
 *   again with their name and a one-off ticket, and never decides by itself;
 * - the ID token is verified (signature, issuer, audience/azp, expiry, nonce),
 *   PKCE and Core's own state are used, the response's `iss` is checked; a
 *   replayed callback, a spent ticket, a ticket for another request and a
 *   ticket sent with a key are refused;
 * - a returning person is recognised by (issuer, sub), never by email; an
 *   invite (a user with an email and no identity) is claimed once; sign-up is
 *   off by default and, when on, admits only verified allowlisted addresses,
 *   creating a user with a personal space and no key;
 * - consent after a provider login yields a keyless grant that works on /mcp,
 *   shows in connected apps, ends after YAP_OIDC_GRANT_MAX_DAYS (or the
 *   provider's override) counted from creation, survives key revocation and
 *   dies with the user; YAP_OAUTH_MAX_ROLE caps the role for both methods;
 * - the approve page and the secret form decide with the ticket.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../../src/config.js";
import { signupAllows } from "../../src/core/oidc.js";
import { createUser } from "../../src/core/users.js";
import { widgetHtml } from "../../src/widgets/registry.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, testEnv, type TestApp, KEY_LOGIN_ON } from "../helpers/app.js";
import { connectMcp } from "../helpers/mcp.js";
import { pkce, postAuthorize, REDIRECT_URI, registerClient, tokenRequest } from "../helpers/oauth.js";
import { followLogin, startFakeProvider, ticketIn, type FakeProvider } from "../helpers/oidc.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("oidc config", () => {
  const provider = {
    YAP_OIDC_PROVIDERS: "corp",
    YAP_OIDC_CORP_ISSUER: "https://id.example.com",
    YAP_OIDC_CORP_CLIENT_ID: "client",
    YAP_OIDC_CORP_CLIENT_SECRET: "secret",
  };
  it("fails at startup without YAP_BASE_URL", () => {
    expect(() => loadConfig(testEnv(provider))).toThrow(/YAP_BASE_URL/);
  });
  it("loads a provider with defaults, and the per-provider lifetime override", () => {
    const config = loadConfig(
      testEnv({ ...provider, YAP_BASE_URL: "https://yap.example.com", YAP_OIDC_CORP_GRANT_MAX_DAYS: "7" }),
    );
    expect(config.oidc).toEqual({
      providers: [
        { name: "corp", issuer: "https://id.example.com", clientId: "client", clientSecret: "secret", label: "Corp", grantMaxDays: 7 },
      ],
      signup: false,
      allow: [],
    });
    expect(loadConfig(testEnv({ ...provider, YAP_BASE_URL: "https://y.example" })).oidc.providers[0]!.grantMaxDays).toBe(30);
  });
  it("refuses a half-configured provider, an http issuer, a bad allowlist entry and a bad max role", () => {
    const base = { ...provider, YAP_BASE_URL: "https://y.example" };
    expect(() => loadConfig(testEnv({ ...base, YAP_OIDC_CORP_CLIENT_SECRET: "" }))).toThrow(/CLIENT_SECRET/);
    expect(() => loadConfig(testEnv({ ...base, YAP_OIDC_CORP_ISSUER: "http://id.example.com" }))).toThrow(/https/);
    expect(() => loadConfig(testEnv({ ...base, YAP_OIDC_ALLOW: "example.com" }))).toThrow(ConfigError);
    expect(() => loadConfig(testEnv({ YAP_OAUTH_MAX_ROLE: "owner" }))).toThrow(/YAP_OAUTH_MAX_ROLE/);
    expect(() => loadConfig(testEnv({ ...base, YAP_OIDC_GRANT_MAX_DAYS: "0" }))).toThrow(/positive/);
  });
  it("without a provider, nothing changes", () => {
    const config = loadConfig(testEnv());
    expect(config.oidc.providers).toEqual([]);
    expect(config.oauthMaxRole).toBeUndefined();
  });
});

describe("sign-up allowlist", () => {
  it("takes exact addresses and @domain entries; via Google a domain needs hd", () => {
    const allow = ["bo@solo.example", "@corp.example"];
    expect(signupAllows(allow, "bo@solo.example", {}, "https://id.example")).toBe(true);
    expect(signupAllows(allow, "eve@solo.example", {}, "https://id.example")).toBe(false);
    expect(signupAllows(allow, "ann@corp.example", {}, "https://id.example")).toBe(true);
    expect(signupAllows(allow, "ann@corp.example", {}, "https://accounts.google.com")).toBe(false);
    expect(signupAllows(allow, "ann@corp.example", { hd: "corp.example" }, "https://accounts.google.com")).toBe(true);
    expect(signupAllows(allow, "ann@corp.example", { hd: "other.example" }, "https://accounts.google.com")).toBe(false);
    // An exact entry needs no hd, even via Google.
    expect(signupAllows(allow, "bo@solo.example", {}, "https://accounts.google.com")).toBe(true);
  });
});

describe("in a host's frame", () => {
  it("the provider links open a tab of their own", () => {
    for (const widget of ["service-approve", "secret-input"]) {
      const html = widgetHtml(widget, "client", undefined, "https://yap.example");
      expect(html).toContain('target=\\"_blank\\"');
      expect(html).toContain("/oidc/");
    }
  });
});

describeEachAdapter("oidc login", (adapter) => {
  let idp: FakeProvider;
  let app: TestApp;
  let sysadmin: ApiClient;
  let adaId: string;
  let adaKey: string;

  const authorizeForm = (clientId: string, challenge: string, extra: Record<string, string> = {}) =>
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "role:member",
      state: "st4te",
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...extra,
    });

  /** Consent through the provider: returns the page rendered after the login and the client. */
  async function consentLogin(base = app.baseUrl) {
    const client = (await registerClient(base)).body.client_id as string;
    const { verifier, challenge } = pkce();
    const start = await fetch(`${base}/oidc/test/start`, {
      method: "POST",
      body: authorizeForm(client, challenge),
      redirect: "manual",
    });
    const after = await followLogin(start);
    return { client, verifier, challenge, ...after };
  }

  async function approveWithTicket(base: string, client: string, challenge: string, ticket: string, extra: Record<string, string> = {}) {
    const form = authorizeForm(client, challenge, { decision: "approve", login_ticket: ticket, ...extra });
    return fetch(`${base}/oauth/authorize`, { method: "POST", body: form, redirect: "manual" });
  }

  async function exchange(base: string, client: string, verifier: string, location: string) {
    const code = new URL(location).searchParams.get("code")!;
    return tokenRequest(base, {
      grant_type: "authorization_code",
      client_id: client,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    });
  }

  beforeAll(async () => {
    idp = await startFakeProvider();
    app = await bootTestApp(
      idp.env("test", { YAP_OIDC_TEST_GRANT_MAX_DAYS: "3", YAP_HOOK_ALLOW_HOSTS: "127.0.0.1" }),
      await adapter.makeDb(),
    );
    sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    // Ada is invited: created by the operator with her email, no identity yet.
    const ada = await sysadmin.post("/v1/users", { name: "Ada", email: "Ada@Example.com" });
    expect(ada.status).toBe(201);
    expect(ada.body.user.email).toBe("ada@example.com");
    adaId = ada.body.user.id;
    adaKey = ada.body.initialKey.key;
  });

  afterAll(async () => {
    await app.stop();
    await idp.close();
  });

  describe("the consent screen", () => {
    it("leads with the provider, keeps the key second", async () => {
      const client = (await registerClient(app.baseUrl)).body.client_id as string;
      const { challenge } = pkce();
      const html = await (await fetch(`${app.baseUrl}/oauth/authorize?${authorizeForm(client, challenge)}`)).text();
      expect(html).toContain("Continue with TestID");
      expect(html).toContain('formaction="/oidc/test/start"');
      expect(html.indexOf("Continue with TestID")).toBeLessThan(html.indexOf('name="access_key"'));
    });

    it("a provider login claims the invite and renders the consent page, which decides nothing by itself", async () => {
      idp.next = { sub: "ada-sub", email: "ada@example.com", email_verified: true, name: "Ada L." };
      const { res, html, client, verifier, challenge } = await consentLogin();
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(html).toContain("Logged in as <strong>Ada</strong> with TestID");
      expect(html).not.toContain('name="access_key"');
      expect(html).toContain("Test App");
      const identities = await app.db.client.select().from(app.db.tables.userIdentities);
      expect(identities).toMatchObject([{ userId: adaId, issuer: idp.issuer, subject: "ada-sub" }]);
      // Claiming the invite set Ada to provider login only: her key is refused
      // from now on. The operator clears it, so the key keeps working below.
      expect((await sysadmin.get(`/v1/users/${adaId}`)).body.providerLoginOnly).toBe(true);
      expect((await apiClient(app.baseUrl, adaKey).get("/v1/whoami")).status).toBe(401);
      expect((await sysadmin.patch(`/v1/users/${adaId}`, { providerLoginOnly: false })).status).toBe(200);
      // PKCE and the exact callback URL went to the provider.
      const sent = idp.tokenRequests.at(-1)!;
      expect(sent.get("redirect_uri")).toBe(`${app.baseUrl}/oidc/test/callback`);
      expect(sent.get("code_verifier")).toBeTruthy();

      const decided = await approveWithTicket(app.baseUrl, client, challenge, ticketIn(html));
      expect(decided.status).toBe(302);
      const token = await exchange(app.baseUrl, client, verifier, decided.headers.get("location")!);
      expect(token.status).toBe(200);
      expect(token.body.scope).toBe("role:member");

      // The token works on /mcp and REST, as Ada, with no key behind it.
      const mcp = await connectMcp(app.baseUrl, token.body.access_token);
      expect((await mcp.call("whoami")).id ?? (await mcp.call("whoami")).user?.id).toBe(adaId);
      await mcp.close();
      expect((await apiClient(app.baseUrl, token.body.access_token).get("/v1/whoami")).body.id).toBe(adaId);
      const grants = await app.db.client.select().from(app.db.tables.oauthGrants).where(eq(app.db.tables.oauthGrants.userId, adaId));
      const grant = grants.find((g) => g.clientId === client)!;
      expect(grant.keyId).toBeNull();
      // The per-provider override: three days from creation.
      const lifetime = Date.parse(grant.expiresAt!) - Date.parse(grant.createdAt);
      expect(Math.abs(lifetime - 3 * DAY_MS)).toBeLessThan(5000);

      // Listed in connected apps, with its end.
      const listed = (await apiClient(app.baseUrl, adaKey).get("/v1/oauth/grants")).body.data;
      expect(listed.find((g: any) => g.id === grant.id)).toMatchObject({ expiresAt: grant.expiresAt });
      // Revoking Ada's key leaves a provider grant alone.
      const keys = (await sysadmin.get(`/v1/users/${adaId}/keys`)).body.data;
      const spare = await sysadmin.post(`/v1/users/${adaId}/keys`, { name: "spare" });
      expect(spare.status).toBe(201);
      for (const k of keys) await sysadmin.delete(`/v1/users/${adaId}/keys/${k.id}`);
      adaKey = spare.body.key;
      expect((await apiClient(app.baseUrl, token.body.access_token).get("/v1/whoami")).status).toBe(200);
      // The sysadmin lane lists and revokes it.
      const sysList = (await sysadmin.get(`/v1/users/${adaId}/oauth-grants`)).body.data;
      expect(sysList.map((g: any) => g.id)).toContain(grant.id);
      expect((await sysadmin.delete(`/v1/users/${adaId}/oauth-grants/${grant.id}`)).status).toBe(200);
      expect((await apiClient(app.baseUrl, token.body.access_token).get("/v1/whoami")).status).toBe(401);
    });

    it("recognises a returning person by issuer and sub, never by email", async () => {
      idp.next = { sub: "ada-sub", email: "ada.new@elsewhere.example", email_verified: true };
      const again = await consentLogin();
      expect(again.html).toContain("Logged in as <strong>Ada</strong>");
      // Another account carrying Ada's email is a stranger: the invite is claimed.
      idp.next = { sub: "impostor", email: "ada@example.com", email_verified: true };
      const stranger = await consentLogin();
      expect(stranger.res.status).toBe(400);
      expect(stranger.html).toContain("There is no Yap account for this login");
    });

    it("an invite the operator withdrew is not claimed", async () => {
      const grace = await sysadmin.post("/v1/users", { name: "Grace", email: "grace@example.com" });
      expect((await sysadmin.patch(`/v1/users/${grace.body.user.id}`, { email: null })).status).toBe(200);
      idp.next = { sub: "grace-sub", email: "grace@example.com", email_verified: true };
      const { res, html } = await consentLogin();
      expect(res.status).toBe(400);
      expect(html).toContain("There is no Yap account for this login");
    });

    it("refuses a replayed callback, a spent ticket, a ticket for another request and a ticket with a key", async () => {
      idp.next = { sub: "ada-sub" };
      const first = await consentLogin();
      const replay = await fetch(first.callbackUrl, { redirect: "manual" });
      expect(replay.status).toBe(400);
      expect(await replay.text()).toContain("expired or was already used");

      // The row lives as long as its ticket, so the sweep on the next start cannot take it early.
      const rows = await app.db.client.select().from(app.db.tables.oidcTransactions);
      for (const row of rows.filter((r) => r.ticketExpiresAt !== null)) expect(row.expiresAt).toBe(row.ticketExpiresAt);

      const ticket = ticketIn(first.html);
      const both = await approveWithTicket(app.baseUrl, first.client, first.challenge, ticket, { access_key: adaKey });
      expect(both.status).toBe(401);
      expect(await both.text()).toContain("Log in one way");
      const other = await approveWithTicket(app.baseUrl, first.client, first.challenge, ticket, { state: "another" });
      expect(other.status).toBe(401);
      expect(await other.text()).toContain("Your login has expired or was already used");
      // A refused attempt with a valid binding spends nothing; the right one passes once.
      expect((await approveWithTicket(app.baseUrl, first.client, first.challenge, ticket)).status).toBe(302);
      const spent = await approveWithTicket(app.baseUrl, first.client, first.challenge, ticket);
      expect(spent.status).toBe(401);
      expect(await spent.text()).toContain("Your login has expired or was already used");
    });

    it("refuses an ID token that does not verify, and a response from another issuer", async () => {
      idp.next = { sub: "ada-sub" };
      const cases: Array<[FakeProvider["tamper"], string]> = [
        [{ aud: "someone-else" }, "did not verify"],
        [{ iss: "https://evil.example" }, "did not verify"],
        [{ nonce: "wrong" }, "belongs to another login"],
        [{ expired: true }, "did not verify"],
        [{ foreignKey: true }, "did not verify"],
        [{ aud: [idp.clientId, "other"], azp: "other" }, "issued to another party"],
        [{ responseIss: "https://evil.example" }, "different provider"],
      ];
      for (const [tamper, words] of cases) {
        idp.tamper = tamper;
        const { res, html } = await consentLogin();
        expect(res.status, JSON.stringify(tamper)).toBe(400);
        expect(html, JSON.stringify(tamper)).toContain(words);
        expect(html).not.toContain("login_ticket");
      }
      idp.tamper = {};
    });

    it("refreshes until the grant's maximum lifetime, then refuses", async () => {
      idp.next = { sub: "ada-sub" };
      const login = await consentLogin();
      const decided = await approveWithTicket(app.baseUrl, login.client, login.challenge, ticketIn(login.html));
      const token = await exchange(app.baseUrl, login.client, login.verifier, decided.headers.get("location")!);
      const refreshed = await tokenRequest(app.baseUrl, {
        grant_type: "refresh_token",
        client_id: login.client,
        refresh_token: token.body.refresh_token,
      });
      expect(refreshed.status).toBe(200);
      // Refresh does not extend the end: it is the one set at creation.
      const { oauthGrants } = app.db.tables;
      const rows = await app.db.client.select().from(oauthGrants).where(eq(oauthGrants.clientId, login.client));
      const createdEnd = rows[0]!.expiresAt!;
      // Move the end into the past, as time would.
      await app.db.client.update(oauthGrants).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(oauthGrants.id, rows[0]!.id));
      expect(createdEnd > new Date().toISOString()).toBe(true);
      const late = await tokenRequest(app.baseUrl, {
        grant_type: "refresh_token",
        client_id: login.client,
        refresh_token: refreshed.body.refresh_token,
      });
      expect(late.status).toBe(400);
      expect(late.body.error_description).toContain("maximum lifetime");
      expect((await apiClient(app.baseUrl, refreshed.body.access_token).get("/v1/whoami")).status).toBe(401);
    });

    it("a key-backed grant is unchanged: bound to its key, no end of its own", async () => {
      const client = (await registerClient(app.baseUrl)).body.client_id as string;
      const { challenge } = pkce();
      const res = await postAuthorize(app.baseUrl, { clientId: client, key: adaKey, challenge });
      expect(res.status).toBe(302);
      const codes = await app.db.client.select().from(app.db.tables.oauthCodes).where(eq(app.db.tables.oauthCodes.clientId, client));
      expect(codes[0]!.keyId).not.toBeNull();
      expect(codes[0]!.grantExpiresAt).toBeNull();
    });
  });

  describe("the connected-apps page", () => {
    it("logs in through the provider and disconnects with the list's session", async () => {
      idp.next = { sub: "ada-sub" };
      const prompt = await (await fetch(`${app.baseUrl}/oauth/connections`)).text();
      expect(prompt).toContain('href="/oidc/test/start?for=connections"');
      const { res, html } = await followLogin(
        await fetch(`${app.baseUrl}/oidc/test/start?for=connections`, { redirect: "manual" }),
      );
      expect(res.status).toBe(200);
      expect(html).toContain("Logged in as <strong>Ada</strong>");
      expect(html).toContain("Connected apps");
      expect(html).toContain('name="session"');
    });
  });

  describe("the approve page and the secret form", () => {
    let mcpKey: string;
    let spaceId: string;
    let bundleId: string;

    beforeAll(async () => {
      mcpKey = adaKey;
      const ada = apiClient(app.baseUrl, mcpKey);
      spaceId = (await ada.post("/v1/spaces", { name: "Ops" })).body.id;
      bundleId = (await ada.post(`/v1/spaces/${spaceId}/bundles`, { name: "ops" })).body.id;
    });

    const one = async (tool: string, params: Record<string, unknown>) => {
      const mcp = await connectMcp(app.baseUrl, mcpKey);
      try {
        return (await mcp.call("call", { space_id: spaceId, calls: [{ bundle_id: bundleId, tool, params }] })).results[0];
      } finally {
        await mcp.close();
      }
    };

    it("approves a service with the ticket of a provider login made for that page", async () => {
      const created = await one("create_service", {
        name: "hook",
        params: [{ name: "text", required: true }],
        settings: { url: "http://127.0.0.1:9/x", method: "POST", headers: {}, body_json: { text: "{{text}}" } },
      });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      const req = await one("approval_request", { id: "hook" });
      const { request_id, token } = req._meta.data as { request_id: string; token: string };
      // In a host's frame the widget learns the providers from the server.
      const view = await apiClient(app.baseUrl).post(`/v1/service-approvals/${request_id}/view`, { token });
      expect(view.body.logins).toEqual({ providers: [{ id: "test", label: "TestID" }], keyLogin: true });

      // A start link with another page's token is refused.
      const bad = await fetch(`${app.baseUrl}/oidc/test/start?for=service-approve&request=${request_id}&token=nope`, { redirect: "manual" });
      expect(bad.status).toBe(401);

      idp.next = { sub: "ada-sub" };
      const start = await fetch(
        `${app.baseUrl}/oidc/test/start?for=service-approve&request=${request_id}&token=${encodeURIComponent(token)}`,
        { redirect: "manual" },
      );
      const { res, html } = await followLogin(start);
      expect(res.status).toBe(200);
      expect(html).toContain('"login":');
      expect(html).toContain("Ada");
      // Still waiting: the callback decided nothing.
      expect((await one("get_service", { id: "hook" })).result.approved).toBe(false);

      const decide = await apiClient(app.baseUrl).post(`/v1/service-approvals/${request_id}/decide`, {
        token,
        decision: "approve",
        login_ticket: ticketIn(html),
        fingerprint: view.body.fingerprint,
      });
      expect(decide.status, JSON.stringify(decide.body)).toBe(200);
      const service = await one("get_service", { id: "hook" });
      expect(service.result).toMatchObject({ approved: true, approvedBy: adaId });
    });

    it("saves a secret with the ticket of a provider login made for that form", async () => {
      const created = await one("create_service", {
        name: "secret-hook",
        params: [{ name: "text", required: true }],
        settings: { url: "http://127.0.0.1:9/y", method: "POST", headers: {}, body_json: { text: "{{text}}" } },
      });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      const req = await one("secret_request", { id: "secret-hook", paths: ["headers.authorization"] });
      expect(req.ok, JSON.stringify(req)).toBe(true);
      const { request_id, token } = req._meta.data as { request_id: string; token: string };
      const path = "headers.authorization";

      idp.next = { sub: "ada-sub" };
      const { res, html } = await followLogin(
        await fetch(`${app.baseUrl}/oidc/test/start?for=secret-input&request=${request_id}&token=${encodeURIComponent(token)}`, {
          redirect: "manual",
        }),
      );
      expect(res.status).toBe(200);
      const ticket = ticketIn(html);
      // A ticket made for this form is no good on another page.
      const elsewhere = await apiClient(app.baseUrl).post(`/v1/secret-requests/${request_id}/submit`, {
        token,
        values: { [path]: "Bearer s3cret" },
        login_ticket: "not-the-ticket",
      });
      expect(elsewhere.status).toBe(401);
      const saved = await apiClient(app.baseUrl).post(`/v1/secret-requests/${request_id}/submit`, {
        token,
        values: { [path]: "Bearer s3cret" },
        login_ticket: ticket,
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body).toEqual({ saved: true, paths: [path] });
    });
  });

  describe("sign-up", () => {
    let signupApp: TestApp;

    beforeAll(async () => {
      await app.stop();
      signupApp = await bootTestApp(
        idp.env("test", { YAP_OIDC_SIGNUP: "true", YAP_OIDC_ALLOW: "@corp.example, bob@solo.example", YAP_OAUTH_MAX_ROLE: "member" }),
        await adapter.makeDb(),
      );
    });

    afterAll(async () => {
      await signupApp.stop();
      // The outer afterAll stops `app` again; give it a live one.
      app = await bootTestApp({}, await adapter.makeDb());
    });

    it("creates an allowlisted, verified person with a personal space and no key", async () => {
      idp.next = { sub: "carol-sub", email: "Carol@corp.example", email_verified: true, name: "Carol" };
      const { res, html } = await consentLogin(signupApp.baseUrl);
      expect(res.status).toBe(200);
      expect(html).toContain("Logged in as <strong>Carol</strong>");
      const sys = apiClient(signupApp.baseUrl, TEST_SYSADMIN_KEY);
      const carol = (await sys.get("/v1/users")).body.data.find((u: any) => u.name === "Carol");
      expect(carol.email).toBe("carol@corp.example");
      expect(carol.providerLoginOnly).toBe(true);
      expect((await sys.get(`/v1/users/${carol.id}/keys`)).body.data).toEqual([]);
      const spaces = await signupApp.db.client.select().from(signupApp.db.tables.spaces).where(eq(signupApp.db.tables.spaces.ownerId, carol.id));
      expect(spaces).toMatchObject([{ personal: 1 }]);
    });

    it("refuses an unverified or unlisted address", async () => {
      for (const next of [
        { sub: "dan-sub", email: "dan@corp.example", email_verified: "true" },
        { sub: "dan-sub", email: "dan@corp.example" },
        { sub: "eve-sub", email: "eve@other.example", email_verified: true },
      ]) {
        idp.next = next;
        const { res, html } = await consentLogin(signupApp.baseUrl);
        expect(res.status, JSON.stringify(next)).toBe(400);
        expect(html).toContain("There is no Yap account for this login");
      }
    });

    it("YAP_OAUTH_MAX_ROLE caps the role for a provider login and for a key", async () => {
      idp.next = { sub: "carol-sub" };
      const login = await consentLogin(signupApp.baseUrl);
      expect(login.html).not.toContain('value="admin"');
      const decided = await approveWithTicket(signupApp.baseUrl, login.client, login.challenge, ticketIn(login.html), { role: "admin" });
      const token = await exchange(signupApp.baseUrl, login.client, login.verifier, decided.headers.get("location")!);
      expect(token.body.scope).toBe("role:member");

      const sys = apiClient(signupApp.baseUrl, TEST_SYSADMIN_KEY);
      const user = await sys.post("/v1/users", { name: "Keyed" });
      const client = (await registerClient(signupApp.baseUrl)).body.client_id as string;
      const { verifier, challenge } = pkce();
      const res = await postAuthorize(signupApp.baseUrl, {
        clientId: client,
        key: user.body.initialKey.key,
        challenge,
        scope: "role:admin",
        role: "admin",
      });
      const keyed = await exchange(signupApp.baseUrl, client, verifier, res.headers.get("location")!);
      expect(keyed.body.scope).toBe("role:member");
    });

    it("a provider-login grant dies with its user", async () => {
      const sys = apiClient(signupApp.baseUrl, TEST_SYSADMIN_KEY);
      const carol = (await sys.get("/v1/users")).body.data.find((u: any) => u.name === "Carol");
      const before = await signupApp.db.client.select().from(signupApp.db.tables.oauthGrants).where(eq(signupApp.db.tables.oauthGrants.userId, carol.id));
      expect(before.length).toBeGreaterThan(0);
      expect((await sys.delete(`/v1/users/${carol.id}`)).status).toBe(200);
      const after = await signupApp.db.client.select().from(signupApp.db.tables.oauthGrants).where(eq(signupApp.db.tables.oauthGrants.userId, carol.id));
      expect(after).toEqual([]);
    });
  });
});

describeEachAdapter("createUser without an initial key", (adapter) => {
  it("creates the personal space and no key; POST /v1/users still mints one and says 201/200", async () => {
    const app = await bootTestApp({}, await adapter.makeDb());
    try {
      const made = await createUser(app.db, KEY_LOGIN_ON, { name: "Keyless" }, { initialKey: false });
      expect(made.created).toBe(true);
      expect(made).not.toHaveProperty("initialKey");
      const keys = await app.db.client.select().from(app.db.tables.accessKeys).where(eq(app.db.tables.accessKeys.userId, made.user.id));
      expect(keys).toEqual([]);
      expect(made.personalSpaceId).toBeTruthy();

      const sys = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
      const first = await sys.post("/v1/users", { name: "Grace", externalId: "ext-g" });
      expect(first.status).toBe(201);
      expect(first.body.initialKey.key).toMatch(/^yap_/);
      expect(first.body).not.toHaveProperty("created");
      const again = await sys.post("/v1/users", { name: "Grace", externalId: "ext-g" });
      expect(again.status).toBe(200);
      expect(again.body).not.toHaveProperty("initialKey");
      const repeat = await createUser(app.db, KEY_LOGIN_ON, { name: "x", externalId: "ext-g" }, { initialKey: false });
      expect(repeat.created).toBe(false);

      // An email can be set and cleared later: setting one invites the user.
      const patched = await sys.patch(`/v1/users/${first.body.user.id}`, { email: "grace@example.com" });
      expect(patched.body.email).toBe("grace@example.com");
      expect((await sys.patch(`/v1/users/${first.body.user.id}`, { email: null })).body.email).toBeNull();
      expect((await sys.post("/v1/users", { name: "Bad", email: "not-an-address" })).status).toBe(400);
    } finally {
      await app.stop();
    }
  });
});
