/**
 * Deep coverage of the EAV layer against real databases: query semantics
 * (every op × datatype), sort, cursors, write-time validation, schema
 * mutation after data exists, cascade deletion.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBundle } from "../../src/core/bundles.js";
import { YapError } from "../../src/core/errors.js";
import {
  addProperty,
  deleteProperty,
  listItemTypesUnchecked,
  updateProperty,
} from "../../src/core/itemTypes.js";
import {
  createItems,
  deleteItems,
  getItems,
  queryItems,
  updateItems,
} from "../../src/core/items.js";
import { createSpace } from "../../src/core/spaces.js";
import { createUser } from "../../src/core/users.js";
import type { Db } from "../../src/db/index.js";
import { describeEachAdapter } from "../helpers/adapters.js";

describeEachAdapter("EAV items", (adapter) => {
  let db: Db;
  let userId: string;
  let bundleId: string;

  const q = (filters?: any[], extra: Record<string, unknown> = {}) =>
    queryItems(db, userId, bundleId, { itemType: "todo", filters, ...extra });

  beforeAll(async () => {
    db = await adapter.makeDb();
    const { user } = await createUser(db, { name: "Owner" });
    userId = user.id;
    const space = await createSpace(db, userId, { name: "Work" });
    const bundle = await createBundle(db, userId, space.id, {
      name: "todos",
      docs: [{ name: "instructions", content: "Track todos.", autoload: true }],
      itemTypes: [
        {
          name: "todo",
          properties: [
            { name: "title", datatype: "text", required: true },
            { name: "status", datatype: "text", required: true },
            { name: "priority", datatype: "number" },
            { name: "done", datatype: "boolean" },
            { name: "due", datatype: "date" },
          ],
        },
      ],
    });
    bundleId = bundle.id;
    await createItems(db, userId, bundleId, {
      itemType: "todo",
      items: [
        { title: "Write spec", status: "open", priority: 2, done: false, due: "2026-06-20T00:00:00Z" },
        { title: "Review PR", status: "open", priority: 10, done: false, due: "2026-06-11T00:00:00Z" },
        { title: "Ship release", status: "done", priority: 1, done: true, due: "2026-06-01T00:00:00Z" },
        { title: "Plan offsite", status: "blocked", priority: 5, done: false }, // no due date
      ],
    });
  });

  afterAll(async () => {
    await db.close();
  });

  describe("query semantics", () => {
    it('answers the motivating example: status eq "open"', async () => {
      const page = await q([{ property: "status", op: "eq", value: "open" }]);
      expect(page.data.map((i) => i.values.title).sort()).toEqual(["Review PR", "Write spec"]);
    });

    it("neq matches items that have a differing value", async () => {
      const page = await q([{ property: "status", op: "neq", value: "open" }]);
      expect(page.data.map((i) => i.values.title).sort()).toEqual(["Plan offsite", "Ship release"]);
    });

    it("contains is case-insensitive substring match", async () => {
      const page = await q([{ property: "title", op: "contains", value: "REVIEW" }]);
      expect(page.data.map((i) => i.values.title)).toEqual(["Review PR"]);
    });

    it("contains escapes LIKE wildcards", async () => {
      await createItems(db, userId, bundleId, {
        itemType: "todo",
        items: [{ title: "100% coverage", status: "open" }],
      });
      const page = await q([{ property: "title", op: "contains", value: "100%" }]);
      expect(page.data.map((i) => i.values.title)).toEqual(["100% coverage"]);
      const noMatch = await q([{ property: "title", op: "contains", value: "1000" }]);
      expect(noMatch.data).toEqual([]);
      await deleteItems(db, userId, bundleId, page.data.map((i) => i.id));
    });

    it("numeric comparison respects the number datatype, not text order", async () => {
      // Lexicographically "10" < "2"; numerically 10 > 2 — datatype must win.
      const page = await q([{ property: "priority", op: "gt", value: 2 }]);
      expect(page.data.map((i) => i.values.title).sort()).toEqual(["Plan offsite", "Review PR"]);
      const lte = await q([{ property: "priority", op: "lte", value: 2 }]);
      expect(lte.data.map((i) => i.values.title).sort()).toEqual(["Ship release", "Write spec"]);
    });

    it("boolean eq", async () => {
      const page = await q([{ property: "done", op: "eq", value: true }]);
      expect(page.data.map((i) => i.values.title)).toEqual(["Ship release"]);
    });

    it("date range comparison is chronological", async () => {
      const page = await q([{ property: "due", op: "gte", value: "2026-06-10T00:00:00Z" }]);
      expect(page.data.map((i) => i.values.title).sort()).toEqual(["Review PR", "Write spec"]);
    });

    it("in matches any listed value", async () => {
      const page = await q([{ property: "status", op: "in", value: ["done", "blocked"] }]);
      expect(page.data.map((i) => i.values.title).sort()).toEqual(["Plan offsite", "Ship release"]);
    });

    it("multiple filters AND-combine", async () => {
      const page = await q([
        { property: "status", op: "eq", value: "open" },
        { property: "priority", op: "gt", value: 5 },
      ]);
      expect(page.data.map((i) => i.values.title)).toEqual(["Review PR"]);
    });

    it("filters on absent values match nothing (no value row to compare)", async () => {
      const page = await q([{ property: "due", op: "lt", value: "1990-01-01" }]);
      expect(page.data).toEqual([]);
      const neq = await q([{ property: "due", op: "neq", value: "2026-06-20T00:00:00Z" }]);
      // "Plan offsite" has no due value row, so neq does not match it.
      expect(neq.data.map((i) => i.values.title).sort()).toEqual(["Review PR", "Ship release"]);
    });

    it("rejects unknown properties and malformed operands with actionable errors", async () => {
      await expect(q([{ property: "nope", op: "eq", value: "x" }])).rejects.toThrow(/unknown property "nope"/);
      await expect(q([{ property: "priority", op: "eq", value: "high" }])).rejects.toThrow(/expects a number/);
      await expect(q([{ property: "status", op: "in", value: [] }])).rejects.toThrow(/non-empty array/);
    });

    it("sorts by a property with direction, missing values last either way", async () => {
      const asc = await q(undefined, { sort: { property: "due", direction: "asc" } });
      expect(asc.data.map((i) => i.values.title)).toEqual([
        "Ship release",
        "Review PR",
        "Write spec",
        "Plan offsite", // missing due — last
      ]);
      const desc = await q(undefined, { sort: { property: "due", direction: "desc" } });
      expect(desc.data.map((i) => i.values.title)).toEqual([
        "Write spec",
        "Review PR",
        "Ship release",
        "Plan offsite", // still last
      ]);
    });

    it("sorts numerically for number properties", async () => {
      const page = await q(undefined, { sort: { property: "priority", direction: "desc" } });
      expect(page.data.map((i) => i.values.priority)).toEqual([10, 5, 2, 1]);
    });

    it("paginates with opaque cursors and a stable order", async () => {
      const page1 = await q(undefined, { sort: { property: "priority", direction: "asc" }, limit: 3 });
      expect(page1.data).toHaveLength(3);
      expect(page1.nextCursor).toBeTruthy();
      const page2 = await q(undefined, {
        sort: { property: "priority", direction: "asc" },
        limit: 3,
        cursor: page1.nextCursor!,
      });
      expect(page2.data).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();
      const all = [...page1.data, ...page2.data].map((i) => i.values.priority);
      expect(all).toEqual([1, 2, 5, 10]);
    });
  });

  describe("write-time validation", () => {
    it("rejects items missing required properties, naming the item and property", async () => {
      await expect(
        createItems(db, userId, bundleId, {
          itemType: "todo",
          items: [{ title: "ok", status: "open" }, { title: "missing status" }],
        }),
      ).rejects.toMatchObject({
        code: "invalid_request",
        details: { errors: [expect.stringContaining('items[1]: required property "status" is missing')] },
      });
      // Nothing partially applied: the valid item[0] was not created either.
      const page = await q([{ property: "title", op: "eq", value: "ok" }]);
      expect(page.data).toEqual([]);
    });

    it("rejects unknown properties and wrong datatypes", async () => {
      await expect(
        createItems(db, userId, bundleId, {
          itemType: "todo",
          items: [{ title: "x", status: "open", bogus: 1 }],
        }),
      ).rejects.toThrow(/unknown property "bogus"/);
      await expect(
        createItems(db, userId, bundleId, {
          itemType: "todo",
          items: [{ title: "x", status: "open", priority: "high" }],
        }),
      ).rejects.toThrow(/expects a finite number/);
    });

    it("updates values, clears optional values, refuses clearing required ones", async () => {
      const [item] = await createItems(db, userId, bundleId, {
        itemType: "todo",
        items: [{ title: "Mutable", status: "open", priority: 3 }],
      });
      const [updated] = await updateItems(db, userId, bundleId, [
        { id: item!.id, set: { status: "done", priority: null } },
      ]);
      expect(updated!.values.status).toBe("done");
      expect(updated!.values.priority).toBeUndefined();
      await expect(
        updateItems(db, userId, bundleId, [{ id: item!.id, set: { title: null } }]),
      ).rejects.toThrow(/required property "title" cannot be cleared/);
      await deleteItems(db, userId, bundleId, [item!.id]);
    });

    it("get_items fetches by id in input order", async () => {
      const all = await q(undefined, { sort: { property: "priority", direction: "asc" } });
      const ids = [all.data[2]!.id, all.data[0]!.id];
      const fetched = await getItems(db, userId, bundleId, ids);
      expect(fetched.map((i) => i.id)).toEqual(ids);
    });
  });

  describe("schema evolution with data in place", () => {
    it("renaming a property keeps every stored value reachable under the new name", async () => {
      const [type] = await listItemTypesUnchecked(db, bundleId);
      const priority = type!.properties.find((p) => p.name === "priority")!;
      await updateProperty(db, userId, type!.id, priority.id, { name: "urgency" });
      const page = await queryItems(db, userId, bundleId, {
        itemType: "todo",
        filters: [{ property: "urgency", op: "gte", value: 5 }],
      });
      expect(page.data.map((i) => i.values.urgency).sort()).toEqual([10, 5]);
      await updateProperty(db, userId, type!.id, priority.id, { name: "priority" });
    });

    it("adding a required property does not invalidate existing items", async () => {
      const [type] = await listItemTypesUnchecked(db, bundleId);
      const added = await addProperty(db, userId, type!.id, {
        name: "owner",
        datatype: "text",
        required: true,
      });
      const page = await q();
      expect(page.data.length).toBeGreaterThan(0); // existing items still read fine
      // But new writes must include it.
      await expect(
        createItems(db, userId, bundleId, { itemType: "todo", items: [{ title: "x", status: "open" }] }),
      ).rejects.toThrow(/required property "owner" is missing/);
      await deleteProperty(db, userId, type!.id, added.id);
    });

    it("deleting a property cascade-deletes its value rows immediately", async () => {
      const [type] = await listItemTypesUnchecked(db, bundleId);
      const added = await addProperty(db, userId, type!.id, { name: "ephemeral", datatype: "text" });
      const [item] = await createItems(db, userId, bundleId, {
        itemType: "todo",
        items: [{ title: "Has ephemeral", status: "open", ephemeral: "v" }],
      });
      const { itemValues } = db.tables;
      const before = await db.client.select().from(itemValues).where(eq(itemValues.propertyId, added.id));
      expect(before).toHaveLength(1);
      await deleteProperty(db, userId, type!.id, added.id);
      const after = await db.client.select().from(itemValues).where(eq(itemValues.propertyId, added.id));
      expect(after).toEqual([]); // no orphans
      const [reread] = await getItems(db, userId, bundleId, [item!.id]);
      expect(reread!.values.ephemeral).toBeUndefined();
      await deleteItems(db, userId, bundleId, [item!.id]);
    });

    it("deleting items cascade-deletes their value rows", async () => {
      const [item] = await createItems(db, userId, bundleId, {
        itemType: "todo",
        items: [{ title: "Doomed", status: "open" }],
      });
      const { itemValues } = db.tables;
      const before = await db.client.select().from(itemValues).where(eq(itemValues.itemId, item!.id));
      expect(before.length).toBeGreaterThan(0);
      const count = await deleteItems(db, userId, bundleId, [item!.id]);
      expect(count).toBe(1);
      const after = await db.client.select().from(itemValues).where(eq(itemValues.itemId, item!.id));
      expect(after).toEqual([]);
    });
  });

  describe("capability gates", () => {
    it("a stranger with no access sees the bundle as absent (not_found), not forbidden", async () => {
      // A principal with no capability on the bundle must not be able to tell
      // it exists: reads and writes alike return not_found, matching the
      // bundle resource. (A member who can see the bundle but lacks the
      // specific capability still gets forbidden — see bundle-existence.test.)
      const { user: stranger } = await createUser(db, { name: "Stranger" });
      await expect(
        q().then(() => queryItems(db, stranger.id, bundleId, { itemType: "todo" })),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        createItems(db, stranger.id, bundleId, { itemType: "todo", items: [{ title: "x", status: "open" }] }),
      ).rejects.toMatchObject({ code: "not_found" });
    });
  });
});
