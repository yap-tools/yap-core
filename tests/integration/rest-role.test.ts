/**
 * REST reports the caller's capabilities as `role` on spaces and bundles, from
 * the same core function MCP uses, so the two transports agree.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp } from "../helpers/mcp.js";
import { connectApp } from "../helpers/oauth.js";

describeEachAdapter("REST role reporting", (adapter) => {
  let app: TestApp;
  let alice: ApiClient;
  let aliceKey: string;
  let bob: ApiClient;
  let bobKey: string;
  let bobId: string;
  let alicePersonalId: string;
  let workId: string;
  let sharedBundleId: string;
  let privateBundleId: string;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    const b = await sysadmin.post("/v1/users", { name: "Bob" });
    aliceKey = a.body.initialKey.key;
    bobKey = b.body.initialKey.key;
    bobId = b.body.user.id;
    alicePersonalId = a.body.personalSpaceId;
    alice = apiClient(app.baseUrl, aliceKey);
    bob = apiClient(app.baseUrl, bobKey);
    workId = (await alice.post("/v1/spaces", { name: "Work" })).body.id;
    sharedBundleId = (await alice.post(`/v1/spaces/${workId}/bundles`, { name: "shared" })).body.id;
    privateBundleId = (await alice.post(`/v1/spaces/${workId}/bundles`, { name: "private" })).body.id;
    // Bob holds a grant on one bundle only, none on the space.
    await alice.post(`/v1/bundles/${sharedBundleId}/grants`, {
      userId: bobId,
      capabilities: ["read_items", "edit_items"],
      effect: "allow",
    });
  });

  afterAll(async () => {
    await app.stop();
  });

  it("equals what MCP load / load_space / load_bundle report, for the owner and a bundle-only member", async () => {
    for (const key of [aliceKey, bobKey]) {
      const rest = apiClient(app.baseUrl, key);
      const mcp = await connectMcp(app.baseUrl, key);
      try {
        const load = await mcp.call("load");
        const restSpaces = (await rest.get("/v1/spaces")).body.data;
        expect(restSpaces.length).toBeGreaterThan(0);
        for (const s of restSpaces) {
          expect(Array.isArray(s.role)).toBe(true);
          expect(s.role).toEqual(load.spaces.find((m: any) => m.id === s.id).role);
          const one = (await rest.get(`/v1/spaces/${s.id}`)).body;
          expect(one.role).toEqual(s.role);
          expect(one.role).toEqual((await mcp.call("load_space", { space_id: s.id })).role);
          const restBundles = (await rest.get(`/v1/spaces/${s.id}/bundles`)).body.data;
          for (const b of restBundles) {
            const detail = (await rest.get(`/v1/bundles/${b.id}`)).body;
            const viaMcp = (await mcp.call("load_bundle", { bundle_ids: [b.id] })).bundles[0];
            expect(b.role).toEqual(detail.role);
            expect(detail.role).toEqual(viaMcp.role);
          }
        }
      } finally {
        await mcp.close();
      }
    }
  });

  it("a bundle-only grant shows [] on the space and the granted set on the bundle", async () => {
    const space = (await bob.get(`/v1/spaces/${workId}`)).body;
    expect(space.role).toEqual([]);
    const listed = (await bob.get("/v1/spaces")).body.data.find((s: any) => s.id === workId);
    expect(listed.role).toEqual([]);
    const bundles = (await bob.get(`/v1/spaces/${workId}/bundles`)).body.data;
    expect(bundles.map((b: any) => b.id)).toEqual([sharedBundleId]);
    expect(bundles[0].role).toEqual(["edit_items", "read_items"]);
    expect((await bob.get(`/v1/bundles/${sharedBundleId}`)).body.role).toEqual(["edit_items", "read_items"]);
    expect((await bob.get(`/v1/bundles/${privateBundleId}`)).status).toBe(404);
  });

  it("applies an OAuth token's role scope", async () => {
    const { access_token } = await connectApp(app.baseUrl, aliceKey, "role:read-only");
    const api = apiClient(app.baseUrl, access_token);
    const personal = (await api.get(`/v1/spaces/${alicePersonalId}`)).body;
    expect(personal.role).toEqual(["read_files", "read_items"]);
    const work = (await api.get("/v1/spaces")).body.data.find((s: any) => s.id === workId);
    expect(work.role).toEqual(["read_files", "read_items"]);
    const bundle = (await api.get(`/v1/bundles/${sharedBundleId}`)).body;
    expect(bundle.role).toEqual(["read_files", "read_items"]);
  });

  it("applies an OAuth token's space limit: other spaces and bundles are unreachable or empty", async () => {
    const { access_token } = await connectApp(app.baseUrl, aliceKey, `role:member space:${workId}`);
    const api = apiClient(app.baseUrl, access_token);
    const spaces = (await api.get("/v1/spaces")).body.data;
    const personal = spaces.find((s: any) => s.id === alicePersonalId);
    if (personal) expect(personal.role).toEqual([]);
    const work = spaces.find((s: any) => s.id === workId);
    expect(work.role).toContain("edit_items");
    expect((await api.get(`/v1/spaces/${workId}/bundles`)).body.data.every((b: any) => b.role.length > 0)).toBe(true);
    expect((await api.get(`/v1/spaces/${alicePersonalId}/bundles`)).body.data).toEqual([]);
  });
});
