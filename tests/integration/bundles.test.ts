/** REST surface for bundles, item-types, docs, items, and bundle-level grants. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";

describeEachAdapter("bundles over REST", (adapter) => {
  let app: TestApp;
  let alice: ApiClient;
  let bob: ApiClient;
  let bobId: string;
  let spaceId: string;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    const b = await sysadmin.post("/v1/users", { name: "Bob" });
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    bob = apiClient(app.baseUrl, b.body.initialKey.key);
    bobId = b.body.user.id;
    spaceId = (await alice.post("/v1/spaces", { name: "Work", keywords: "tasks, todos" })).body.id;
  });

  afterAll(async () => {
    await app.stop();
  });

  describe("bundle lifecycle", () => {
    it("creates a bundle with docs and item-types in one validated step", async () => {
      const res = await alice.post(`/v1/spaces/${spaceId}/bundles`, {
        name: "todos",
        description: "Task tracking",
        itemTypes: [
          {
            name: "todo",
            properties: [
              { name: "title", datatype: "text", required: true },
              { name: "status", datatype: "text", required: true },
            ],
          },
        ],
      });
      expect(res.status).toBe(201);
      const bundle = await alice.get(`/v1/bundles/${res.body.id}`);
      expect(bundle.body.itemTypes).toHaveLength(1);
      expect(bundle.body.itemTypes[0].properties.map((p: any) => p.name)).toEqual(["title", "status"]);
    });

    it("rejects invalid designs wholesale with actionable errors", async () => {
      const res = await alice.post(`/v1/spaces/${spaceId}/bundles`, {
        name: "broken",
        itemTypes: [
          {
            name: "t",
            properties: [
              { name: "a", datatype: "text" },
              { name: "a", datatype: "text" },
            ],
          },
        ],
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.error.details)).toContain("duplicate property name");
      const list = await alice.get(`/v1/spaces/${spaceId}/bundles`);
      expect(list.body.data.some((b: any) => b.name === "broken")).toBe(false);
    });

    it("rejects invalid datatypes at the schema boundary", async () => {
      const res = await alice.post(`/v1/spaces/${spaceId}/bundles`, {
        name: "badtype",
        itemTypes: [{ name: "t", properties: [{ name: "a", datatype: "jsonb" }] }],
      });
      expect(res.status).toBe(400);
    });

    it("rejects a duplicate bundle name in the same space", async () => {
      const first = await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "dupe" });
      expect(first.status).toBe(201);
      const second = await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "dupe" });
      expect(second.status).toBe(400);
      expect(second.body.error.message).toContain("already exists");
      const other = await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "dupe-renamed" });
      const renamed = await alice.patch(`/v1/bundles/${other.body.id}`, { name: "dupe" });
      expect(renamed.status).toBe(400);
      // Self-rename: patching a bundle to its own current name must succeed.
      const selfRenamed = await alice.patch(`/v1/bundles/${first.body.id}`, { name: "dupe" });
      expect(selfRenamed.status).toBe(200);
    });

    it("updates and deletes bundles with edit_bundles", async () => {
      const created = await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "temp" });
      const patched = await alice.patch(`/v1/bundles/${created.body.id}`, { description: "tmp" });
      expect(patched.body.description).toBe("tmp");
      expect((await bob.patch(`/v1/bundles/${created.body.id}`, { description: "x" })).status).toBe(404);
      expect((await alice.delete(`/v1/bundles/${created.body.id}`)).status).toBe(200);
      expect((await alice.get(`/v1/bundles/${created.body.id}`)).status).toBe(404);
    });
  });

  describe("docs", () => {
    let bundleId: string;

    beforeAll(async () => {
      bundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "documented" })).body.id;
    });

    it("creates, lists, reads, updates, and deletes named docs", async () => {
      const created = await alice.post(`/v1/bundles/${bundleId}/docs`, {
        name: "style-guide",
        content: "Prefer short sentences.",
      });
      expect(created.status).toBe(201);
      expect(created.body.autoload).toBe(0);
      await alice.post(`/v1/bundles/${bundleId}/docs`, {
        name: "instructions",
        content: "Always set status.",
        autoload: true,
      });

      const list = await alice.get(`/v1/bundles/${bundleId}/docs`);
      expect(list.body.data.map((d: any) => d.name)).toEqual(["style-guide", "instructions"]);
      expect(list.body.data[0].content).toBeUndefined();

      const byName = await alice.get(`/v1/bundles/${bundleId}/docs/style-guide`);
      expect(byName.body.content).toBe("Prefer short sentences.");
      const byId = await alice.get(`/v1/bundles/${bundleId}/docs/${created.body.id}`);
      expect(byId.body.name).toBe("style-guide");

      const patched = await alice.patch(`/v1/bundles/${bundleId}/docs/style-guide`, {
        content: "Prefer short sentences. Use headings.",
        autoload: true,
      });
      expect(patched.body.autoload).toBe(1);
      expect(patched.body.content).toContain("headings");

      expect((await alice.delete(`/v1/bundles/${bundleId}/docs/style-guide`)).status).toBe(200);
      expect((await alice.get(`/v1/bundles/${bundleId}/docs/style-guide`)).status).toBe(404);
    });

    it("rejects a duplicate doc name in the same bundle", async () => {
      const dup = await alice.post(`/v1/bundles/${bundleId}/docs`, { name: "instructions" });
      expect(dup.status).toBe(400);
      expect(dup.body.error.message).toContain("already exists");
    });

    it("gates doc writes on edit_docs separately from reads", async () => {
      await alice.post(`/v1/bundles/${bundleId}/grants`, {
        userId: bobId,
        capabilities: ["read_items"],
        effect: "allow",
      });
      expect((await bob.get(`/v1/bundles/${bundleId}/docs`)).status).toBe(200);
      expect((await bob.get(`/v1/bundles/${bundleId}/docs/instructions`)).status).toBe(200);
      const denied = await bob.post(`/v1/bundles/${bundleId}/docs`, { name: "hostile" });
      expect(denied.status).toBe(403);
      expect(denied.body.error.details.capability).toBe("edit_docs");
      expect((await bob.patch(`/v1/bundles/${bundleId}/docs/instructions`, { content: "x" })).status).toBe(403);
      expect((await bob.delete(`/v1/bundles/${bundleId}/docs/instructions`)).status).toBe(403);
    });
  });

  describe("items over REST", () => {
    let bundleId: string;

    beforeAll(async () => {
      bundleId = (
        await alice.post(`/v1/spaces/${spaceId}/bundles`, {
          name: "rest-items",
          itemTypes: [
            {
              name: "todo",
              properties: [
                { name: "title", datatype: "text", required: true },
                { name: "status", datatype: "text" },
              ],
            },
          ],
        })
      ).body.id;
    });

    it("creates, queries, patches, and deletes items", async () => {
      const created = await alice.post(`/v1/bundles/${bundleId}/items`, {
        itemType: "todo",
        items: [
          { title: "One", status: "open" },
          { title: "Two", status: "done" },
        ],
      });
      expect(created.status).toBe(201);
      expect(created.body.data).toHaveLength(2);

      const filters = encodeURIComponent(JSON.stringify([{ property: "status", op: "eq", value: "open" }]));
      const queried = await alice.get(`/v1/bundles/${bundleId}/items?itemType=todo&filters=${filters}`);
      expect(queried.body.data.map((i: any) => i.values.title)).toEqual(["One"]);

      const itemId = queried.body.data[0].id;
      const patched = await alice.patch(`/v1/items/${itemId}`, { set: { status: "done" } });
      expect(patched.body.values.status).toBe("done");

      const byIds = await alice.get(`/v1/bundles/${bundleId}/items?ids=${itemId}`);
      expect(byIds.body.data[0].values.status).toBe("done");

      expect((await alice.delete(`/v1/items/${itemId}`)).status).toBe(200);
      const remaining = await alice.get(`/v1/bundles/${bundleId}/items?itemType=todo`);
      expect(remaining.body.data.map((i: any) => i.values.title)).toEqual(["Two"]);
    });

    it("returns 400 (not 500) for a malformed filters value", async () => {
      // Valid JSON, wrong shape — a client mistake, must be invalid_request.
      const badShape = encodeURIComponent(JSON.stringify([{ property: 1 }]));
      const res = await alice.get(`/v1/bundles/${bundleId}/items?itemType=todo&filters=${badShape}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
      // Not even JSON.
      const notJson = await alice.get(`/v1/bundles/${bundleId}/items?itemType=todo&filters=notjson`);
      expect(notJson.status).toBe(400);
    });

    it("round-trips multi-valued fields and set operators over REST", async () => {
      const mb = (
        await alice.post(`/v1/spaces/${spaceId}/bundles`, {
          name: "multi-rest",
          itemTypes: [
            {
              name: "article",
              properties: [
                { name: "title", datatype: "text", required: true },
                { name: "tags", datatype: "text", multi: true },
              ],
            },
          ],
        })
      ).body.id;
      // load_bundle-style read over REST exposes the multi flag.
      const got = await alice.get(`/v1/bundles/${mb}`);
      const tagsProp = got.body.itemTypes[0].properties.find((p: any) => p.name === "tags");
      expect(tagsProp.multi).toBe(true);

      await alice.post(`/v1/bundles/${mb}/items`, {
        itemType: "article",
        items: [
          { title: "One", tags: ["red", "urgent"] },
          { title: "Two", tags: ["blue"] },
        ],
      });
      const f = (filters: unknown) => encodeURIComponent(JSON.stringify(filters));
      const hasRed = await alice.get(`/v1/bundles/${mb}/items?itemType=article&filters=${f([{ property: "tags", op: "has", value: "red" }])}`);
      expect(hasRed.body.data.map((i: any) => i.values.title)).toEqual(["One"]);
      expect(hasRed.body.data[0].values.tags).toEqual(["red", "urgent"]); // array round-trip

      const hasAny = await alice.get(`/v1/bundles/${mb}/items?itemType=article&filters=${f([{ property: "tags", op: "has_any", value: ["blue", "green"] }])}`);
      expect(hasAny.body.data.map((i: any) => i.values.title)).toEqual(["Two"]);
    });

    it("manages item-types and properties over REST", async () => {
      const typeRes = await alice.post(`/v1/bundles/${bundleId}/item-types`, {
        name: "note",
        properties: [{ name: "body", datatype: "text", required: true }],
      });
      expect(typeRes.status).toBe(201);
      const typeId = typeRes.body.id;

      const propRes = await alice.post(`/v1/item-types/${typeId}/properties`, {
        name: "pinned",
        datatype: "boolean",
      });
      expect(propRes.status).toBe(201);

      const renamed = await alice.patch(`/v1/item-types/${typeId}/properties/${propRes.body.id}`, {
        name: "starred",
      });
      expect(renamed.body.name).toBe("starred");

      expect((await alice.delete(`/v1/item-types/${typeId}/properties/${propRes.body.id}`)).status).toBe(200);
      expect((await alice.delete(`/v1/item-types/${typeId}`)).status).toBe(200);
      const types = await alice.get(`/v1/bundles/${bundleId}/item-types`);
      expect(types.body.data.some((t: any) => t.id === typeId)).toBe(false);
    });
  });

  describe("bundle-level grants (cascade with per-capability override)", () => {
    let openBundle: string;
    let sensitiveBundle: string;

    beforeAll(async () => {
      openBundle = (
        await alice.post(`/v1/spaces/${spaceId}/bundles`, {
          name: "open-bundle",
          itemTypes: [{ name: "t", properties: [{ name: "v", datatype: "text" }] }],
        })
      ).body.id;
      sensitiveBundle = (
        await alice.post(`/v1/spaces/${spaceId}/bundles`, {
          name: "sensitive-bundle",
          itemTypes: [{ name: "t", properties: [{ name: "v", datatype: "text" }] }],
        })
      ).body.id;
      // Space-level baseline: Bob can read items everywhere in the space.
      await alice.post(`/v1/spaces/${spaceId}/grants`, {
        userId: bobId,
        capabilities: ["read_items"],
        effect: "allow",
      });
      // Bundle-level override: revoked on the sensitive bundle only.
      await alice.post(`/v1/bundles/${sensitiveBundle}/grants`, {
        userId: bobId,
        capabilities: ["read_items"],
        effect: "deny",
      });
    });

    it("space baseline cascades into bundles; bundle deny overrides", async () => {
      expect((await bob.get(`/v1/bundles/${openBundle}/items?itemType=t`)).status).toBe(200);
      const denied = await bob.get(`/v1/bundles/${sensitiveBundle}/items?itemType=t`);
      expect(denied.status).toBe(403);
      // The deciding row is identifiable.
      expect(denied.body.error.details.decidedBy.level).toBe("bundle");
      expect(denied.body.error.details.decidedBy.effect).toBe("deny");
      expect(denied.body.error.details.decidedBy.grantId).toBeTruthy();
    });
  });
});
