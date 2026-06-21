/**
 * Property constraints + reference datatypes. These all live in core
 * (propertyConfig.ts + items.ts), beneath both REST and MCP, so testing them
 * here proves the single enforcement path: regex, number bounds/decimals,
 * multi item bounds, item/file references (existence, in-bundle, type pin),
 * schema-authoring config validation, and the dangling-reference read.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBundle } from "../../src/core/bundles.js";
import { createItems, deleteItems, getItems, queryItems, updateItems } from "../../src/core/items.js";
import { addProperty, listItemTypesUnchecked, updateProperty } from "../../src/core/itemTypes.js";
import { createSpace } from "../../src/core/spaces.js";
import { createUser } from "../../src/core/users.js";
import type { Db } from "../../src/db/index.js";
import { describeEachAdapter } from "../helpers/adapters.js";

describeEachAdapter("property constraints & reference datatypes", (adapter) => {
  let db: Db;
  let userId: string;
  let spaceId: string;
  let bundleId: string;

  /** Inserts a finalized file fixture directly (the upload lifecycle is tested elsewhere). */
  async function makeFile(bundle: string, status: "finalized" | "reserved" = "finalized"): Promise<string> {
    const id = randomUUID();
    await db.client.insert(db.tables.files).values({
      id,
      bundleId: bundle,
      spaceId,
      ownerId: userId,
      status,
      name: "f.txt",
      mimeType: "text/plain",
      size: 3,
      storageKey: `k/${id}`,
      uploadConsumed: 1,
      createdAt: new Date().toISOString(),
      finalizedAt: status === "finalized" ? new Date().toISOString() : null,
    });
    return id;
  }

  beforeAll(async () => {
    db = await adapter.makeDb();
    const { user } = await createUser(db, { name: "Owner" });
    userId = user.id;
    spaceId = (await createSpace(db, userId, { name: "S" })).id;
    const bundle = await createBundle(db, userId, spaceId, {
      name: "b",
      itemTypes: [
        {
          name: "thing",
          properties: [
            { name: "sku", datatype: "text", config: { pattern: "^[A-Z]{3}-\\d+$" } },
            { name: "price", datatype: "number", config: { min: 0, max: 1000 } },
            { name: "ratio", datatype: "number", config: { decimals: 4 } },
            { name: "plain", datatype: "number" }, // default 2 decimals
            { name: "tags", datatype: "text", multi: true, config: { minItems: 2, maxItems: 3 } },
            { name: "status", datatype: "text", config: { enum: ["open", "closed"] } },
            { name: "colors", datatype: "text", multi: true, config: { enum: ["red", "green", "blue"] } },
          ],
        },
        { name: "other", properties: [{ name: "label", datatype: "text" }] },
      ],
    });
    bundleId = bundle.id;
  });

  afterAll(async () => {
    await db.close();
  });

  const mk = (values: Record<string, unknown>) => createItems(db, userId, bundleId, { itemType: "thing", items: [values] });

  describe("text regex", () => {
    it("accepts a matching value and rejects a non-matching one", async () => {
      const [ok] = await mk({ sku: "ABC-12" });
      expect(ok!.values.sku).toBe("ABC-12");
      await expect(mk({ sku: "abc-12" })).rejects.toThrow(/must match/);
      await expect(mk({ sku: "ABCD-1" })).rejects.toThrow(/must match/);
    });
  });

  describe("number bounds & decimals", () => {
    it("enforces inclusive min/max", async () => {
      expect((await mk({ price: 0 }))[0]!.values.price).toBe(0);
      expect((await mk({ price: 1000 }))[0]!.values.price).toBe(1000);
      await expect(mk({ price: -1 })).rejects.toThrow(/must be >= 0/);
      await expect(mk({ price: 1000.01 })).rejects.toThrow(/must be <= 1000/);
    });

    it("rejects more than 2 decimals by default, accepts the configured precision", async () => {
      expect((await mk({ plain: 3.14 }))[0]!.values.plain).toBe(3.14);
      await expect(mk({ plain: 3.141 })).rejects.toThrow(/at most 2 decimal/);
      expect((await mk({ ratio: 0.1234 }))[0]!.values.ratio).toBe(0.1234);
      await expect(mk({ ratio: 0.12345 })).rejects.toThrow(/at most 4 decimal/);
    });
  });

  describe("multi minItems/maxItems", () => {
    it("bounds the element count of a populated multi field", async () => {
      expect((await mk({ tags: ["a", "b", "c"] }))[0]!.values.tags).toEqual(["a", "b", "c"]);
      await expect(mk({ tags: ["a", "b", "c", "d"] })).rejects.toThrow(/at most 3 value/);
      await expect(mk({ tags: ["a"] })).rejects.toThrow(/at least 2 value/);
      // an explicit empty array clears the field (defers to `required`); tags is
      // optional, so empty and absent are both fine.
      expect((await mk({ tags: [] }))[0]!.values.tags).toBeUndefined();
      expect((await mk({ sku: "ABC-9" }))[0]!.values.tags).toBeUndefined();
    });
  });

  describe("text enum", () => {
    it("accepts a listed value and rejects an unlisted one", async () => {
      expect((await mk({ status: "open" }))[0]!.values.status).toBe("open");
      expect((await mk({ status: "closed" }))[0]!.values.status).toBe("closed");
      await expect(mk({ status: "pending" })).rejects.toThrow(/must be one of: open, closed/);
    });

    it("enforces membership per element for a multi enum", async () => {
      expect((await mk({ colors: ["red", "blue"] }))[0]!.values.colors).toEqual(["red", "blue"]);
      await expect(mk({ colors: ["red", "purple"] })).rejects.toThrow(/must be one of: red, green, blue/);
    });
  });

  describe("item reference datatype", () => {
    let refBundleId: string;
    let refTypeId: string;
    let targetId: string;

    beforeAll(async () => {
      const b = await createBundle(db, userId, spaceId, {
        name: "refs",
        itemTypes: [
          { name: "target", properties: [{ name: "name", datatype: "text" }] },
          { name: "decoy", properties: [{ name: "name", datatype: "text" }] },
        ],
      });
      refBundleId = b.id;
      targetId = (await createItems(db, userId, refBundleId, { itemType: "target", items: [{ name: "T" }] }))[0]!.id;
      const types = await listItemTypesUnchecked(db, refBundleId);
      refTypeId = types.find((t) => t.name === "target")!.id;
      // a "link" property referencing an item, pinned to the "target" type
      await addProperty(db, userId, refTypeId, {
        name: "rel",
        datatype: "item",
        config: { itemType: "target" },
      });
    });

    const mkRef = (values: Record<string, unknown>) =>
      createItems(db, userId, refBundleId, { itemType: "target", items: [values] });

    it("accepts a bare id or a full item:// uri and canonicalizes to item://", async () => {
      const bare = (await mkRef({ name: "A", rel: targetId }))[0]!;
      expect(bare.values.rel).toBe(`item://${targetId}`);
      const uri = (await mkRef({ name: "B", rel: `item://${targetId}` }))[0]!;
      expect(uri.values.rel).toBe(`item://${targetId}`);
    });

    it("rejects a reference to a non-existent or cross-bundle item", async () => {
      await expect(mkRef({ name: "C", rel: randomUUID() })).rejects.toThrow(/not an item in this bundle/);
      // an item that exists, but in the other bundle
      const foreign = (await mk({ sku: "ABC-1" }))[0]!.id;
      await expect(mkRef({ name: "D", rel: foreign })).rejects.toThrow(/not an item in this bundle/);
    });

    it("enforces the config.itemType pin", async () => {
      const decoy = (await createItems(db, userId, refBundleId, { itemType: "decoy", items: [{ name: "X" }] }))[0]!.id;
      await expect(mkRef({ name: "E", rel: decoy })).rejects.toThrow(/must reference an item of type "target"/);
    });

    it("filters by reference (bare id is canonicalized)", async () => {
      const page = await queryItems(db, userId, refBundleId, {
        itemType: "target",
        filters: [{ property: "rel", op: "eq", value: targetId }],
      });
      expect(page.data.length).toBeGreaterThanOrEqual(2);
      expect(page.data.every((r) => r.values.rel === `item://${targetId}`)).toBe(true);
    });

    it("leaves a dangling reference when the referent is deleted (resolves later, not at read)", async () => {
      const holder = (await mkRef({ name: "H", rel: targetId }))[0]!;
      const victim = (await mkRef({ name: "V" }))[0]!.id;
      const linked = (await updateItems(db, userId, refBundleId, [{ id: holder.id, set: { rel: victim } }]))[0]!;
      expect(linked.values.rel).toBe(`item://${victim}`);
      await deleteItems(db, userId, refBundleId, [victim]);
      const [reread] = await getItems(db, userId, refBundleId, [holder.id]);
      expect(reread!.values.rel).toBe(`item://${victim}`); // still stored, now dangling
    });
  });

  describe("file reference datatype", () => {
    let fileTypeId: string;

    beforeAll(async () => {
      const types = await listItemTypesUnchecked(db, bundleId);
      fileTypeId = types.find((t) => t.name === "thing")!.id;
      await addProperty(db, userId, fileTypeId, { name: "doc", datatype: "file" });
    });

    it("accepts a finalized file in the bundle, rejects missing/reserved/cross-bundle", async () => {
      const fileId = await makeFile(bundleId, "finalized");
      const ok = (await mk({ sku: "ABC-7", doc: fileId }))[0]!;
      expect(ok.values.doc).toBe(`file://${fileId}`);

      await expect(mk({ sku: "ABC-8", doc: randomUUID() })).rejects.toThrow(/not a finalized file in this bundle/);
      const reserved = await makeFile(bundleId, "reserved");
      await expect(mk({ sku: "ABC-6", doc: reserved })).rejects.toThrow(/not a finalized file in this bundle/);
    });
  });

  describe("schema-authoring config validation", () => {
    // createBundle aggregates property errors into one "invalid bundle design"
    // YapError whose details.errors holds the specifics.
    const badBundle = (name: string, prop: Record<string, unknown>, re: RegExp) =>
      expect(
        createBundle(db, userId, spaceId, {
          name,
          itemTypes: [{ name: "t", properties: [{ name: "p", ...prop } as never] }],
        }),
      ).rejects.toMatchObject({ details: { errors: expect.arrayContaining([expect.stringMatching(re)]) } });

    it("rejects invalid config at bundle creation", async () => {
      await badBundle("bad1", { datatype: "text", config: { pattern: "(" } }, /not a valid regular expression/);
      await badBundle("bad2", { datatype: "number", config: { min: 10, max: 1 } }, /cannot exceed config\.max/);
      await badBundle("bad3", { datatype: "text", config: { minItems: 1 } }, /not valid for a text property/);
      await badBundle("bad4", { datatype: "number", config: { pattern: "x" } }, /not valid for a number property/);
      await badBundle("bad5", { datatype: "number", config: { enum: ["x"] } }, /not valid for a number property/);
      await badBundle("bad6", { datatype: "text", config: { enum: [] } }, /non-empty array/);
      await badBundle("bad7", { datatype: "text", config: { enum: ["a", "a"] } }, /duplicate/);
      await badBundle("bad8", { datatype: "text", config: { enum: ["a", ""] } }, /non-empty strings/);
    });

    it("validates config on addProperty and updateProperty", async () => {
      const types = await listItemTypesUnchecked(db, bundleId);
      const typeId = types.find((t) => t.name === "other")!.id;
      await expect(
        addProperty(db, userId, typeId, { name: "bad", datatype: "number", config: { min: 5, max: 1 } }),
      ).rejects.toThrow(/cannot exceed config.max/);

      const prop = await addProperty(db, userId, typeId, { name: "score", datatype: "number" });
      await expect(
        updateProperty(db, userId, typeId, prop.id, { config: { decimals: -1 } }),
      ).rejects.toThrow(/non-negative integer/);
      const updated = await updateProperty(db, userId, typeId, prop.id, { config: { min: 0, max: 100 } });
      expect(updated.config).toBe(JSON.stringify({ min: 0, max: 100 }));
    });
  });
});
