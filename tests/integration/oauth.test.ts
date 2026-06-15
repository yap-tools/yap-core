/**
 * End-to-end OAuth 2.1: discovery, dynamic client registration, the
 * key-authenticated consent screen, code + PKCE exchange, scope clamping on
 * both REST and MCP, refresh rotation with reuse detection, and every
 * revocation lever (RFC 7009, connected-app disconnect, key revocation).
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp } from "../helpers/mcp.js";

const REDIRECT_URI = "https://app.example/callback";

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function registerClient(baseUrl: string, name = "Test App", redirectUris = [REDIRECT_URI]) {
  const res = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: redirectUris }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

interface AuthorizeInput {
  clientId: string;
  key: string;
  challenge: string;
  scope?: string;
  redirectUri?: string;
  decision?: string;
  state?: string;
  /** The consent screen's role picker; omitted = whatever the request preselected. */
  role?: string;
}

async function postAuthorize(baseUrl: string, input: AuthorizeInput): Promise<Response> {
  const form = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri ?? REDIRECT_URI,
    scope: input.scope ?? "",
    state: input.state ?? "st4te",
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    access_key: input.key,
    decision: input.decision ?? "approve",
    ...(input.role !== undefined ? { role: input.role } : {}),
  });
  return fetch(`${baseUrl}/oauth/authorize`, { method: "POST", body: form, redirect: "manual" });
}

async function tokenRequest(baseUrl: string, params: Record<string, string>) {
  const res = await fetch(`${baseUrl}/oauth/token`, { method: "POST", body: new URLSearchParams(params) });
  return { status: res.status, body: (await res.json()) as any };
}

/** Runs the whole code+PKCE flow and returns the first token pair. */
async function connectApp(baseUrl: string, key: string, scope = "") {
  const client = await registerClient(baseUrl);
  const { verifier, challenge } = pkce();
  const authz = await postAuthorize(baseUrl, { clientId: client.body.client_id, key, challenge, scope });
  expect(authz.status).toBe(302);
  const redirect = new URL(authz.headers.get("location")!);
  const code = redirect.searchParams.get("code")!;
  expect(code).toBeTruthy();
  const token = await tokenRequest(baseUrl, {
    grant_type: "authorization_code",
    client_id: client.body.client_id,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  });
  expect(token.status).toBe(200);
  const body = token.body as { access_token: string; refresh_token: string; scope: string };
  return { clientId: client.body.client_id as string, ...body };
}

describeEachAdapter("oauth", (adapter) => {
  let app: TestApp;
  let sysadmin: ApiClient;
  let aliceKey: string;
  let aliceId: string;
  let alice: ApiClient;
  let personalSpaceId: string;
  let bundleId: string;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const created = await sysadmin.post("/v1/users", { name: "Alice" });
    aliceId = created.body.user.id;
    aliceKey = created.body.initialKey.key;
    personalSpaceId = created.body.personalSpaceId;
    alice = apiClient(app.baseUrl, aliceKey);
    const bundle = await alice.post(`/v1/spaces/${personalSpaceId}/bundles`, { name: "notes" });
    bundleId = bundle.body.id;
    await alice.post(`/v1/bundles/${bundleId}/item-types`, {
      name: "note",
      properties: [{ name: "title", datatype: "text" }],
    });
    await alice.post(`/v1/bundles/${bundleId}/items`, { itemType: "note", items: [{ title: "hello" }] });
  });

  afterAll(async () => {
    await app.stop();
  });

  describe("discovery", () => {
    it("serves RFC 8414 authorization-server metadata (also at the /mcp suffix)", async () => {
      for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"]) {
        const res = await fetch(`${app.baseUrl}${path}`);
        expect(res.status).toBe(200);
        const doc = (await res.json()) as any;
        expect(doc.issuer).toBe(app.baseUrl);
        expect(doc.authorization_endpoint).toBe(`${app.baseUrl}/oauth/authorize`);
        expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
        expect(doc.token_endpoint_auth_methods_supported).toEqual(["none"]);
      }
    });

    it("serves RFC 9728 protected-resource metadata pointing at this instance", async () => {
      const res = await fetch(`${app.baseUrl}/.well-known/oauth-protected-resource/mcp`);
      const doc = (await res.json()) as any;
      expect(doc.resource).toBe(`${app.baseUrl}/mcp`);
      expect(doc.authorization_servers).toEqual([app.baseUrl]);
    });

    it("unauthenticated MCP requests get the resource_metadata pointer", async () => {
      const res = await fetch(`${app.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain(
        `resource_metadata="${app.baseUrl}/.well-known/oauth-protected-resource/mcp"`,
      );
    });
  });

  describe("dynamic client registration", () => {
    it("registers a public client", async () => {
      const res = await registerClient(app.baseUrl, "My App");
      expect(res.status).toBe(201);
      expect(res.body.client_id).toBeTruthy();
      expect(res.body.token_endpoint_auth_method).toBe("none");
      expect(res.body).not.toHaveProperty("client_secret");
    });

    it("rejects missing or non-loopback http redirect URIs", async () => {
      expect((await registerClient(app.baseUrl, "Bad", [])).status).toBe(400);
      expect((await registerClient(app.baseUrl, "Bad", ["http://app.example/cb"])).status).toBe(400);
      expect((await registerClient(app.baseUrl, "Native", ["http://127.0.0.1/cb"])).status).toBe(201);
    });
  });

  describe("authorize screen", () => {
    it("renders consent for a valid request and an error page for an unknown client", async () => {
      const client = await registerClient(app.baseUrl, "Consent App");
      const { challenge } = pkce();
      const url =
        `${app.baseUrl}/oauth/authorize?response_type=code&client_id=${client.body.client_id}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256`;
      const page = await fetch(url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Consent App");
      // The user picks the delegated role on the screen itself.
      expect(html).toContain('name="role"');
      // Branded like every self-served page.
      expect(html).toContain('class="brand"');

      const unknown = await fetch(url.replace(client.body.client_id, "nope"));
      expect(unknown.status).toBe(400);
      expect(await unknown.text()).toContain("not registered");
    });

    it("never redirects to an unregistered redirect_uri", async () => {
      const client = await registerClient(app.baseUrl);
      const { challenge } = pkce();
      const res = await postAuthorize(app.baseUrl, {
        clientId: client.body.client_id,
        key: aliceKey,
        challenge,
        redirectUri: "https://evil.example/cb",
      });
      expect(res.status).toBe(400);
    });

    it("requires PKCE", async () => {
      const client = await registerClient(app.baseUrl);
      const res = await postAuthorize(app.baseUrl, { clientId: client.body.client_id, key: aliceKey, challenge: "" });
      expect(res.status).toBe(302);
      const redirect = new URL(res.headers.get("location")!);
      expect(redirect.searchParams.get("error")).toBe("invalid_request");
    });

    it("re-renders on a bad key and refuses the sysadmin key", async () => {
      const client = await registerClient(app.baseUrl);
      const { challenge } = pkce();
      for (const key of ["yap_not_a_real_key", TEST_SYSADMIN_KEY]) {
        const res = await postAuthorize(app.baseUrl, { clientId: client.body.client_id, key, challenge });
        expect(res.status).toBe(401);
        expect(res.headers.get("location")).toBeNull();
      }
    });

    it("deny sends access_denied and no code", async () => {
      const client = await registerClient(app.baseUrl);
      const { challenge } = pkce();
      const res = await postAuthorize(app.baseUrl, {
        clientId: client.body.client_id,
        key: aliceKey,
        challenge,
        decision: "deny",
      });
      expect(res.status).toBe(302);
      const redirect = new URL(res.headers.get("location")!);
      expect(redirect.searchParams.get("error")).toBe("access_denied");
      expect(redirect.searchParams.get("code")).toBeNull();
      expect(redirect.searchParams.get("state")).toBe("st4te");
    });

    it("lets the user grant a different role than the client requested (RFC 6749 §3.3)", async () => {
      const client = await registerClient(app.baseUrl);
      const { verifier, challenge } = pkce();
      // Client asks for read-only; the user bumps the grant to member.
      const authz = await postAuthorize(app.baseUrl, {
        clientId: client.body.client_id,
        key: aliceKey,
        challenge,
        scope: "role:read-only",
        role: "member",
      });
      expect(authz.status).toBe(302);
      const code = new URL(authz.headers.get("location")!).searchParams.get("code")!;
      const token = await tokenRequest(app.baseUrl, {
        grant_type: "authorization_code",
        client_id: client.body.client_id,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      });
      expect(token.status).toBe(200);
      expect(token.body.scope).toBe("role:member");
      const api = apiClient(app.baseUrl, token.body.access_token);
      const write = await api.post(`/v1/bundles/${bundleId}/items`, { itemType: "note", items: [{ title: "upgraded" }] });
      expect(write.status).toBe(201);
    });

    it("matches loopback redirects across ports (RFC 8252)", async () => {
      const client = await registerClient(app.baseUrl, "Native", ["http://127.0.0.1/cb"]);
      const { verifier, challenge } = pkce();
      const presented = "http://127.0.0.1:54321/cb";
      const authz = await postAuthorize(app.baseUrl, {
        clientId: client.body.client_id,
        key: aliceKey,
        challenge,
        redirectUri: presented,
      });
      expect(authz.status).toBe(302);
      const code = new URL(authz.headers.get("location")!).searchParams.get("code")!;
      const token = await tokenRequest(app.baseUrl, {
        grant_type: "authorization_code",
        client_id: client.body.client_id,
        code,
        code_verifier: verifier,
        redirect_uri: presented,
      });
      expect(token.status).toBe(200);
    });
  });

  describe("token endpoint", () => {
    it("exchanges a code for a working token pair (state and iss ride the redirect)", async () => {
      const client = await registerClient(app.baseUrl);
      const { verifier, challenge } = pkce();
      const authz = await postAuthorize(app.baseUrl, { clientId: client.body.client_id, key: aliceKey, challenge });
      const redirect = new URL(authz.headers.get("location")!);
      expect(redirect.searchParams.get("state")).toBe("st4te");
      expect(redirect.searchParams.get("iss")).toBe(app.baseUrl);

      const token = await tokenRequest(app.baseUrl, {
        grant_type: "authorization_code",
        client_id: client.body.client_id,
        code: redirect.searchParams.get("code")!,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      });
      expect(token.status).toBe(200);
      expect(token.body.access_token).toMatch(/^yap_at_/);
      expect(token.body.refresh_token).toMatch(/^yap_rt_/);
      expect(token.body.token_type).toBe("Bearer");
      expect(token.body.scope).toBe("role:member");

      const api = apiClient(app.baseUrl, token.body.access_token);
      expect((await api.get("/v1/spaces")).status).toBe(200);
    });

    it("access tokens report the underlying user through whoami", async () => {
      const { access_token } = await connectApp(app.baseUrl, aliceKey);
      const res = await apiClient(app.baseUrl, access_token).get("/v1/whoami");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: aliceId, name: "Alice" });
      expect(Object.keys(res.body).sort()).toEqual(["id", "name"]);
    });

    it("rejects a wrong PKCE verifier and burns the code on first use", async () => {
      const client = await registerClient(app.baseUrl);
      const { verifier, challenge } = pkce();
      const authz = await postAuthorize(app.baseUrl, { clientId: client.body.client_id, key: aliceKey, challenge });
      const code = new URL(authz.headers.get("location")!).searchParams.get("code")!;
      const base = { grant_type: "authorization_code", client_id: client.body.client_id, code, redirect_uri: REDIRECT_URI };

      const bad = await tokenRequest(app.baseUrl, { ...base, code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier" });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe("invalid_grant");
      // The code was consumed by the failed attempt: a replay with the right
      // verifier finds nothing.
      const replay = await tokenRequest(app.baseUrl, { ...base, code_verifier: verifier });
      expect(replay.status).toBe(400);
    });

    it("rejects redirect_uri and client mismatches and unknown grant types", async () => {
      const clientA = await registerClient(app.baseUrl);
      const clientB = await registerClient(app.baseUrl);
      const { verifier, challenge } = pkce();
      const authz = await postAuthorize(app.baseUrl, { clientId: clientA.body.client_id, key: aliceKey, challenge });
      const code = new URL(authz.headers.get("location")!).searchParams.get("code")!;
      const stolen = await tokenRequest(app.baseUrl, {
        grant_type: "authorization_code",
        client_id: clientB.body.client_id,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      });
      expect(stolen.status).toBe(400);
      expect(stolen.body.error).toBe("invalid_grant");

      expect((await tokenRequest(app.baseUrl, { grant_type: "password", client_id: clientA.body.client_id })).body.error).toBe(
        "unsupported_grant_type",
      );
      expect((await tokenRequest(app.baseUrl, { grant_type: "authorization_code", client_id: "ghost" })).body.error).toBe(
        "invalid_client",
      );
    });

    it("rotates refresh tokens and kills the grant on reuse", async () => {
      const { clientId, access_token, refresh_token } = await connectApp(app.baseUrl, aliceKey);
      const refreshed = await tokenRequest(app.baseUrl, {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token,
      });
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.refresh_token).not.toBe(refresh_token);

      // Replaying the rotated refresh token is treated as theft: the whole
      // grant dies, including the fresh tokens.
      const reuse = await tokenRequest(app.baseUrl, {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token,
      });
      expect(reuse.status).toBe(400);
      expect((await apiClient(app.baseUrl, refreshed.body.access_token).get("/v1/spaces")).status).toBe(401);
      expect((await apiClient(app.baseUrl, access_token).get("/v1/spaces")).status).toBe(401);
    });
  });

  describe("scope clamping", () => {
    it("read-only tokens read but never write — even in the personal space", async () => {
      const { access_token } = await connectApp(app.baseUrl, aliceKey, "role:read-only");
      const api = apiClient(app.baseUrl, access_token);
      const read = await api.get(`/v1/bundles/${bundleId}/items?itemType=note`);
      expect(read.status).toBe(200);
      expect(read.body.data.length).toBeGreaterThan(0);

      expect((await api.post(`/v1/bundles/${bundleId}/items`, { itemType: "note", items: [{ title: "nope" }] })).status).toBe(403);
      expect((await api.post("/v1/spaces", { name: "Sneaky" })).status).toBe(403);
      expect((await api.post("/v1/user-docs", { name: "doc" })).status).toBe(403);
    });

    it("member tokens (the default) handle content but cannot manage credentials", async () => {
      const { access_token } = await connectApp(app.baseUrl, aliceKey);
      const api = apiClient(app.baseUrl, access_token);
      const write = await api.post(`/v1/bundles/${bundleId}/items`, { itemType: "note", items: [{ title: "from token" }] });
      expect(write.status).toBe(201);

      expect((await api.post("/v1/keys", { name: "escalation" })).status).toBe(403);
      expect((await api.get("/v1/keys")).status).toBe(403);
      expect((await api.get("/v1/oauth/grants")).status).toBe(403);
    });

    it("admin tokens are full delegations", async () => {
      const { access_token } = await connectApp(app.baseUrl, aliceKey, "role:admin");
      const api = apiClient(app.baseUrl, access_token);
      expect((await api.get("/v1/keys")).status).toBe(200);
      expect((await api.get("/v1/oauth/grants")).status).toBe(200);
    });

    it("resource-restricted tokens cannot leave their spaces", async () => {
      const other = await alice.post("/v1/spaces", { name: "Work" });
      const workBundle = await alice.post(`/v1/spaces/${other.body.id}/bundles`, { name: "tasks" });
      const { access_token } = await connectApp(app.baseUrl, aliceKey, `role:member space:${other.body.id}`);
      const api = apiClient(app.baseUrl, access_token);

      expect((await api.get(`/v1/spaces/${other.body.id}/bundles`)).status).toBe(200);
      expect((await api.get(`/v1/bundles/${workBundle.body.id}`)).status).toBe(200);
      // The personal space's bundle is outside the restriction.
      expect((await api.get(`/v1/bundles/${bundleId}/items?itemType=note`)).status).toBe(403);
    });

    it("the clamp reaches MCP: load reports the delegated role", async () => {
      const { access_token } = await connectApp(app.baseUrl, aliceKey, "role:read-only");
      const mcp = await connectMcp(app.baseUrl, access_token);
      try {
        const result = await mcp.call("load");
        const personal = result.spaces.find((s: any) => s.id === personalSpaceId);
        expect(personal.role).toEqual(["read_files", "read_items"]);
      } finally {
        await mcp.close();
      }
    });
  });

  describe("revocation", () => {
    it("RFC 7009: revoking the refresh token tears down the grant", async () => {
      const { access_token, refresh_token } = await connectApp(app.baseUrl, aliceKey);
      const res = await fetch(`${app.baseUrl}/oauth/revoke`, {
        method: "POST",
        body: new URLSearchParams({ token: refresh_token }),
      });
      expect(res.status).toBe(200);
      expect((await apiClient(app.baseUrl, access_token).get("/v1/spaces")).status).toBe(401);
    });

    it("disconnecting a client kills its tokens and leaves the key alone", async () => {
      const { clientId, access_token } = await connectApp(app.baseUrl, aliceKey);
      const grants = await alice.get("/v1/oauth/grants");
      expect(grants.status).toBe(200);
      const grant = grants.body.data.find((g: any) => g.client.id === clientId);
      expect(grant.scope).toBe("role:member");

      expect((await alice.delete(`/v1/oauth/grants/${grant.id}`)).status).toBe(200);
      expect((await apiClient(app.baseUrl, access_token).get("/v1/spaces")).status).toBe(401);
      expect((await alice.get("/v1/spaces")).status).toBe(200);
    });

    it("revoking the authorizing key kills every grant made with it", async () => {
      const created = await sysadmin.post("/v1/users", { name: "Bob" });
      const bobKey = created.body.initialKey.key;
      const bob = apiClient(app.baseUrl, bobKey);
      const { access_token } = await connectApp(app.baseUrl, bobKey);
      expect((await apiClient(app.baseUrl, access_token).get("/v1/spaces")).status).toBe(200);

      const rotated = await bob.post(`/v1/keys/${created.body.initialKey.id}/rotate`);
      expect(rotated.status).toBe(200);
      expect((await apiClient(app.baseUrl, access_token).get("/v1/spaces")).status).toBe(401);
      // The rotated key itself still works — only the delegations died.
      expect((await apiClient(app.baseUrl, rotated.body.key).get("/v1/spaces")).status).toBe(200);
    });
  });

  describe("connections page", () => {
    it("prompts for a key, lists connections, and disconnects one", async () => {
      const { clientId, access_token } = await connectApp(app.baseUrl, aliceKey);

      const prompt = await fetch(`${app.baseUrl}/oauth/connections`);
      expect(prompt.status).toBe(200);
      const promptHtml = await prompt.text();
      expect(promptHtml).toContain("Show connections");
      expect(promptHtml).toContain('class="brand"');

      const list = await fetch(`${app.baseUrl}/oauth/connections`, {
        method: "POST",
        body: new URLSearchParams({ access_key: aliceKey }),
      });
      expect(list.status).toBe(200);
      const listHtml = await list.text();
      expect(listHtml).toContain("Test App");
      expect(listHtml).toContain("Disconnect");

      const grants = await alice.get("/v1/oauth/grants");
      const grant = grants.body.data.find((g: any) => g.client.id === clientId);
      const disconnected = await fetch(`${app.baseUrl}/oauth/connections/disconnect`, {
        method: "POST",
        body: new URLSearchParams({ access_key: aliceKey, grant_id: grant.id }),
      });
      expect(disconnected.status).toBe(200);
      expect(await disconnected.text()).toContain("tokens are revoked");
      expect((await apiClient(app.baseUrl, access_token).get("/v1/spaces")).status).toBe(401);
    });

    it("rejects invalid keys and the sysadmin key", async () => {
      for (const key of ["yap_bogus", TEST_SYSADMIN_KEY]) {
        const res = await fetch(`${app.baseUrl}/oauth/connections`, {
          method: "POST",
          body: new URLSearchParams({ access_key: key }),
        });
        expect(res.status).toBe(401);
      }
    });
  });

  it("token lane works over MCP end to end", async () => {
    const { access_token } = await connectApp(app.baseUrl, aliceKey);
    const mcp = await connectMcp(app.baseUrl, access_token);
    try {
      const identity = await mcp.call("whoami");
      expect(identity).toEqual({ id: aliceId, name: "Alice" });
      expect(Object.keys(identity).sort()).toEqual(["id", "name"]);

      const result = await mcp.call("load");
      expect(result.spaces.some((s: any) => s.id === personalSpaceId)).toBe(true);
    } finally {
      await mcp.close();
    }
  });
});
