/**
 * Surgical text edits: bundle docs, user docs, item text properties.
 * Tests the REST PATCH surface and the MCP call/tool surface.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp, type McpTestClient } from "../helpers/mcp.js";

describeEachAdapter("surgical text edits", (adapter) => {
  let app: TestApp;
  let sysadmin: ApiClient;
  let aliceKey: string;
  let alice: ApiClient;
  let aliceMcp: McpTestClient;
  let spaceId: string;
  let bundleId: string;
  let docId: string;
  let userDocId: string;
  let itemBundleId: string;
  let itemId: string;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const u = await sysadmin.post("/v1/users", { name: "Alice" });
    aliceKey = u.body.initialKey.key;
    alice = apiClient(app.baseUrl, aliceKey);
    aliceMcp = await connectMcp(app.baseUrl, aliceKey);

    spaceId = (await alice.post("/v1/spaces", { name: "Work" })).body.id;

    bundleId = (
      await alice.post(`/v1/spaces/${spaceId}/bundles`, {
        name: "notes",
        docs: [{ name: "readme", content: "line1\nline2\nline3", autoload: false }],
      })
    ).body.id;

    const docs = (await alice.get(`/v1/bundles/${bundleId}/docs`)).body.data;
    docId = docs[0].id;

    const ud = await alice.post("/v1/user-docs", { name: "my-notes", content: "initial content" });
    userDocId = ud.body.id;

    itemBundleId = (
      await alice.post(`/v1/spaces/${spaceId}/bundles`, {
        name: "tasks",
        itemTypes: [
          {
            name: "task",
            properties: [
              { name: "title", datatype: "text", required: true },
              { name: "notes", datatype: "text" },
              { name: "status", datatype: "text", required: true },
            ],
          },
        ],
      })
    ).body.id;

    const items = await alice.post(`/v1/bundles/${itemBundleId}/items`, {
      itemType: "task",
      items: [{ title: "Write tests", notes: "initial notes", status: "open" }],
    });
    itemId = items.body.data[0].id;
  });

  afterAll(async () => {
    await aliceMcp.close();
    await app.stop();
  });

  // ---- Bundle docs (REST) -------------------------------------------------------

  async function resetDoc(content: string) {
    await alice.patch(`/v1/bundles/${bundleId}/docs/${docId}`, { content });
  }

  describe("REST PATCH /v1/bundles/:id/docs/:ref — edits", () => {
    it("append adds content at the end", async () => {
      await resetDoc("hello");
      const r = await alice.patch(`/v1/bundles/${bundleId}/docs/${docId}`, {
        edits: [{ op: "append", content: " world" }],
      });
      expect(r.status).toBe(200);
      expect(r.body.content).toBe("hello world");
    });

    it("prepend adds content at the start", async () => {
      await resetDoc("world");
      const r = await alice.patch(`/v1/bundles/${bundleId}/docs/${docId}`, {
        edits: [{ op: "prepend", content: "hello " }],
      });
      expect(r.status).toBe(200);
      expect(r.body.content).toBe("hello world");
    });

    it("search_replace replaces unique match", async () => {
      await resetDoc("foo bar baz");
      const r = await alice.patch(`/v1/bundles/${bundleId}/docs/${docId}`, {
        edits: [{ op: "search_replace", search: "bar", replace: "BAR" }],
      });
      expect(r.status).toBe(200);
      expect(r.body.content).toBe("foo BAR baz");
    });

    it("search_replace errors on ambiguous match without all", async () => {
      await resetDoc("foo foo");
      const r = await alice.patch(`/v1/bundles/${bundleId}/docs/${docId}`, {
        edits: [{ op: "search_replace", search: "foo", replace: "bar" }],
      });
      expect(r.status).toBe(400);
    });

    it("search_replace with all: true replaces all occurrences", async () => {
      await resetDoc("foo foo");
      const r = await alice.patch(`/v1/bundles/${bundleId}/docs/${docId}`, {
        edits: [{ op: "search_replace", search: "foo", replace: "bar", all: true }],
      });
      expect(r.status).toBe(200);
      expect(r.body.content).toBe("bar bar");
    });

    it("insert_before inserts before the first match", async () => {
      await resetDoc("helloworld");
      const r = await alice.patch(`/v1/bundles/${bundleId}/docs/${docId}`, {
        edits: [{ op: "insert_before", target: "world", content: " " }],
      });
      expect(r.status).toBe(200);
      expect(r.body.content).toBe("hello world");
    });

    it("insert_after inserts after the first match", async () => {
      await resetDoc("hello world");
      const r = await alice.patch(`/v1/bundles/${bundleId}/docs/${docId}`, {
        edits: [{ op: "insert_after", target: "hello", content: "!" }],
      });
      expect(r.status).toBe(200);
      expect(r.body.content).toBe("hello! world");
    });

    it("delete removes first occurrence", async () => {
      await resetDoc("foo bar foo");
      const r = await alice.patch(`/v1/bundles/${bundleId}/docs/${docId}`, {
        edits: [{ op: "delete", target: "foo " }],
      });
      expect(r.status).toBe(200);
      expect(r.body.content).toBe("bar foo");
    });

    it("replace_lines replaces a line range", async () => {
      await resetDoc("line1\nline2\nline3");
      const r = await alice.patch(`/v1/bundles/${bundleId}/docs/${docId}`, {
        edits: [{ op: "replace_lines", from: 2, to: 2, content: "NEW" }],
      });
      expect(r.status).toBe(200);
      expect(r.body.content).toBe("line1\nNEW\nline3");
    });

    it("delete_lines removes a line range", async () => {
      await resetDoc("line1\nline2\nline3");
      const r = await alice.patch(`/v1/bundles/${bundleId}/docs/${docId}`, {
        edits: [{ op: "delete_lines", from: 2, to: 2 }],
      });
      expect(r.status).toBe(200);
      expect(r.body.content).toBe("line1\nline3");
    });

    it("applies multiple ops sequentially", async () => {
      await resetDoc("hello");
      const r = await alice.patch(`/v1/bundles/${bundleId}/docs/${docId}`, {
        edits: [
          { op: "append", content: " world" },
          { op: "search_replace", search: "world", replace: "there" },
        ],
      });
      expect(r.status).toBe(200);
      expect(r.body.content).toBe("hello there");
    });

    it("rejects when content and edits are both provided", async () => {
      const r = await alice.patch(`/v1/bundles/${bundleId}/docs/${docId}`, {
        content: "full replace",
        edits: [{ op: "append", content: "x" }],
      });
      expect(r.status).toBe(400);
    });

    it("mid-batch failure leaves doc unchanged (all-or-nothing)", async () => {
      await resetDoc("hello");
      const r = await alice.patch(`/v1/bundles/${bundleId}/docs/${docId}`, {
        edits: [
          { op: "append", content: " world" },
          { op: "search_replace", search: "MISSING", replace: "x" },
        ],
      });
      expect(r.status).toBe(400);
      const doc = (await alice.get(`/v1/bundles/${bundleId}/docs/${docId}`)).body;
      expect(doc.content).toBe("hello");
    });
  });

  // ---- Bundle docs (MCP) -------------------------------------------------------

  describe("MCP call patch_doc", () => {
    it("search_replace via MCP patch_doc", async () => {
      await resetDoc("old value");
      const result = await aliceMcp.call("call", {
        space_id: spaceId,
        calls: [
          {
            bundle_id: bundleId,
            tool: "patch_doc",
            params: { id: docId, edits: [{ op: "search_replace", search: "old", replace: "new" }] },
          },
        ],
      });
      expect(result.results[0].ok).toBe(true);
      expect(result.results[0].result.content).toBe("new value");
    });

    it("all-or-nothing via MCP: mid-batch failure returns error result", async () => {
      await resetDoc("hello");
      const result = await aliceMcp.call("call", {
        space_id: spaceId,
        calls: [
          {
            bundle_id: bundleId,
            tool: "patch_doc",
            params: {
              id: docId,
              edits: [
                { op: "append", content: " world" },
                { op: "search_replace", search: "MISSING", replace: "x" },
              ],
            },
          },
        ],
      });
      expect(result.results[0].ok).toBe(false);
      const doc = (await alice.get(`/v1/bundles/${bundleId}/docs/${docId}`)).body;
      expect(doc.content).toBe("hello");
    });
  });

  // ---- User docs (REST) --------------------------------------------------------

  async function resetUserDoc(content: string) {
    await alice.patch(`/v1/user-docs/${userDocId}`, { content });
  }

  describe("REST PATCH /v1/user-docs/:id — edits", () => {
    it("appends content", async () => {
      await resetUserDoc("hello");
      const r = await alice.patch(`/v1/user-docs/${userDocId}`, {
        edits: [{ op: "append", content: " world" }],
      });
      expect(r.status).toBe(200);
      expect(r.body.content).toBe("hello world");
    });

    it("search_replace works", async () => {
      await resetUserDoc("foo bar");
      const r = await alice.patch(`/v1/user-docs/${userDocId}`, {
        edits: [{ op: "search_replace", search: "bar", replace: "baz" }],
      });
      expect(r.status).toBe(200);
      expect(r.body.content).toBe("foo baz");
    });

    it("rejects content and edits together", async () => {
      const r = await alice.patch(`/v1/user-docs/${userDocId}`, {
        content: "full replace",
        edits: [{ op: "append", content: "x" }],
      });
      expect(r.status).toBe(400);
    });

    it("all-or-nothing: doc unchanged after mid-batch failure", async () => {
      await resetUserDoc("stable");
      const r = await alice.patch(`/v1/user-docs/${userDocId}`, {
        edits: [
          { op: "append", content: " changed" },
          { op: "search_replace", search: "MISSING", replace: "x" },
        ],
      });
      expect(r.status).toBe(400);
      const doc = (await alice.get(`/v1/user-docs/${userDocId}`)).body;
      expect(doc.content).toBe("stable");
    });
  });

  // ---- User docs (MCP) ---------------------------------------------------------

  describe("MCP patch_user_doc tool", () => {
    it("append via MCP patch_user_doc", async () => {
      await resetUserDoc("hello");
      const result = await aliceMcp.call("patch_user_doc", {
        id: userDocId,
        edits: [{ op: "append", content: " world" }],
      });
      expect(result.content).toBe("hello world");
    });

    it("search_replace via MCP patch_user_doc", async () => {
      await resetUserDoc("old value");
      const result = await aliceMcp.call("patch_user_doc", {
        id: userDocId,
        edits: [{ op: "search_replace", search: "old", replace: "new" }],
      });
      expect(result.content).toBe("new value");
    });
  });

  // ---- Items (REST) ------------------------------------------------------------

  async function resetItem(notes: string) {
    await alice.patch(`/v1/items/${itemId}`, { set: { notes } });
  }

  describe("REST PATCH /v1/items/:id — edits on text property", () => {
    it("appends to a text property", async () => {
      await resetItem("initial");
      const r = await alice.patch(`/v1/items/${itemId}`, {
        edits: { notes: [{ op: "append", content: " appended" }] },
      });
      expect(r.status).toBe(200);
      expect(r.body.values.notes).toBe("initial appended");
    });

    it("search_replace on a text property", async () => {
      await resetItem("foo bar");
      const r = await alice.patch(`/v1/items/${itemId}`, {
        edits: { notes: [{ op: "search_replace", search: "bar", replace: "baz" }] },
      });
      expect(r.status).toBe(200);
      expect(r.body.values.notes).toBe("foo baz");
    });

    it("set and edits can coexist on different properties", async () => {
      await resetItem("initial");
      await alice.patch(`/v1/items/${itemId}`, { set: { status: "open" } });
      const r = await alice.patch(`/v1/items/${itemId}`, {
        set: { status: "done" },
        edits: { notes: [{ op: "append", content: " — completed" }] },
      });
      expect(r.status).toBe(200);
      expect(r.body.values.status).toBe("done");
      expect(r.body.values.notes).toBe("initial — completed");
    });

    it("rejects edits on same property as set", async () => {
      const r = await alice.patch(`/v1/items/${itemId}`, {
        set: { notes: "full" },
        edits: { notes: [{ op: "append", content: "x" }] },
      });
      expect(r.status).toBe(400);
    });

    it("all-or-nothing: item unchanged after mid-batch failure", async () => {
      await resetItem("stable");
      const r = await alice.patch(`/v1/items/${itemId}`, {
        edits: {
          notes: [
            { op: "append", content: " changed" },
            { op: "search_replace", search: "MISSING", replace: "x" },
          ],
        },
      });
      expect(r.status).toBe(400);
      const item = (await alice.get(`/v1/bundles/${itemBundleId}/items?ids=${itemId}`)).body.data[0];
      expect(item.values.notes).toBe("stable");
    });
  });

  // ---- Items (MCP) -------------------------------------------------------------

  describe("MCP update_items with edits", () => {
    it("appends to a text property via MCP update_items", async () => {
      await resetItem("initial");
      const result = await aliceMcp.call("call", {
        space_id: spaceId,
        calls: [
          {
            bundle_id: itemBundleId,
            tool: "update_items",
            params: {
              updates: [{ id: itemId, edits: { notes: [{ op: "append", content: " via MCP" }] } }],
            },
          },
        ],
      });
      expect(result.results[0].ok).toBe(true);
      expect(result.results[0].result[0].values.notes).toBe("initial via MCP");
    });
  });

  // ---- The payload shape that was reported as a transport failure ----------------

  describe("MCP update_items: large multi-line search_replace plus prepend", () => {
    // Replacement text full of what a regex-based replace would mangle.
    const replacement = Array.from(
      { length: 28 },
      (_, i) => `line ${i}: $& $1 $$ \\n \\\\ C:\\dir "quoted" – æøå ✓ 日本語 😀`,
    ).join("\r\n");

    async function send(params: Record<string, unknown>) {
      const result = await aliceMcp.call("call", {
        space_id: spaceId,
        calls: [{ bundle_id: itemBundleId, tool: "update_items", params }],
      });
      return result.results[0];
    }

    it("applies both edits and stores the replacement literally", async () => {
      expect(replacement.length).toBeGreaterThan(1400);
      await alice.patch(`/v1/items/${itemId}`, { set: { notes: "head [[PLACEHOLDER]] tail", status: "old status" } });
      const r = await send({
        updates: [
          {
            id: itemId,
            edits: {
              notes: [{ op: "search_replace", search: "[[PLACEHOLDER]]", replace: replacement }],
              status: [{ op: "prepend", content: "2026-01-01 — new entry\n" }],
            },
          },
        ],
      });
      expect(r.ok).toBe(true);
      expect(r.result[0].values.notes).toBe(`head ${replacement} tail`);
      expect(r.result[0].values.status).toBe("2026-01-01 — new entry\nold status");
      const stored = (await alice.get(`/v1/bundles/${itemBundleId}/items?ids=${itemId}`)).body.data[0];
      expect(stored.values.notes).toBe(`head ${replacement} tail`);
      expect(stored.values.status).toBe("2026-01-01 — new entry\nold status");
    });

    it("returns a structured ok:false naming the property when search does not match", async () => {
      await alice.patch(`/v1/items/${itemId}`, { set: { notes: "unchanged", status: "unchanged status" } });
      const r = await send({
        updates: [
          {
            id: itemId,
            edits: {
              notes: [{ op: "search_replace", search: "not in the text", replace: replacement }],
              status: [{ op: "prepend", content: "x" }],
            },
          },
        ],
      });
      expect(r.ok).toBe(false);
      expect(r.error.message).toContain('edits for "notes"');
      const stored = (await alice.get(`/v1/bundles/${itemBundleId}/items?ids=${itemId}`)).body.data[0];
      expect(stored.values.notes).toBe("unchanged");
      expect(stored.values.status).toBe("unchanged status");
    });

    it("stores the same value for an edit as for a set of the same text", async () => {
      await alice.patch(`/v1/items/${itemId}`, { set: { notes: "a", status: "s" } });
      const viaEdit = await send({ updates: [{ id: itemId, edits: { notes: [{ op: "append", content: replacement }] } }] });
      expect(viaEdit.ok).toBe(true);
      const editedRow = (await alice.get(`/v1/bundles/${itemBundleId}/items?ids=${itemId}`)).body.data[0];
      await alice.patch(`/v1/items/${itemId}`, { set: { notes: "a" } });
      const viaSet = await send({ updates: [{ id: itemId, set: { notes: `a${replacement}` } }] });
      expect(viaSet.ok).toBe(true);
      const setRow = (await alice.get(`/v1/bundles/${itemBundleId}/items?ids=${itemId}`)).body.data[0];
      expect(editedRow.values.notes).toBe(setRow.values.notes);
    });
  });

  // ---- Malformed ops: refused on every path, nothing written --------------------

  describe("malformed edit ops", () => {
    // A guessed operand key: `value` and `text` where prepend takes `content`.
    const guesses = [
      { op: "prepend", value: "x" },
      { op: "prepend", text: "x" },
    ];

    async function mcpCall(bundle: string, tool: string, params: Record<string, unknown>) {
      const result = await aliceMcp.call("call", { space_id: spaceId, calls: [{ bundle_id: bundle, tool, params }] });
      return result.results[0];
    }

    for (const bad of guesses) {
      const key = Object.keys(bad).find((k) => k !== "op")!;

      it(`MCP update_items refuses {op: "prepend", ${key}} and leaves the item unchanged`, async () => {
        await resetItem("kept");
        const r = await mcpCall(itemBundleId, "update_items", { updates: [{ id: itemId, edits: { notes: [bad] } }] });
        expect(r.ok).toBe(false);
        expect(r.error.code).toBe("invalid_request");
        expect(r.error.message).toContain(`unknown key "${key}" for op "prepend"; expected {op, content}`);
        const item = (await alice.get(`/v1/bundles/${itemBundleId}/items?ids=${itemId}`)).body.data[0];
        expect(item.values.notes).toBe("kept");
      });

      it(`MCP patch_doc refuses {op: "prepend", ${key}} and leaves the doc unchanged`, async () => {
        await resetDoc("kept");
        const r = await mcpCall(bundleId, "patch_doc", { id: docId, edits: [bad] });
        expect(r.ok).toBe(false);
        expect(r.error.code).toBe("invalid_request");
        expect(r.error.message).toContain(`unknown key "${key}" for op "prepend"`);
        expect((await alice.get(`/v1/bundles/${bundleId}/docs/${docId}`)).body.content).toBe("kept");
      });
    }

    it("MCP update_items refuses a null or missing operand", async () => {
      await resetItem("kept");
      for (const bad of [{ op: "append", content: null }, { op: "insert_after", target: "kept" }]) {
        const r = await mcpCall(itemBundleId, "update_items", { updates: [{ id: itemId, edits: { notes: [bad] } }] });
        expect(r.ok).toBe(false);
        expect(r.error.code).toBe("invalid_request");
        expect(r.error.message).toMatch(/edits\[0\]: "(append|insert_after)" needs content \(a string\)/);
      }
      const item = (await alice.get(`/v1/bundles/${itemBundleId}/items?ids=${itemId}`)).body.data[0];
      expect(item.values.notes).toBe("kept");
    });

    it("MCP patch_doc refuses replace_lines without content as invalid_request, not internal", async () => {
      await resetDoc("a\nb");
      const r = await mcpCall(bundleId, "patch_doc", { id: docId, edits: [{ op: "replace_lines", from: 1, to: 1 }] });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe("invalid_request");
      expect(r.error.message).toContain('"replace_lines" needs content');
    });

    it("MCP patch_user_doc refuses a guessed key and leaves the doc unchanged", async () => {
      await resetUserDoc("kept");
      const r = await aliceMcp.callRaw("patch_user_doc", { id: userDocId, edits: [{ op: "prepend", value: "x" }] });
      expect(r.isError).toBe(true);
      const text = r.content.map((c: { text: string }) => c.text).join("\n");
      expect(text).toContain("invalid_request");
      expect(text).toContain('unknown key "value" for op "prepend"; expected {op, content}');
      expect((await alice.get(`/v1/user-docs/${userDocId}`)).body.content).toBe("kept");
    });

    it("REST item PATCH refuses an extra key instead of stripping it", async () => {
      await resetItem("kept");
      const r = await alice.patch(`/v1/items/${itemId}`, {
        edits: { notes: [{ op: "append", content: " more", extra: true }] },
      });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("invalid_request");
      expect(r.body.error.message).toContain('unknown key "extra" for op "append"');
      const item = (await alice.get(`/v1/bundles/${itemBundleId}/items?ids=${itemId}`)).body.data[0];
      expect(item.values.notes).toBe("kept");
    });

    it("REST bundle-doc and user-doc PATCH refuse an extra key with a pointed message", async () => {
      await resetDoc("kept");
      await resetUserDoc("kept");
      const bad = [{ op: "append", content: " more", value: "x" }];
      const doc = await alice.patch(`/v1/bundles/${bundleId}/docs/${docId}`, { edits: bad });
      const userDoc = await alice.patch(`/v1/user-docs/${userDocId}`, { edits: bad });
      for (const r of [doc, userDoc]) {
        expect(r.status).toBe(400);
        expect(r.body.error.message).toContain('edits[0]: unknown key "value" for op "append"');
        expect(r.body.error.details.issues[0].path).toEqual([0]);
      }
      expect((await alice.get(`/v1/bundles/${bundleId}/docs/${docId}`)).body.content).toBe("kept");
      expect((await alice.get(`/v1/user-docs/${userDocId}`)).body.content).toBe("kept");
    });
  });
});
