/**
 * The MCP surface: discovery chain, batched call with per-call results,
 * capability gating, authoring tools, and user docs with autoload.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp, type McpTestClient } from "../helpers/mcp.js";

describeEachAdapter("MCP surface", (adapter) => {
  let app: TestApp;
  let sysadmin: ApiClient;
  let aliceKey: string;
  let aliceId: string;
  let alice: McpTestClient;
  let aliceRest: ApiClient;
  let bobKey: string;
  let bobId: string;
  let spaceId: string;
  let todosBundleId: string;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    aliceId = a.body.user.id;
    aliceKey = a.body.initialKey.key;
    aliceRest = apiClient(app.baseUrl, aliceKey);
    const b = await sysadmin.post("/v1/users", { name: "Bob" });
    bobKey = b.body.initialKey.key;
    bobId = b.body.user.id;

    spaceId = (
      await aliceRest.post("/v1/spaces", {
        name: "Work",
        description: "Task tracking and project context",
        keywords: "tasks, todos, projects",
      })
    ).body.id;
    todosBundleId = (
      await aliceRest.post(`/v1/spaces/${spaceId}/bundles`, {
        name: "todos",
        description: "Open and closed todos",
        docs: [{ name: "instructions", content: "Todos have a status property: open or done. Always set it.", autoload: true }],
        itemTypes: [
          {
            name: "todo",
            properties: [
              { name: "title", datatype: "text", required: true },
              { name: "status", datatype: "text", required: true },
            ],
          },
        ],
      })
    ).body.id;
    await aliceRest.post(`/v1/bundles/${todosBundleId}/items`, {
      itemType: "todo",
      items: [
        { title: "Write the report", status: "open" },
        { title: "File expenses", status: "done" },
        { title: "Book travel", status: "open" },
      ],
    });

    alice = await connectMcp(app.baseUrl, aliceKey);
  });

  afterAll(async () => {
    await alice.close();
    await app.stop();
  });

  it("exposes exactly the top-level tool surface", async () => {
    const tools = await alice.client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toContain("load");
    expect(names).toContain("whoami");
    expect(names).toContain("load_space");
    expect(names).toContain("load_bundle");
    expect(names).toContain("help");
    expect(names).toContain("call");
    expect(names).toContain("space_create");
    expect(names).toContain("bundle_create");
    expect(names).toContain("list_user_docs");
    expect(names).toContain("load_user_docs");
    expect(names).toContain("create_user_doc");
    expect(names).toContain("update_user_doc");
    expect(names).toContain("delete_user_doc");
    // show_file and upload_request are second-tier, not top-level.
    expect(names).not.toContain("show_file");
    expect(names).not.toContain("upload_request");
  });

  it("whoami returns the current user identity as a top-level tool", async () => {
    const result = await alice.call("whoami");
    expect(result).toEqual({ id: aliceId, name: "Alice" });
    expect(Object.keys(result).sort()).toEqual(["id", "name"]);
  });

  describe("the discovery chain", () => {
    it("load returns reachable spaces with intent-matching metadata and role", async () => {
      const result = await alice.call("load");
      const work = result.spaces.find((s: any) => s.name === "Work");
      expect(work).toBeTruthy();
      expect(work.keywords).toContain("todos");
      expect(work.role).toContain("read_items");
      // Bundle names ride along in load so intent can be routed in one call.
      expect(work.bundles).toContain("todos");
      expect(result.spaces.some((s: any) => s.personal)).toBe(true);
      expect(result.world.time.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.tools.call.second_tier.query_items.capability).toBe("read_items");
    });

    it("load_space returns context and bundle metadata", async () => {
      const result = await alice.call("load_space", { space_id: spaceId });
      expect(result.bundles).toEqual([
        { id: todosBundleId, name: "todos", description: "Open and closed todos" },
      ]);
    });

    it("load_bundle returns binding docs, schemas, files, and hooks", async () => {
      const result = await alice.call("load_bundle", { bundle_ids: [todosBundleId] });
      const bundle = result.bundles[0];
      expect(bundle.docs.autoloaded).toEqual([
        { name: "instructions", content: expect.stringContaining("Always set it") },
      ]);
      expect(bundle.docs.available).toEqual([
        { id: expect.any(String), name: "instructions", autoload: true },
      ]);
      expect(bundle.item_types[0].name).toBe("todo");
      // Property ids are surfaced so update_property / delete_property are usable over MCP.
      expect(bundle.item_types[0].properties).toEqual([
        { id: expect.any(String), name: "title", datatype: "text", required: true, multi: false },
        { id: expect.any(String), name: "status", datatype: "text", required: true, multi: false },
      ]);
      expect(bundle.files).toEqual([]);
      expect(bundle.hooks).toEqual([]);
    });

    it("help returns concept documentation", async () => {
      const text = await alice.call("help");
      expect(text).toContain("load_bundle");
      expect(text).toContain("hook");
    });

    it("resolves 'show me open todos' end-to-end through the chain", async () => {
      const loaded = await alice.call("load");
      const space = loaded.spaces.find((s: any) => /todo|task/.test(s.keywords));
      const spaceDetail = await alice.call("load_space", { space_id: space.id });
      const bundle = spaceDetail.bundles.find((b: any) => /todo/.test(b.name));
      await alice.call("load_bundle", { bundle_ids: [bundle.id] });
      const result = await alice.call("call", {
        space_id: space.id,
        calls: [
          {
            bundle_id: bundle.id,
            tool: "query_items",
            params: { item_type: "todo", filters: [{ property: "status", op: "eq", value: "open" }] },
          },
        ],
      });
      expect(result.results[0].ok).toBe(true);
      expect(result.results[0].result.data.map((i: any) => i.values.title).sort()).toEqual([
        "Book travel",
        "Write the report",
      ]);
    });
  });

  describe("call", () => {
    it("batches calls with independent per-call results", async () => {
      const result = await alice.call("call", {
        space_id: spaceId,
        calls: [
          { bundle_id: todosBundleId, tool: "read_docs" },
          { bundle_id: todosBundleId, tool: "query_items", params: { item_type: "nonexistent" } },
          {
            bundle_id: todosBundleId,
            tool: "create_items",
            params: { item_type: "todo", items: [{ title: "Created via call", status: "open" }] },
          },
        ],
      });
      expect(result.results).toHaveLength(3);
      expect(result.results[0].ok).toBe(true);
      expect(result.results[0].result.data.some((d: any) => d.content.includes("status"))).toBe(true);
      expect(result.results[1].ok).toBe(false);
      expect(result.results[1].error.code).toBe("not_found");
      expect(result.results[2].ok).toBe(true); // failure of call 2 did not block call 3
    });

    it("rejects unknown second-tier tools per-call with the available catalog", async () => {
      const result = await alice.call("call", {
        space_id: spaceId,
        calls: [{ bundle_id: todosBundleId, tool: "explode" }],
      });
      expect(result.results[0].ok).toBe(false);
      expect(result.results[0].error.message).toContain("query_items");
    });

    it("rejects bundles outside the named space", async () => {
      const otherSpace = (await aliceRest.post("/v1/spaces", { name: "Other" })).body.id;
      const result = await alice.call("call", {
        space_id: otherSpace,
        calls: [{ bundle_id: todosBundleId, tool: "read_docs" }],
      });
      expect(result.results[0].ok).toBe(false);
      expect(result.results[0].error.message).toContain("not in space");
    });

    it("manages docs through call: create, read on demand, update, delete", async () => {
      const create = await alice.call("call", {
        space_id: spaceId,
        calls: [
          {
            bundle_id: todosBundleId,
            tool: "create_doc",
            params: { name: "triage", content: "Oldest first." },
          },
        ],
      });
      expect(create.results[0].ok).toBe(true);

      const read = await alice.call("call", {
        space_id: spaceId,
        calls: [{ bundle_id: todosBundleId, tool: "read_docs", params: { refs: ["triage"] } }],
      });
      expect(read.results[0].result.data).toEqual([
        expect.objectContaining({ name: "triage", content: "Oldest first." }),
      ]);

      const readAll = await alice.call("call", {
        space_id: spaceId,
        calls: [{ bundle_id: todosBundleId, tool: "read_docs" }],
      });
      expect(readAll.results[0].result.data.map((d: any) => d.name)).toContain("instructions");

      const update = await alice.call("call", {
        space_id: spaceId,
        calls: [
          { bundle_id: todosBundleId, tool: "update_doc", params: { doc: "triage", autoload: true } },
        ],
      });
      expect(update.results[0].result.autoload).toBe(true);

      const del = await alice.call("call", {
        space_id: spaceId,
        calls: [{ bundle_id: todosBundleId, tool: "delete_doc", params: { doc: "triage" } }],
      });
      expect(del.results[0].ok).toBe(true);

      const gone = await alice.call("call", {
        space_id: spaceId,
        calls: [{ bundle_id: todosBundleId, tool: "read_docs", params: { refs: ["triage"] } }],
      });
      expect(gone.results[0].ok).toBe(false);
      expect(gone.results[0].error.code).toBe("not_found");
    });

    it("gates per-capability: a user with read but not edit can query, not write", async () => {
      await aliceRest.post(`/v1/bundles/${todosBundleId}/grants`, {
        userId: bobId,
        capabilities: ["read_items"],
        effect: "allow",
      });
      const bob = await connectMcp(app.baseUrl, bobKey);
      const result = await bob.call("call", {
        space_id: spaceId,
        calls: [
          { bundle_id: todosBundleId, tool: "query_items", params: { item_type: "todo" } },
          {
            bundle_id: todosBundleId,
            tool: "create_items",
            params: { item_type: "todo", items: [{ title: "hostile", status: "open" }] },
          },
          { bundle_id: todosBundleId, tool: "update_doc", params: { doc: "instructions", content: "hostile docs" } },
        ],
      });
      expect(result.results[0].ok).toBe(true);
      expect(result.results[1].ok).toBe(false);
      expect(result.results[1].error.code).toBe("forbidden");
      expect(result.results[1].error.details.capability).toBe("edit_items");
      expect(result.results[2].ok).toBe(false);
      expect(result.results[2].error.details.capability).toBe("edit_docs");
      await bob.close();
    });
  });

  describe("authoring", () => {
    it("space_create then bundle_create compose a working context", async () => {
      const created = await alice.call("space_create", { name: "Recipes", keywords: "cooking, food" });
      const bundle = await alice.call("bundle_create", {
        space_id: created.id,
        name: "recipes",
        docs: [{ name: "instructions", content: "Store recipes here.", autoload: true }],
        item_types: [
          {
            name: "recipe",
            properties: [
              { name: "title", datatype: "text", required: true },
              { name: "servings", datatype: "number" },
            ],
          },
        ],
      });
      const write = await alice.call("call", {
        space_id: created.id,
        calls: [
          {
            bundle_id: bundle.id,
            tool: "create_items",
            params: { item_type: "recipe", items: [{ title: "Pasta", servings: 4 }] },
          },
        ],
      });
      expect(write.results[0].ok).toBe(true);
      expect(write.results[0].result[0].values.servings).toBe(4);
    });

    it("bundle_create rejects invalid designs with actionable errors, applying nothing", async () => {
      await expect(
        alice.call("bundle_create", {
          space_id: spaceId,
          name: "bad",
          item_types: [
            { name: "t", properties: [{ name: "x", datatype: "text" }, { name: "x", datatype: "text" }] },
          ],
        }),
      ).rejects.toThrow(/duplicate property name/);
      const spaceDetail = await alice.call("load_space", { space_id: spaceId });
      expect(spaceDetail.bundles.some((b: any) => b.name === "bad")).toBe(false);
    });

    it("bundle_create requires create_bundles in the target space", async () => {
      const bob = await connectMcp(app.baseUrl, bobKey);
      await expect(
        bob.call("bundle_create", { space_id: spaceId, name: "bobs-bundle" }),
      ).rejects.toThrow(/create_bundles/);
      await bob.close();
    });
  });

  describe("user docs", () => {
    it("full CRUD over MCP, with autoload surfacing in load", async () => {
      const created = await alice.call("create_user_doc", {
        name: "preferences",
        content: "Reply in Danish when addressing Troels.",
        autoload: true,
      });
      expect(created.autoload).toBe(1);

      const listed = await alice.call("list_user_docs");
      expect(listed.data.some((d: any) => d.name === "preferences" && d.autoload === true)).toBe(true);

      const loaded = await alice.call("load_user_docs", { refs: ["preferences"] });
      expect(loaded.data[0].content).toContain("Danish");

      const session = await alice.call("load");
      expect(session.user_docs.autoloaded.some((d: any) => d.name === "preferences")).toBe(true);

      const updated = await alice.call("update_user_doc", { id: created.id, autoload: false });
      expect(updated.autoload).toBe(0);
      const session2 = await alice.call("load");
      expect(session2.user_docs.autoloaded.some((d: any) => d.name === "preferences")).toBe(false);

      await alice.call("delete_user_doc", { id: created.id });
      await expect(alice.call("load_user_docs", { refs: ["preferences"] })).rejects.toThrow(/not_found/);
    });

    it("user docs are strictly personal", async () => {
      await alice.call("create_user_doc", { name: "secret-notes", content: "private" });
      const bob = await connectMcp(app.baseUrl, bobKey);
      const bobDocs = await bob.call("list_user_docs");
      expect(bobDocs.data.some((d: any) => d.name === "secret-notes")).toBe(false);
      await expect(bob.call("load_user_docs", { refs: ["secret-notes"] })).rejects.toThrow(/not_found/);
      await bob.close();
    });

    it("user docs CRUD over REST mirrors MCP", async () => {
      const created = await aliceRest.post("/v1/user-docs", { name: "rest-doc", content: "v1" });
      expect(created.status).toBe(201);
      const patched = await aliceRest.patch(`/v1/user-docs/${created.body.id}`, { content: "v2", autoload: true });
      expect(patched.body.content).toBe("v2");
      expect(patched.body.autoload).toBe(1);
      const list = await aliceRest.get("/v1/user-docs");
      expect(list.body.data.some((d: any) => d.name === "rest-doc")).toBe(true);
      expect((await aliceRest.delete(`/v1/user-docs/${created.body.id}`)).status).toBe(200);
      expect((await aliceRest.get(`/v1/user-docs/${created.body.id}`)).status).toBe(404);
    });

    it("rejects renaming a user doc to a name already used by another doc", async () => {
      const docA = await aliceRest.post("/v1/user-docs", { name: "rename-doc-a", content: "a" });
      expect(docA.status).toBe(201);
      const docB = await aliceRest.post("/v1/user-docs", { name: "rename-doc-b", content: "b" });
      expect(docB.status).toBe(201);

      const clash = await aliceRest.patch(`/v1/user-docs/${docB.body.id}`, { name: "rename-doc-a" });
      expect(clash.status).toBe(400);
      expect(clash.body.error.message).toContain("already exists");
    });

    it("allows renaming a user doc to its own current name (self-rename is a no-op)", async () => {
      const created = await aliceRest.post("/v1/user-docs", { name: "self-rename-doc", content: "x" });
      expect(created.status).toBe(201);

      const selfRenamed = await aliceRest.patch(`/v1/user-docs/${created.body.id}`, { name: "self-rename-doc" });
      expect(selfRenamed.status).toBe(200);
      expect(selfRenamed.body.name).toBe("self-rename-doc");
    });
  });
});
