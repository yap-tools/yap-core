/**
 * REST/MCP parity: every per-resource role capability is exercisable over MCP,
 * gated by the same capability as REST. Hook authoring (edit_hooks) is the one
 * deliberate exception — defining a hook's transport stays REST-only.
 */
import { describe, expect, it } from "vitest";

import { CONTAINER_CAPABILITIES, CONTENT_CAPABILITIES } from "../../src/core/capabilities.js";
import { secondTier } from "../../src/mcp/call.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp, type McpTestClient } from "../helpers/mcp.js";

describe("capability coverage (drift guard)", () => {
  it("every role capability except edit_hooks is reachable as an MCP tool", () => {
    const viaCall = new Set(Object.values(secondTier).map((t) => t.capability));
    const reachable = new Set<string>([...viaCall, "create_bundles"]); // create_bundles → top-level bundle_create
    const REST_ONLY = new Set(["edit_hooks"]); // documented exception
    for (const cap of [...CONTENT_CAPABILITIES, ...CONTAINER_CAPABILITIES]) {
      if (REST_ONLY.has(cap)) continue;
      expect(reachable.has(cap), `${cap} should be reachable over MCP`).toBe(true);
    }
    // The exception really is absent from the MCP surface.
    expect(viaCall.has("edit_hooks")).toBe(false);
  });
});

describeEachAdapter("MCP management parity", (adapter) => {
  let app: TestApp;
  let sysadmin: ApiClient;
  let aliceRest: ApiClient;
  let alice: McpTestClient;
  let bob: McpTestClient;
  let bobId: string;
  let spaceId: string;
  let bundleId: string;

  const call = (client: McpTestClient, space: string, calls: unknown[]) =>
    client.call("call", { space_id: space, calls }).then((r) => r.results);
  const one = async (client: McpTestClient, space: string, c: unknown) => (await call(client, space, [c]))[0];

  async function setup() {
    app = await bootTestApp({}, await adapter.makeDb());
    sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    aliceRest = apiClient(app.baseUrl, a.body.initialKey.key);
    alice = await connectMcp(app.baseUrl, a.body.initialKey.key);
    const b = await sysadmin.post("/v1/users", { name: "Bob" });
    bobId = b.body.user.id;
    bob = await connectMcp(app.baseUrl, b.body.initialKey.key);
    spaceId = (await aliceRest.post("/v1/spaces", { name: "Work" })).body.id;
    bundleId = (await aliceRest.post(`/v1/spaces/${spaceId}/bundles`, { name: "b" })).body.id;
  }

  it("manage_space: owner can update/`delete the space over MCP; a non-member cannot", async () => {
    await setup();
    try {
      // Alice owns the space → manage_space. Space-scoped call omits bundle_id.
      const updated = await one(alice, spaceId, { tool: "update_space", params: { description: "via MCP" } });
      expect(updated.ok).toBe(true);
      expect(updated.result.description).toBe("via MCP");

      // Bob (no grant) cannot even reach the space.
      await expect(call(bob, spaceId, [{ tool: "update_space", params: { name: "x" } }])).rejects.toThrow(
        /not_found/,
      );

      // Scope guard: a space tool with a bundle_id is rejected.
      const misScoped = await one(alice, spaceId, {
        bundle_id: bundleId,
        tool: "update_space",
        params: { name: "x" },
      });
      expect(misScoped.ok).toBe(false);
      expect(misScoped.error.message).toMatch(/operates on a space/);

      // A throwaway space Alice can actually delete over MCP.
      const tmp = (await aliceRest.post("/v1/spaces", { name: "Temp" })).body.id;
      const del = await one(alice, tmp, { tool: "delete_space" });
      expect(del.ok).toBe(true);
      expect((await aliceRest.get(`/v1/spaces/${tmp}`)).status).toBe(404);
    } finally {
      await alice.close();
      await bob.close();
      await app.stop();
    }
  });

  it("manage_roles: grant/list/revoke over MCP at both space and bundle scope", async () => {
    await setup();
    try {
      // Space-scoped grant (omit bundle_id).
      const granted = await one(alice, spaceId, {
        tool: "grant_role",
        params: { user_id: bobId, capabilities: ["read_items"], effect: "allow" },
      });
      expect(granted.ok).toBe(true);
      expect(granted.result.data).toHaveLength(1);

      // Bundle-scoped grant (provide bundle_id).
      const bundleGrant = await one(alice, spaceId, {
        bundle_id: bundleId,
        tool: "grant_role",
        params: { user_id: bobId, capability: "edit_items", effect: "allow" },
      });
      expect(bundleGrant.ok).toBe(true);

      // list_grants reflects both scopes.
      const spaceGrants = await one(alice, spaceId, { tool: "list_grants" });
      expect(spaceGrants.result.data.some((g: any) => g.userId === bobId && g.capability === "read_items")).toBe(
        true,
      );
      const bundleGrants = await one(alice, spaceId, { bundle_id: bundleId, tool: "list_grants" });
      expect(bundleGrants.result.data.some((g: any) => g.capability === "edit_items")).toBe(true);

      // Bob (now read_items at space) can query but cannot grant — manage_roles gate.
      const bobTries = await one(bob, spaceId, {
        tool: "grant_role",
        params: { user_id: bobId, capability: "manage_roles", effect: "allow" },
      });
      expect(bobTries.ok).toBe(false);
      expect(bobTries.error.details.capability).toBe("manage_roles");

      // Revoke the bundle grant by id.
      const revoke = await one(alice, spaceId, {
        bundle_id: bundleId,
        tool: "revoke_grant",
        params: { grant_id: bundleGrant.result.data[0].id },
      });
      expect(revoke.ok).toBe(true);
    } finally {
      await alice.close();
      await bob.close();
      await app.stop();
    }
  });

  it("edit_bundles: full schema authoring + bundle update/delete over MCP, gated", async () => {
    await setup();
    try {
      // Create an item-type, add a (multi) property, write & query — all over MCP.
      const type = await one(alice, spaceId, {
        bundle_id: bundleId,
        tool: "create_item_type",
        params: { name: "task", properties: [{ name: "title", datatype: "text", required: true }] },
      });
      expect(type.ok).toBe(true);
      const typeId = type.result.id;

      const prop = await one(alice, spaceId, {
        bundle_id: bundleId,
        tool: "add_property",
        params: { item_type_id: typeId, name: "tags", datatype: "text", multi: true },
      });
      expect(prop.ok).toBe(true);

      const write = await one(alice, spaceId, {
        bundle_id: bundleId,
        tool: "create_items",
        params: { item_type: "task", items: [{ title: "Ship", tags: ["urgent", "v1"] }] },
      });
      expect(write.ok).toBe(true);
      expect(write.result[0].values.tags).toEqual(["urgent", "v1"]);

      // Rename the property, then delete it.
      const renamed = await one(alice, spaceId, {
        bundle_id: bundleId,
        tool: "update_property",
        params: { item_type_id: typeId, property_id: prop.result.id, name: "labels" },
      });
      expect(renamed.ok).toBe(true);
      expect(renamed.result.name).toBe("labels");
      expect(
        (await one(alice, spaceId, {
          bundle_id: bundleId,
          tool: "delete_property",
          params: { item_type_id: typeId, property_id: prop.result.id },
        })).ok,
      ).toBe(true);

      // update_bundle.
      const ub = await one(alice, spaceId, {
        bundle_id: bundleId,
        tool: "update_bundle",
        params: { description: "managed over MCP" },
      });
      expect(ub.ok).toBe(true);
      expect(ub.result.description).toBe("managed over MCP");

      // Scope guard: a bundle tool without bundle_id is rejected.
      const misScoped = await one(alice, spaceId, { tool: "update_bundle", params: { name: "x" } });
      expect(misScoped.ok).toBe(false);
      expect(misScoped.error.message).toMatch(/operates on a bundle/);

      // Gate: Bob with only read access cannot author schema.
      await aliceRest.post(`/v1/bundles/${bundleId}/grants`, {
        userId: bobId,
        capabilities: ["read_items"],
        effect: "allow",
      });
      const denied = await one(bob, spaceId, {
        bundle_id: bundleId,
        tool: "add_property",
        params: { item_type_id: typeId, name: "x", datatype: "text" },
      });
      expect(denied.ok).toBe(false);
      expect(denied.error.details.capability).toBe("edit_bundles");

      // delete_bundle over MCP.
      const tmpBundle = (await aliceRest.post(`/v1/spaces/${spaceId}/bundles`, { name: "tmp" })).body.id;
      const del = await one(alice, spaceId, { bundle_id: tmpBundle, tool: "delete_bundle" });
      expect(del.ok).toBe(true);
      expect((await aliceRest.get(`/v1/bundles/${tmpBundle}`)).status).toBe(404);
    } finally {
      await alice.close();
      await bob.close();
      await app.stop();
    }
  });

  it("load_bundle surfaces property ids so delete_property is usable end-to-end over MCP", async () => {
    await setup();
    try {
      // Author a schema, then discover the property id purely from load_bundle.
      await one(alice, spaceId, {
        bundle_id: bundleId,
        tool: "create_item_type",
        params: {
          name: "loan",
          properties: [
            { name: "book_title", datatype: "text", required: true },
            { name: "borrowed_by", datatype: "text", required: true },
          ],
        },
      });

      const loaded = await alice.call("load_bundle", { bundle_ids: [bundleId] });
      const type = loaded.bundles[0].item_types.find((t: any) => t.name === "loan");
      const target = type.properties.find((p: any) => p.name === "borrowed_by");
      expect(target.id).toEqual(expect.any(String));

      // Delete it using only the id from load_bundle.
      const del = await one(alice, spaceId, {
        bundle_id: bundleId,
        tool: "delete_property",
        params: { item_type_id: type.id, property_id: target.id },
      });
      expect(del.ok).toBe(true);

      // It no longer appears on reload.
      const reloaded = await alice.call("load_bundle", { bundle_ids: [bundleId] });
      const names = reloaded.bundles[0].item_types
        .find((t: any) => t.name === "loan")
        .properties.map((p: any) => p.name);
      expect(names).toEqual(["book_title"]);
    } finally {
      await alice.close();
      await bob.close();
      await app.stop();
    }
  });

  it("hook authoring is NOT exposed over MCP (the documented exception)", async () => {
    await setup();
    try {
      for (const tool of ["create_hook", "update_hook", "delete_hook"]) {
        const res = await one(alice, spaceId, { bundle_id: bundleId, tool, params: {} });
        expect(res.ok).toBe(false);
        expect(res.error.message).toContain("unknown tool");
      }
      // But firing remains available.
      const tools = await alice.client.listTools();
      expect(tools.tools.map((t) => t.name)).not.toContain("create_hook");
    } finally {
      await alice.close();
      await bob.close();
      await app.stop();
    }
  });
});
