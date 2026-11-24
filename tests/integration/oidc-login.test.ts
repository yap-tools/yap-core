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
 * - a provider's preset (generic, google, entra) and its env overrides decide
 *   which claims give the subject and the email and whether the email needs
 *   email_verified; the google preset's hd check applies on any issuer;
 * - consent after a provider login yields a keyless grant that works on /mcp,
 *   shows in connected apps, ends after YAP_OIDC_GRANT_MAX_DAYS (or the
 *   provider's override) counted from creation, survives key revocation and
 *   dies with the user; YAP_OAUTH_MAX_ROLE caps the role for both methods;
 * - the approve page and the secret form decide with the ticket.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../../src/config.js";
import { mapClaims, signupAllows } from "../../src/core/oidc.js";
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
        {
          name: "corp",
          issuer: "https://id.example.com",
          clientId: "client",
          clientSecret: "secret",
          label: "Corp",
          grantMaxDays: 7,
          preset: "generic",
          claims: { emailClaims: ["email"], trustEmail: false, subjectClaim: "sub", domainClaim: null },
        },
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

describe("provider presets", () => {
  const base = {
    YAP_BASE_URL: "https://y.example",
    YAP_OIDC_PROVIDERS: "corp",
    YAP_OIDC_CORP_ISSUER: "https://id.example.com",
    YAP_OIDC_CORP_CLIENT_ID: "client",
    YAP_OIDC_CORP_CLIENT_SECRET: "secret",
  };
  const load = (extra: Record<string, string> = {}) => loadConfig(testEnv({ ...base, ...extra })).oidc.providers[0]!;

  it("defaults to generic, or to google for Google's issuer, and reads each preset's table", () => {
    expect(load()).toMatchObject({ preset: "generic", claims: { emailClaims: ["email"], trustEmail: false, subjectClaim: "sub", domainClaim: null } });
    expect(load({ YAP_OIDC_CORP_ISSUER: "https://accounts.google.com" })).toMatchObject({ preset: "google", claims: { domainClaim: "hd" } });
    expect(load({ YAP_OIDC_CORP_ISSUER: "https://accounts.google.com", YAP_OIDC_CORP_PRESET: "generic" }).claims.domainClaim).toBeNull();
    expect(load({ YAP_OIDC_CORP_PRESET: "google" }).claims.domainClaim).toBe("hd");
    expect(load({ YAP_OIDC_CORP_PRESET: "entra" })).toMatchObject({
      preset: "entra",
      claims: { emailClaims: ["email", "preferred_username"], trustEmail: true, subjectClaim: "oid", domainClaim: null },
    });
  });

  it("applies the env overrides on top of the preset", () => {
    expect(
      load({ YAP_OIDC_CORP_EMAIL_CLAIM: "mail, upn", YAP_OIDC_CORP_TRUST_EMAIL: "true", YAP_OIDC_CORP_SUBJECT_CLAIM: "uid" }).claims,
    ).toEqual({ emailClaims: ["mail", "upn"], trustEmail: true, subjectClaim: "uid", domainClaim: null });
    expect(load({ YAP_OIDC_CORP_EMAIL_CLAIM: "https://example.com/claims/email", YAP_OIDC_CORP_TRUST_EMAIL: "true" }).claims.emailClaims).toEqual([
      "https://example.com/claims/email",
    ]);
    expect(
      load({ YAP_OIDC_CORP_PRESET: "entra", YAP_OIDC_CORP_TRUST_EMAIL: "false", YAP_OIDC_CORP_EMAIL_CLAIM: "email" }).claims,
    ).toMatchObject({ emailClaims: ["email"], trustEmail: false, subjectClaim: "oid" });
  });

  it("refuses a claim other than email on an untrusted provider: email_verified does not cover it", () => {
    expect(() => load({ YAP_OIDC_CORP_EMAIL_CLAIM: "preferred_username" })).toThrow(/email_verified does not cover.*TRUST_EMAIL=true/);
    expect(() => load({ YAP_OIDC_CORP_PRESET: "entra", YAP_OIDC_CORP_TRUST_EMAIL: "false" })).toThrow(/preferred_username/);
  });

  it("refuses an unknown preset, a bad trust value and a bad claim name at startup", () => {
    expect(() => load({ YAP_OIDC_CORP_PRESET: "okta" })).toThrow(/PRESET must be one of generic, google, entra/);
    expect(() => load({ YAP_OIDC_CORP_PRESET: "toString" })).toThrow(/PRESET/);
    expect(() => load({ YAP_OIDC_CORP_TRUST_EMAIL: "yes" })).toThrow(/TRUST_EMAIL/);
    expect(() => load({ YAP_OIDC_CORP_EMAIL_CLAIM: "e mail", YAP_OIDC_CORP_TRUST_EMAIL: "true" })).toThrow(/EMAIL_CLAIM/);
    expect(() => load({ YAP_OIDC_CORP_EMAIL_CLAIM: " , " })).toThrow(/EMAIL_CLAIM names no claim/);
    expect(() => load({ YAP_OIDC_CORP_SUBJECT_CLAIM: "a b" })).toThrow(/SUBJECT_CLAIM/);
  });

  it("maps an Entra token: email from preferred_username, trusted, subject oid", () => {
    const entra = load({ YAP_OIDC_CORP_PRESET: "entra" });
    const token = { sub: "pairwise", oid: "object-id", preferred_username: "Ann@Corp.example", name: "Ann" };
    expect(mapClaims(entra, token)).toEqual({ subject: "object-id", email: "ann@corp.example", name: "Ann", domainVouched: true });
    // `email` wins when present; a non-address in the first claim falls through to the next.
    expect(mapClaims(entra, { ...token, email: "ann.mail@corp.example" }).email).toBe("ann.mail@corp.example");
    expect(mapClaims(entra, { ...token, email: "not-an-address" }).email).toBe("ann@corp.example");
    expect(() => mapClaims(entra, { sub: "pairwise", preferred_username: "ann@corp.example" })).toThrow(/no oid claim/);
    // The same token under generic: no verified email, so no invite and no sign-up.
    expect(mapClaims(load(), token)).toEqual({ subject: "pairwise", email: null, name: "Ann", domainVouched: true });
  });

  it("under generic, only email_verified: true counts", () => {
    const generic = load();
    expect(mapClaims(generic, { sub: "s", email: " Bo@X.example ", email_verified: true }).email).toBe("bo@x.example");
    expect(mapClaims(generic, { sub: "s", email: "bo@x.example", email_verified: "true" }).email).toBeNull();
    expect(mapClaims(generic, { sub: "s", email: "bo@x.example" }).email).toBeNull();
    // No name: the email stands in.
    expect(mapClaims(generic, { sub: "s", email: "bo@x.example", email_verified: true }).name).toBe("bo@x.example");
  });

  it("vouches for a domain under google only with hd naming it, whatever the issuer", () => {
    const google = load({ YAP_OIDC_CORP_PRESET: "google" });
    const claims = { sub: "s", email: "ann@corp.example", email_verified: true };
    expect(mapClaims(google, claims).domainVouched).toBe(false);
    expect(mapClaims(google, { ...claims, hd: "Corp.example" }).domainVouched).toBe(true);
    expect(mapClaims(google, { ...claims, hd: "other.example" }).domainVouched).toBe(false);
    expect(mapClaims(load(), claims).domainVouched).toBe(true);
  });
});

describe("sign-up allowlist", () => {
  it("takes exact addresses, and @domain entries when the login vouches for the domain", () => {
    const allow = ["bo@solo.example", "@corp.example"];
    expect(signupAllows(allow, "bo@solo.example", true)).toBe(true);
    expect(signupAllows(allow, "eve@solo.example", true)).toBe(false);
    expect(signupAllows(allow, "ann@corp.example", true)).toBe(true);
    expect(signupAllows(allow, "ann@corp.example", false)).toBe(false);
    // An exact entry needs no domain vouching.
    expect(signupAllows(allow, "bo@solo.example", false)).toBe(true);
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

describeEachAdapter("provider presets end to end", (adapter) => {
  let idp: FakeProvider;
  const apps: TestApp[] = [];
  // Entra v2.0 shape: no email_verified, the address only in preferred_username, a pairwise sub.
  const entraToken = (oid: string, upn: string) => ({ sub: `pairwise-${oid}`, oid, preferred_username: upn, name: upn.split("@")[0] });

  beforeAll(async () => {
    idp = await startFakeProvider();
  });
  afterAll(async () => {
    for (const a of apps) await a.stop();
    await idp.close();
  });

  async function boot(extra: Record<string, string>) {
    const app = await bootTestApp(
      idp.env("test", { YAP_OIDC_SIGNUP: "true", YAP_OIDC_ALLOW: "@corp.example", ...extra }),
      await adapter.makeDb(),
    );
    apps.push(app);
    await apiClient(app.baseUrl, TEST_SYSADMIN_KEY).post("/v1/users", { name: "Invited", email: "invited@corp.example" });
    return app;
  }
  const login = async (app: TestApp) =>
    followLogin(await fetch(`${app.baseUrl}/oidc/test/start?for=connections`, { redirect: "manual" }));
  const identities = async (app: TestApp) =>
    (await app.db.client.select().from(app.db.tables.userIdentities)).map((i) => i.subject).sort();

  it("with the entra preset, an Entra-shaped token claims an invite and signs up under the allowlist, keyed by oid", async () => {
    const app = await boot({ YAP_OIDC_TEST_PRESET: "entra" });
    idp.next = entraToken("oid-invited", "Invited@corp.example");
    const invited = await login(app);
    expect(invited.res.status).toBe(200);
    expect(invited.html).toContain("Logged in as <strong>Invited</strong>");

    idp.next = entraToken("oid-new", "new@corp.example");
    const signedUp = await login(app);
    expect(signedUp.res.status).toBe(200);
    const users = (await apiClient(app.baseUrl, TEST_SYSADMIN_KEY).get("/v1/users")).body.data;
    expect(users.find((u: any) => u.email === "new@corp.example")).toMatchObject({ name: "new", providerLoginOnly: true });
    expect(await identities(app)).toEqual(["oid-invited", "oid-new"]);

    // A returning person is found by oid, whatever sub the app registration now gives.
    idp.next = { ...entraToken("oid-new", "new@corp.example"), sub: "another-pairwise-sub" };
    expect((await login(app)).html).toContain("Logged in as <strong>new</strong>");
    // Off the allowlist: refused.
    idp.next = entraToken("oid-out", "out@elsewhere.example");
    expect((await login(app)).html).toContain("There is no Yap account for this login");
  });

  it("with generic (no preset set), the same token is refused for invite and sign-up", async () => {
    const app = await boot({});
    for (const next of [entraToken("oid-invited", "invited@corp.example"), entraToken("oid-new", "new@corp.example")]) {
      idp.next = next;
      const { res, html } = await login(app);
      expect(res.status).toBe(400);
      expect(html).toContain("There is no Yap account for this login");
    }
    expect(await identities(app)).toEqual([]);
  });

  it("_EMAIL_CLAIM and _TRUST_EMAIL on generic admit the same token, keyed by sub", async () => {
    const app = await boot({ YAP_OIDC_TEST_EMAIL_CLAIM: "preferred_username", YAP_OIDC_TEST_TRUST_EMAIL: "true" });
    idp.next = entraToken("oid-invited", "invited@corp.example");
    expect((await login(app)).res.status).toBe(200);
    expect(await identities(app)).toEqual(["pairwise-oid-invited"]);
    // _TRUST_EMAIL alone, email still from `email`: a token without it gets no address.
    const trusted = await boot({ YAP_OIDC_TEST_TRUST_EMAIL: "true" });
    idp.next = entraToken("oid-new", "new@corp.example");
    expect((await login(trusted)).res.status).toBe(400);
    idp.next = { sub: "s-new", email: "new@corp.example" };
    expect((await login(trusted)).res.status).toBe(200);
  });

  it("the google preset applies the hd check on any issuer", async () => {
    const app = await boot({ YAP_OIDC_TEST_PRESET: "google" });
    idp.next = { sub: "g-1", email: "ann@corp.example", email_verified: true };
    expect((await login(app)).res.status).toBe(400);
    idp.next = { sub: "g-1", email: "ann@corp.example", email_verified: true, hd: "corp.example" };
    expect((await login(app)).res.status).toBe(200);
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
