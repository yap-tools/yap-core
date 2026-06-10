/**
 * Multi-valued properties: array write/read with order, replace-on-update,
 * required semantics, the explicit query operators (has/has_any/has_all/
 * has_none + quantifier any/all/none), sort-by-multi, and schema conversion.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBundle } from "../../src/core/bundles.js";
import {
  createItems,
  deleteItems,
  getItems,
  queryItems,
  updateItems,
} from "../../src/core/items.js";
import { listItemTypesUnchecked, updateProperty } from "../../src/core/itemTypes.js";
import { createSpace } from "../../src/core/spaces.js";
import { createUser } from "../../src/core/users.js";
import type { Db } from "../../src/db/index.js";
import { describeEachAdapter } from "../helpers/adapters.js";

describeEachAdapter("multi-valued items", (adapter) => {
  let db: Db;
  let userId: string;
  let bundleId: string;

  const titles = (rows: { values: Record<string, unknown> }[]) =>
    rows.map((r) => r.values.title).sort();
  const q = (filters?: any[], extra: Record<string, unknown> = {}) =>
    queryItems(db, userId, bundleId, { itemType: "doc", filters, ...extra });

  beforeAll(async () => {
    db = await adapter.makeDb();
    const { user } = await createUser(db, { name: "Owner" });
    userId = user.id;
    const space = await createSpace(db, userId, { name: "S" });
    const bundle = await createBundle(db, userId, space.id, {
      name: "docs",
      itemTypes: [
        {
          name: "doc",
          properties: [
            { name: "title", datatype: "text", required: true },
            { name: "tags", datatype: "text", multi: true },
            { name: "scores", datatype: "number", multi: true },
            { name: "labels", datatype: "text", multi: true, required: true },
          ],
        },
      ],
    });
    bundleId = bundle.id;
    await createItems(db, userId, bundleId, {
      itemType: "doc",
      items: [
        { title: "A", tags: ["red", "urgent"], scores: [2, 8], labels: ["x"] },
        { title: "B", tags: ["blue"], scores: [10], labels: ["x", "y"] },
        { title: "C", tags: ["red", "blue", "green"], scores: [5, 5], labels: ["y"] },
        { title: "D", tags: [], scores: [], labels: ["z"] }, // empty optional multis
      ],
    });
  });

  afterAll(async () => {
    await db.close();
  });

  describe("write & read", () => {
    it("stores and returns ordered arrays for multi properties, scalars for single", async () => {
      const [a] = await getItems(db, userId, bundleId, [(await q([{ property: "title", op: "eq", value: "A" }])).data[0]!.id]);
      expect(a!.values.title).toBe("A"); // single → scalar
      expect(a!.values.tags).toEqual(["red", "urgent"]); // multi → ordered array
      expect(a!.values.scores).toEqual([2, 8]); // numeric cast preserved
    });

    it("preserves element order and duplicates", async () => {
      const c = (await q([{ property: "title", op: "eq", value: "C" }])).data[0]!;
      expect(c.values.tags).toEqual(["red", "blue", "green"]);
      expect(c.values.scores).toEqual([5, 5]); // duplicates kept
    });

    it("omits empty optional multi properties (no rows)", async () => {
      const d = (await q([{ property: "title", op: "eq", value: "D" }])).data[0]!;
      expect(d.values.tags).toBeUndefined();
      expect(d.values.scores).toBeUndefined();
      expect(d.values.labels).toEqual(["z"]);
    });

    it("accepts a bare scalar for a multi property (coerced to one element)", async () => {
      const [item] = await createItems(db, userId, bundleId, {
        itemType: "doc",
        items: [{ title: "Scalar", tags: "solo", labels: "L" }],
      });
      expect(item!.values.tags).toEqual(["solo"]);
      await deleteItems(db, userId, bundleId, [item!.id]);
    });

    it("rejects an array for a single-valued property", async () => {
      await expect(
        createItems(db, userId, bundleId, { itemType: "doc", items: [{ title: ["nope"], labels: ["x"] }] }),
      ).rejects.toThrow(/single-valued/);
    });

    it("validates each element and names the failure", async () => {
      await expect(
        createItems(db, userId, bundleId, {
          itemType: "doc",
          items: [{ title: "Bad", scores: [1, "two"], labels: ["x"] }],
        }),
      ).rejects.toThrow(/expects a finite number/);
    });

    it("required multi needs at least one element", async () => {
      await expect(
        createItems(db, userId, bundleId, { itemType: "doc", items: [{ title: "NoLabels", labels: [] }] }),
      ).rejects.toThrow(/required property "labels" is missing \(needs at least one value\)/);
    });

    it("update replaces the whole set; clearing an optional multi removes it", async () => {
      const [item] = await createItems(db, userId, bundleId, {
        itemType: "doc",
        items: [{ title: "Mut", tags: ["one", "two"], labels: ["x"] }],
      });
      const [u1] = await updateItems(db, userId, bundleId, [{ id: item!.id, set: { tags: ["three"] } }]);
      expect(u1!.values.tags).toEqual(["three"]); // replaced, not appended
      const [u2] = await updateItems(db, userId, bundleId, [{ id: item!.id, set: { tags: [] } }]);
      expect(u2!.values.tags).toBeUndefined(); // cleared
      await expect(
        updateItems(db, userId, bundleId, [{ id: item!.id, set: { labels: [] } }]),
      ).rejects.toThrow(/required property "labels" cannot be cleared/);
      await deleteItems(db, userId, bundleId, [item!.id]);
    });
  });

  describe("set operators", () => {
    it("has — set contains the value", async () => {
      expect(titles((await q([{ property: "tags", op: "has", value: "red" }])).data)).toEqual(["A", "C"]);
    });

    it("has_any — intersects the list", async () => {
      expect(titles((await q([{ property: "tags", op: "has_any", value: ["green", "blue"] }])).data)).toEqual([
        "B",
        "C",
      ]);
    });

    it("has_all — superset of the list", async () => {
      expect(titles((await q([{ property: "tags", op: "has_all", value: ["red", "blue"] }])).data)).toEqual(["C"]);
      // duplicate operands are deduped, so this still matches C
      expect(titles((await q([{ property: "tags", op: "has_all", value: ["red", "red"] }])).data)).toEqual([
        "A",
        "C",
      ]);
    });

    it("has_none — disjoint from the list (incl. the empty set)", async () => {
      // D has no tags → counts as containing none of them.
      expect(titles((await q([{ property: "tags", op: "has_none", value: ["red", "blue"] }])).data)).toEqual([
        "D",
      ]);
    });

    it("has works for numeric multi (datatype-aware)", async () => {
      expect(titles((await q([{ property: "scores", op: "has", value: 10 }])).data)).toEqual(["B"]);
      expect(titles((await q([{ property: "scores", op: "has_any", value: [8, 5] }])).data)).toEqual(["A", "C"]);
    });
  });

  describe("quantifiers on comparison ops", () => {
    it("any (default) — some element satisfies", async () => {
      expect(titles((await q([{ property: "scores", op: "gt", value: 7 }])).data)).toEqual(["A", "B"]);
    });

    it("all — every element satisfies (and the set is non-empty)", async () => {
      // A=[2,8] has a 2, so not all>3; B=[10] all>3; C=[5,5] all>3; D=[] excluded.
      expect(titles((await q([{ property: "scores", op: "gt", value: 3, quantifier: "all" }])).data)).toEqual([
        "B",
        "C",
      ]);
    });

    it("none — no element satisfies", async () => {
      // no element equal to 5: A,B qualify (C has 5); D has no scores → none satisfy → included.
      expect(titles((await q([{ property: "scores", op: "eq", value: 5, quantifier: "none" }])).data)).toEqual([
        "A",
        "B",
        "D",
      ]);
    });

    it("eq any vs the set — membership via comparison op", async () => {
      expect(titles((await q([{ property: "tags", op: "eq", value: "blue", quantifier: "any" }])).data)).toEqual([
        "B",
        "C",
      ]);
    });
  });

  describe("sorting & schema evolution", () => {
    it("sorts by a multi property's first element", async () => {
      const asc = await q(undefined, { sort: { property: "scores", direction: "asc" } });
      // first elements: A=2, C=5, B=10, D=missing(last)
      expect(asc.data.map((i) => i.values.title)).toEqual(["A", "C", "B", "D"]);
    });

    it("single→multi conversion is free; existing scalar reads back as a one-element array", async () => {
      const [type] = await listItemTypesUnchecked(db, bundleId);
      const title = type!.properties.find((p) => p.name === "title")!;
      await updateProperty(db, userId, type!.id, title.id, { multi: true });
      const a = (await q([{ property: "tags", op: "has", value: "urgent" }])).data[0]!;
      expect(a.values.title).toEqual(["A"]); // was scalar, now a 1-element list
      await updateProperty(db, userId, type!.id, title.id, { multi: false }); // revert (each item has 1)
    });

    it("multi→single conversion is rejected when an item has multiple values", async () => {
      const [type] = await listItemTypesUnchecked(db, bundleId);
      const tags = type!.properties.find((p) => p.name === "tags")!;
      await expect(updateProperty(db, userId, type!.id, tags.id, { multi: false })).rejects.toThrow(
        /cannot convert "tags" to single-valued/,
      );
    });
  });
});
