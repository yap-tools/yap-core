/**
 * Account-level restrictions: the operator can deny a user `manage_keys`
 * and/or `create_spaces`. Set by the sysadmin on `POST /v1/users` and
 * `PATCH /v1/users/:id`, reported as `deniedCapabilities` on every user
 * representation and in whoami, and enforced in core — so identically over
 * REST and MCP, for access keys and OAuth tokens alike, and from the very next
 * operation on credentials and connections that already exist.
 */
import { afterAll, beforeAll, expect, it } from "vitest";

import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient, type ApiResponse } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp } from "../helpers/mcp.js";
import { connectApp } from "../helpers/oauth.js";

function expectDenied(res: ApiResponse, capability: string): void {
  expect(res.status).toBe(403);
  expect(res.body.error).toEqual({
    code: "forbidden",
    message: `account capability ${capability} is denied for this user`,
    details: { capability, decidedBy: "account_restriction" },
  });
}

describeEachAdapter("account restrictions", (adapter) => {
  let app: TestApp;
  let sysadmin: ApiClient;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
  });

  afterAll(async () => {
    await app.stop();
  });

  async function newUser(name: string, deniedCapabilities?: unknown) {
    const created = await sysadmin.post("/v1/users", {
      name,
      ...(deniedCapabilities !== undefined ? { deniedCapabilities } : {}),
    });
    expect(created.status).toBe(201);
    return {
      id: created.body.user.id as string,
      user: created.body.user,
      key: created.body.initialKey.key as string,
      initialKeyId: created.body.initialKey.id as string,
      personalSpaceId: created.body.personalSpaceId as string,
      client: apiClient(app.baseUrl, created.body.initialKey.key),
    };
  }

  const restrict = (userId: string, deniedCapabilities: unknown) =>
    sysadmin.patch(`/v1/users/${userId}`, { deniedCapabilities });

  async function storedUsers(): Promise<unknown[]> {
    const { users } = app.db.tables;
    return app.db.client.select().from(users);
  }

  // ---- Defaults ---------------------------------------------------------------

  it("a new user is unrestricted: nothing denied, and everything works as before", async () => {
    const user = await newUser("Default");
    expect(user.user.deniedCapabilities).toEqual([]);
    expect((await sysadmin.get(`/v1/users/${user.id}`)).body.deniedCapabilities).toEqual([]);
    expect((await user.client.get("/v1/whoami")).body).toEqual({
      id: user.id,
      name: "Default",
      externalId: null,
      deniedCapabilities: [],
    });

    expect((await user.client.post("/v1/keys", { name: "laptop" })).status).toBe(201);
    expect((await user.client.get("/v1/keys")).status).toBe(200);
    expect((await user.client.get("/v1/oauth/grants")).status).toBe(200);
    expect((await user.client.post("/v1/spaces", { name: "Mine" })).status).toBe(201);
  });

  // ---- The sysadmin sets, changes and clears ----------------------------------

  it("the sysadmin sets restrictions at creation; every user representation and whoami report them", async () => {
    // Given out of order and with a repeat: stored once each, in canonical order.
    const user = await newUser("Restricted", ["create_spaces", "manage_keys", "create_spaces"]);
    expect(user.user.deniedCapabilities).toEqual(["manage_keys", "create_spaces"]);
    expect((await sysadmin.get(`/v1/users/${user.id}`)).body.deniedCapabilities).toEqual([
      "manage_keys",
      "create_spaces",
    ]);
    const listed = (await sysadmin.get("/v1/users?limit=200")).body.data.find((u: any) => u.id === user.id);
    expect(listed.deniedCapabilities).toEqual(["manage_keys", "create_spaces"]);
    expect((await user.client.get("/v1/whoami")).body.deniedCapabilities).toEqual(["manage_keys", "create_spaces"]);

    const mcp = await connectMcp(app.baseUrl, user.key);
    try {
      expect((await mcp.call("whoami")).deniedCapabilities).toEqual(["manage_keys", "create_spaces"]);
    } finally {
      await mcp.close();
    }
  });

  it("the sysadmin updates and clears restrictions with PATCH; the list is replaced whole", async () => {
    const user = await newUser("Patched");

    const one = await restrict(user.id, ["create_spaces"]);
    expect(one.status).toBe(200);
    expect(one.body).toEqual({ ...user.user, deniedCapabilities: ["create_spaces"] });

    const other = await restrict(user.id, ["manage_keys"]);
    expect(other.body.deniedCapabilities).toEqual(["manage_keys"]);
    expect((await user.client.post("/v1/spaces", { name: "Back" })).status).toBe(201);
    expectDenied(await user.client.get("/v1/keys"), "manage_keys");

    const cleared = await restrict(user.id, []);
    expect(cleared.status).toBe(200);
    expect(cleared.body.deniedCapabilities).toEqual([]);
    expect((await user.client.get("/v1/whoami")).body.deniedCapabilities).toEqual([]);
    expect((await user.client.get("/v1/keys")).status).toBe(200);
  });

  it("PATCH on a user that does not exist is a 404", async () => {
    const res = await restrict("00000000-0000-0000-0000-000000000000", ["manage_keys"]);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("only the sysadmin may set or change restrictions", async () => {
    const user = await newUser("Self", ["manage_keys"]);
    const other = await newUser("Other");
    const { access_token } = await connectApp(app.baseUrl, other.key, "role:admin");

    for (const client of [user.client, other.client, apiClient(app.baseUrl, access_token), apiClient(app.baseUrl)]) {
      expect((await client.patch(`/v1/users/${user.id}`, { deniedCapabilities: [] })).status).toBe(401);
      expect((await client.post("/v1/users", { name: "Sneaky", deniedCapabilities: [] })).status).toBe(401);
    }
    expect((await sysadmin.get(`/v1/users/${user.id}`)).body.deniedCapabilities).toEqual(["manage_keys"]);
  });

  // ---- Invalid input ----------------------------------------------------------

  it("rejects unknown capabilities and malformed input without writing anything", async () => {
    const user = await newUser("Careful", ["create_spaces"]);
    const before = await storedUsers();

    const unknown = await restrict(user.id, ["manage_keys", "edit_items"]);
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("invalid_request");
    expect(unknown.body.error.details).toEqual({
      unknown: ["edit_items"],
      allowed: ["manage_keys", "create_spaces"],
    });

    for (const bad of ["manage_keys", null, { manage_keys: true }, [7], [["manage_keys"]], 1]) {
      expect((await restrict(user.id, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await sysadmin.patch(`/v1/users/${user.id}`, {})).status).toBe(400);
    // Nothing else about a user is patchable; an unknown field is refused, not ignored.
    expect((await sysadmin.patch(`/v1/users/${user.id}`, { deniedCapabilities: [], name: "x" })).status).toBe(400);

    for (const bad of [["nope"], "create_spaces", null]) {
      const res = await sysadmin.post("/v1/users", { name: "Never", deniedCapabilities: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }

    // The valid half of a rejected list was not applied, and no user was created.
    expect(await storedUsers()).toEqual(before);
    expect((await sysadmin.get(`/v1/users/${user.id}`)).body.deniedCapabilities).toEqual(["create_spaces"]);
  });

  // ---- manage_keys ------------------------------------------------------------

  it("manage_keys denies every self-service key and connected-app operation, and nothing else", async () => {
    const user = await newUser("NoKeys");
    const minted = await user.client.post("/v1/keys", { name: "laptop" });
    const { access_token } = await connectApp(app.baseUrl, user.key, "role:member");
    const grantId = (await user.client.get("/v1/oauth/grants")).body.data[0].id as string;

    await restrict(user.id, ["manage_keys"]);

    expectDenied(await user.client.post("/v1/keys", { name: "another" }), "manage_keys");
    expectDenied(await user.client.get("/v1/keys"), "manage_keys");
    expectDenied(await user.client.post(`/v1/keys/${minted.body.id}/rotate`), "manage_keys");
    expectDenied(await user.client.delete(`/v1/keys/${minted.body.id}`), "manage_keys");
    expectDenied(await user.client.get("/v1/oauth/grants"), "manage_keys");
    expectDenied(await user.client.delete(`/v1/oauth/grants/${grantId}`), "manage_keys");
    // A key id the user does not hold gives nothing away either.
    expectDenied(await user.client.delete("/v1/keys/not-a-key"), "manage_keys");

    // Nothing was revoked or changed by the refusals, or by the restriction itself.
    expect((await apiClient(app.baseUrl, minted.body.key).get("/v1/whoami")).status).toBe(200);
    expect((await apiClient(app.baseUrl, access_token).get("/v1/whoami")).status).toBe(200);
    expect((await sysadmin.get(`/v1/users/${user.id}/keys`)).body.data).toHaveLength(2);

    // Space creation is a separate capability.
    expect((await user.client.post("/v1/spaces", { name: "Still mine" })).status).toBe(201);
  });

  it("the self-served connections page refuses a manage_keys-restricted user too", async () => {
    const user = await newUser("NoPage");
    await connectApp(app.baseUrl, user.key, "role:member");
    const grantId = (await user.client.get("/v1/oauth/grants")).body.data[0].id as string;
    await restrict(user.id, ["manage_keys"]);

    const post = (path: string, form: Record<string, string>) =>
      fetch(`${app.baseUrl}${path}`, { method: "POST", body: new URLSearchParams(form) });

    const list = await post("/oauth/connections", { access_key: user.key });
    expect(list.status).toBe(403);
    const listHtml = await list.text();
    expect(listHtml).toContain("manage_keys is denied");
    expect(listHtml).not.toContain(grantId);

    const disconnect = await post("/oauth/connections/disconnect", { access_key: user.key, grant_id: grantId });
    expect(disconnect.status).toBe(403);
    expect(await disconnect.text()).toContain("manage_keys is denied");

    await restrict(user.id, []);
    expect((await user.client.get("/v1/oauth/grants")).body.data.map((g: any) => g.id)).toEqual([grantId]);
    expect((await post("/oauth/connections", { access_key: user.key })).status).toBe(200);
  });

  it("manage_keys leaves the OAuth protocol alone: a restricted user can connect an app, and the app can sign out", async () => {
    const user = await newUser("Connects", ["manage_keys"]);

    // Consent still issues a token — bound by the same denial, whatever its role.
    const app1 = await connectApp(app.baseUrl, user.key, "role:admin");
    const viaToken = apiClient(app.baseUrl, app1.access_token);
    expect((await viaToken.get("/v1/whoami")).body.id).toBe(user.id);
    expectDenied(await viaToken.post("/v1/keys", { name: "escalate" }), "manage_keys");

    // A narrower token is refused for its role first, as before.
    const member = apiClient(app.baseUrl, (await connectApp(app.baseUrl, user.key, "role:member")).access_token);
    expect((await member.get("/v1/keys")).body.error.message).toContain("admin scope");

    // RFC 7009: the app gives up its own refresh token, and with it the grant.
    const revoked = await fetch(`${app.baseUrl}/oauth/revoke`, {
      method: "POST",
      body: new URLSearchParams({ token: app1.refresh_token }),
    });
    expect(revoked.status).toBe(200);
    expect((await viaToken.get("/v1/whoami")).status).toBe(401);
  });

  it("the sysadmin key lane is unaffected: issue, list and revoke for a restricted user", async () => {
    const user = await newUser("Managed", ["manage_keys", "create_spaces"]);

    const issued = await sysadmin.post(`/v1/users/${user.id}/keys`, { name: "from-operator" });
    expect(issued.status).toBe(201);
    expect((await apiClient(app.baseUrl, issued.body.key).get("/v1/whoami")).body.id).toBe(user.id);

    const list = await sysadmin.get(`/v1/users/${user.id}/keys`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((k: any) => k.name).sort()).toEqual(["default", "from-operator"]);

    expect((await sysadmin.delete(`/v1/users/${user.id}/keys/${user.initialKeyId}`)).status).toBe(200);
    expect((await user.client.get("/v1/whoami")).status).toBe(401);
    // The operator-issued key is an ordinary key: just as restricted.
    expectDenied(await apiClient(app.baseUrl, issued.body.key).get("/v1/keys"), "manage_keys");
  });

  // ---- create_spaces ----------------------------------------------------------

  it("create_spaces denies space creation over REST and MCP, and nothing else", async () => {
    const user = await newUser("NoSpaces", ["create_spaces"]);
    const before = (await user.client.get("/v1/spaces")).body.data.length;

    expectDenied(await user.client.post("/v1/spaces", { name: "Nope" }), "create_spaces");

    const mcp = await connectMcp(app.baseUrl, user.key);
    try {
      const result = await mcp.callRaw("space_create", { name: "Nope" });
      expect(result.isError).toBe(true);
      const text = result.content[0].text as string;
      expect(text).toContain("forbidden: account capability create_spaces is denied for this user");
      expect(text).toContain('"capability":"create_spaces"');
    } finally {
      await mcp.close();
    }
    expect((await user.client.get("/v1/spaces")).body.data).toHaveLength(before);

    // Key management is a separate capability.
    expect((await user.client.get("/v1/keys")).status).toBe(200);
    expect((await user.client.post("/v1/keys", { name: "laptop" })).status).toBe(201);
  });

  // ---- OAuth tokens -----------------------------------------------------------

  it("an admin-scoped OAuth token cannot bypass restrictions, including one issued before they were set", async () => {
    const user = await newUser("Delegated");
    const { access_token } = await connectApp(app.baseUrl, user.key, "role:admin");
    const viaToken = apiClient(app.baseUrl, access_token);
    const minted = await viaToken.post("/v1/keys", { name: "via-token" });
    expect(minted.status).toBe(201);
    expect((await viaToken.post("/v1/spaces", { name: "Before" })).status).toBe(201);
    const grantId = (await viaToken.get("/v1/oauth/grants")).body.data[0].id as string;

    await restrict(user.id, ["manage_keys", "create_spaces"]);

    expectDenied(await viaToken.post("/v1/keys", { name: "more" }), "manage_keys");
    expectDenied(await viaToken.get("/v1/keys"), "manage_keys");
    expectDenied(await viaToken.post(`/v1/keys/${minted.body.id}/rotate`), "manage_keys");
    expectDenied(await viaToken.delete(`/v1/keys/${minted.body.id}`), "manage_keys");
    expectDenied(await viaToken.get("/v1/oauth/grants"), "manage_keys");
    expectDenied(await viaToken.delete(`/v1/oauth/grants/${grantId}`), "manage_keys");
    expectDenied(await viaToken.post("/v1/spaces", { name: "After" }), "create_spaces");
    expect((await viaToken.get("/v1/whoami")).body.deniedCapabilities).toEqual(["manage_keys", "create_spaces"]);

    // A token authorized while restricted is no different.
    const later = await connectApp(app.baseUrl, user.key, "role:admin");
    const viaLater = apiClient(app.baseUrl, later.access_token);
    expectDenied(await viaLater.post("/v1/keys", { name: "more" }), "manage_keys");
    expectDenied(await viaLater.post("/v1/spaces", { name: "After" }), "create_spaces");
  });

  it("clearing restrictions restores only what the token's role already allowed", async () => {
    const user = await newUser("Scoped", ["manage_keys", "create_spaces"]);
    const member = apiClient(app.baseUrl, (await connectApp(app.baseUrl, user.key, "role:member")).access_token);
    const readOnly = apiClient(app.baseUrl, (await connectApp(app.baseUrl, user.key, "role:read-only")).access_token);

    await restrict(user.id, []);

    // The member token still may not manage credentials; the read-only one may not write.
    const memberKeys = await member.get("/v1/keys");
    expect(memberKeys.status).toBe(403);
    expect(memberKeys.body.error.message).toContain("admin scope");
    expect((await member.post("/v1/spaces", { name: "Member space" })).status).toBe(201);
    const readOnlySpace = await readOnly.post("/v1/spaces", { name: "Read-only space" });
    expect(readOnlySpace.status).toBe(403);
    expect(readOnlySpace.body.error.message).toBe("this authorization is read-only");
    expect((await user.client.get("/v1/keys")).status).toBe(200);
  });

  // ---- Changes bind what already exists ---------------------------------------

  it("a changed restriction binds existing keys, tokens and connected MCP sessions at once", async () => {
    const user = await newUser("Live");
    const { access_token } = await connectApp(app.baseUrl, user.key, "role:admin");
    const viaToken = apiClient(app.baseUrl, access_token);
    const keySession = await connectMcp(app.baseUrl, user.key);
    const tokenSession = await connectMcp(app.baseUrl, access_token);
    try {
      expect((await keySession.call("space_create", { name: "One" })).name).toBe("One");
      expect((await tokenSession.call("space_create", { name: "Two" })).name).toBe("Two");
      expect((await keySession.call("whoami")).deniedCapabilities).toEqual([]);

      await restrict(user.id, ["create_spaces", "manage_keys"]);

      // Same sessions, same key, same token — no reconnect, nothing reissued.
      for (const session of [keySession, tokenSession]) {
        const result = await session.callRaw("space_create", { name: "Three" });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("account capability create_spaces is denied");
        expect((await session.call("whoami")).deniedCapabilities).toEqual(["manage_keys", "create_spaces"]);
      }
      expectDenied(await user.client.post("/v1/spaces", { name: "Three" }), "create_spaces");
      expectDenied(await viaToken.get("/v1/keys"), "manage_keys");

      await restrict(user.id, []);

      expect((await keySession.call("space_create", { name: "Four" })).name).toBe("Four");
      expect((await tokenSession.call("space_create", { name: "Five" })).name).toBe("Five");
      expect((await viaToken.get("/v1/keys")).status).toBe(200);
    } finally {
      await keySession.close();
      await tokenSession.close();
    }
  });

  // ---- What restrictions leave alone ------------------------------------------

  it("user docs and work in existing and other users' spaces are unchanged", async () => {
    const owner = await newUser("Owner");
    const user = await newUser("Worker");
    const ownSpace = (await user.client.post("/v1/spaces", { name: "Own" })).body.id as string;
    const shared = (await owner.client.post("/v1/spaces", { name: "Shared" })).body.id as string;
    const grant = await owner.client.post(`/v1/spaces/${shared}/grants`, {
      userId: user.id,
      capabilities: ["create_bundles", "edit_bundles", "edit_items", "read_items", "edit_docs"],
      effect: "allow",
    });
    expect(grant.status).toBe(201);

    await restrict(user.id, ["manage_keys", "create_spaces"]);

    // User docs: create, read, update, delete.
    const doc = await user.client.post("/v1/user-docs", { name: "notes", content: "hello" });
    expect(doc.status).toBe(201);
    expect((await user.client.get("/v1/user-docs")).body.data).toHaveLength(1);
    expect((await user.client.patch(`/v1/user-docs/${doc.body.id}`, { content: "edited" })).status).toBe(200);
    expect((await user.client.delete(`/v1/user-docs/${doc.body.id}`)).status).toBe(200);

    // The personal space, a space made before the restriction, and another user's space.
    for (const spaceId of [user.personalSpaceId, ownSpace, shared]) {
      const bundle = await user.client.post(`/v1/spaces/${spaceId}/bundles`, { name: "notes" });
      expect(bundle.status, spaceId).toBe(201);
      const itemType = await user.client.post(`/v1/bundles/${bundle.body.id}/item-types`, {
        name: "note",
        properties: [{ name: "title", datatype: "text" }],
      });
      expect(itemType.status).toBe(201);
      const items = await user.client.post(`/v1/bundles/${bundle.body.id}/items`, {
        itemType: "note",
        items: [{ title: "hello" }],
      });
      expect(items.status).toBe(201);
    }
    expect((await user.client.patch(`/v1/spaces/${ownSpace}`, { description: "still editable" })).status).toBe(200);
    const reachable = (await user.client.get("/v1/spaces")).body.data.map((s: any) => s.id);
    expect(reachable).toEqual(expect.arrayContaining([user.personalSpaceId, ownSpace, shared]));
    // Granting in a space the user manages is not credential management.
    const regrant = await user.client.post(`/v1/spaces/${ownSpace}/grants`, {
      userId: owner.id,
      capabilities: ["read_items"],
      effect: "allow",
    });
    expect(regrant.status).toBe(201);
    expect((await user.client.delete(`/v1/spaces/${ownSpace}`)).status).toBe(200);
  });

  // ---- Idempotent creation ----------------------------------------------------

  it("a repeated create with the same externalId stays side-effect-free: restrictions are not rewritten", async () => {
    const first = await sysadmin.post("/v1/users", {
      name: "Once",
      externalId: "ext-restricted",
      deniedCapabilities: ["manage_keys"],
    });
    expect(first.status).toBe(201);
    const before = await storedUsers();

    for (const deniedCapabilities of [undefined, [], ["create_spaces"]]) {
      const again = await sysadmin.post("/v1/users", {
        name: "Twice",
        externalId: "ext-restricted",
        ...(deniedCapabilities ? { deniedCapabilities } : {}),
      });
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ user: first.body.user, personalSpaceId: first.body.personalSpaceId });
      expect(again.body.user.deniedCapabilities).toEqual(["manage_keys"]);
    }
    // A malformed list is still malformed on a retry.
    const bad = await sysadmin.post("/v1/users", {
      name: "Twice",
      externalId: "ext-restricted",
      deniedCapabilities: ["nope"],
    });
    expect(bad.status).toBe(400);

    expect(await storedUsers()).toEqual(before);
    expect((await sysadmin.get(`/v1/users/${first.body.user.id}/keys`)).body.data).toHaveLength(1);
  });
});
