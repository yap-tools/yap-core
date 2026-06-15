/**
 * A bundle must be uniformly invisible to a principal with no access to it.
 * The bundle resource (GET /v1/bundles/:id) and doc reads already 404 for an
 * outsider, but the content/management endpoints (items, item-types, files,
 * hooks, doc writes) historically returned 403 — leaking the bundle's
 * existence. This pins the unified rule:
 *
 *   - no grant reaches you AND you hold no other capability here  -> 404
 *   - you can see the bundle but lack THIS capability             -> 403 (named)
 *   - you are explicitly denied THIS capability                   -> 403 (deciding row)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";

describeEachAdapter("bundle existence hiding", (adapter) => {
  let app: TestApp;
  let alice: ApiClient;
  let bob: ApiClient;
  let bobId: string;
  let spaceId: string;
  let bundleId: string;
  let itemId: string;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    const b = await sysadmin.post("/v1/users", { name: "Bob" });
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    bob = apiClient(app.baseUrl, b.body.initialKey.key);
    bobId = b.body.user.id;
    spaceId = (await alice.post("/v1/spaces", { name: "Work" })).body.id;
    bundleId = (
      await alice.post(`/v1/spaces/${spaceId}/bundles`, {
        name: "todos",
        docs: [{ name: "instructions", content: "set status", autoload: true }],
        itemTypes: [{ name: "todo", properties: [{ name: "title", datatype: "text", required: true }, { name: "status", datatype: "text" }] }],
      })
    ).body.id;
    itemId = (await alice.post(`/v1/bundles/${bundleId}/items`, { itemType: "todo", items: [{ title: "t1", status: "open" }] })).body.data[0].id;
  });

  afterAll(async () => {
    await app.stop();
  });

  describe("a complete outsider sees the bundle as absent (404) on every endpoint", () => {
    it("the bundle resource (control) is 404", async () => {
      expect((await bob.get(`/v1/bundles/${bundleId}`)).status).toBe(404);
    });

    it("item reads and writes are 404, not 403", async () => {
      const read = await bob.get(`/v1/bundles/${bundleId}/items?itemType=todo`);
      expect(read.status).toBe(404);
      expect(read.body.error.code).toBe("not_found");
      expect((await bob.post(`/v1/bundles/${bundleId}/items`, { itemType: "todo", items: [{ title: "x", status: "open" }] })).status).toBe(404);
      expect((await bob.patch(`/v1/items/${itemId}`, { set: { status: "done" } })).status).toBe(404);
      expect((await bob.delete(`/v1/items/${itemId}`)).status).toBe(404);
    });

    it("item-type management is 404, not 403", async () => {
      expect((await bob.post(`/v1/bundles/${bundleId}/item-types`, { name: "note" })).status).toBe(404);
    });

    it("doc reads (control) and writes are 404", async () => {
      expect((await bob.get(`/v1/bundles/${bundleId}/docs`)).status).toBe(404);
      expect((await bob.post(`/v1/bundles/${bundleId}/docs`, { name: "hostile" })).status).toBe(404);
    });

    it("file listing and uploads are 404, not 403", async () => {
      expect((await bob.get(`/v1/bundles/${bundleId}/files`)).status).toBe(404);
      expect((await bob.post(`/v1/bundles/${bundleId}/files/upload-request`, { name: "f.txt" })).status).toBe(404);
    });

    it("hook listing (control) and authoring are 404, not 403", async () => {
      expect((await bob.get(`/v1/bundles/${bundleId}/hooks`)).status).toBe(404);
      expect((await bob.post(`/v1/bundles/${bundleId}/hooks`, { name: "h", transport: { url: "http://127.0.0.1:9/x", method: "GET" } })).status).toBe(404);
    });
  });

  describe("a member who can see the bundle but lacks a capability still gets 403", () => {
    beforeAll(async () => {
      await alice.post(`/v1/bundles/${bundleId}/grants`, { userId: bobId, capabilities: ["read_items"], effect: "allow" });
    });

    it("becomes visible once any capability is granted", async () => {
      expect((await bob.get(`/v1/bundles/${bundleId}`)).status).toBe(200);
      expect((await bob.get(`/v1/bundles/${bundleId}/items?itemType=todo`)).status).toBe(200);
    });

    it("lacking the specific capability is a 403 that names it (not 404)", async () => {
      const denied = await bob.post(`/v1/bundles/${bundleId}/items`, { itemType: "todo", items: [{ title: "x", status: "open" }] });
      expect(denied.status).toBe(403);
      expect(denied.body.error.details.capability).toBe("edit_items");
      const deniedDoc = await bob.post(`/v1/bundles/${bundleId}/docs`, { name: "hostile" });
      expect(deniedDoc.status).toBe(403);
      expect(deniedDoc.body.error.details.capability).toBe("edit_docs");
    });

    it("an explicit deny is a 403 with the deciding row, never a 404", async () => {
      await alice.post(`/v1/bundles/${bundleId}/grants`, { userId: bobId, capabilities: ["read_items"], effect: "deny" });
      const denied = await bob.get(`/v1/bundles/${bundleId}/items?itemType=todo`);
      expect(denied.status).toBe(403);
      expect(denied.body.error.details.decidedBy.effect).toBe("deny");
      expect(denied.body.error.details.decidedBy.level).toBe("bundle");
    });
  });
});
