/**
 * Long text values. A `text` value has no length limit, and on both adapters it
 * must save and read back in full — on create and on update — however poorly
 * it compresses. Postgres refuses a btree index entry above ~2,700 bytes, so
 * the value index on `item_values` covers only a prefix of each value
 * (VALUE_INDEX_PREFIX characters); these tests pin that long values still
 * save, and that filters and `unique` stay exact when two long values share
 * that prefix and differ only after it.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBundle } from "../../src/core/bundles.js";
import { createItems, getItems, type ItemFilter, queryItems, updateItems } from "../../src/core/items.js";
import { listItemTypesUnchecked, updateProperty } from "../../src/core/itemTypes.js";
import { createSpace } from "../../src/core/spaces.js";
import { createUser } from "../../src/core/users.js";
import { VALUE_INDEX_PREFIX } from "../../src/db/valueIndex.js";
import type { Db } from "../../src/db/index.js";
import { describeEachAdapter } from "../helpers/adapters.js";

/** `chars` characters of random base64: incompressible, single-byte. */
function randomText(chars: number): string {
  return randomBytes(Math.ceil((chars * 3) / 4) + 3)
    .toString("base64")
    .slice(0, chars);
}

/** Random multibyte text (2–4 bytes per character), to push the byte count well past the character count. */
function randomMultibyte(chars: number): string {
  const pool = ["æ", "ø", "å", "€", "語", "文", "字", "🙂", "🚀", "ß", "λ", "ж"];
  const bytes = randomBytes(chars);
  let out = "";
  for (let i = 0; i < chars; i++) out += pool[bytes[i]! % pool.length];
  return out;
}

/** Random 4-byte characters only (emoji), so the indexed prefix is as wide in bytes as it can be. */
function randomEmoji(chars: number): string {
  const bytes = randomBytes(chars);
  let out = "";
  for (let i = 0; i < chars; i++) out += String.fromCodePoint(0x1f300 + bytes[i]!);
  return out;
}

describeEachAdapter("long text values", (adapter) => {
  let db: Db;
  let userId: string;
  let bundleId: string;

  beforeAll(async () => {
    db = await adapter.makeDb();
    const { user } = await createUser(db, { name: "Owner" });
    userId = user.id;
    const spaceId = (await createSpace(db, userId, { name: "S" })).id;
    const bundle = await createBundle(db, userId, spaceId, {
      name: "b",
      itemTypes: [
        {
          name: "doc",
          properties: [
            { name: "body", datatype: "text" },
            { name: "tags", datatype: "text", multi: true },
            { name: "key", datatype: "text", config: { unique: true } },
          ],
        },
        { name: "later", properties: [{ name: "code", datatype: "text" }] },
      ],
    });
    bundleId = bundle.id;
  });

  afterAll(async () => {
    await db.close();
  });

  const create = (itemType: string, values: Record<string, unknown>) =>
    createItems(db, userId, bundleId, { itemType, items: [values] }).then((r) => r[0]!);
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

  describe("saving (the reproduction)", () => {
    for (const [label, value] of [
      ["3 KB random", randomText(3_000)],
      ["10 KB random", randomText(10_000)],
      ["100 KB random", randomText(100_000)],
      ["10 KB multibyte", randomMultibyte(10_000)],
      // Every indexed character takes 4 bytes: the widest possible index entry.
      ["4-byte characters", randomEmoji(VALUE_INDEX_PREFIX + 50)],
    ] as const) {
      it(`saves and reads back ${label} on create`, async () => {
        const item = await create("doc", { body: value });
        const [read] = await getItems(db, userId, bundleId, [item.id]);
        expect(read!.values.body).toBe(value);
      });

      it(`saves and reads back ${label} on update`, async () => {
        const item = await create("doc", { body: "short" });
        await updateItems(db, userId, bundleId, [{ id: item.id, set: { body: value } }]);
        const [read] = await getItems(db, userId, bundleId, [item.id]);
        expect(read!.values.body).toBe(value);
      });
    }

    it("saves long values in a multi-valued property", async () => {
      const tags = [randomText(10_000), randomText(10_000)];
      const item = await create("doc", { tags });
      const [read] = await getItems(db, userId, bundleId, [item.id]);
      expect(read!.values.tags).toEqual(tags);
    });
  });

  describe("filters on long values sharing the index prefix", () => {
    // Three values identical through the indexed prefix, differing only after it.
    const prefix = randomText(VALUE_INDEX_PREFIX);
    const a = `${prefix}a${randomText(5_000)}`;
    const b = `${prefix}b${randomText(5_000)}`;
    const c = `${prefix}c${randomText(5_000)}`;
    let ia: string;
    let ib: string;
    let ic: string;
    let iShort: string;

    beforeAll(async () => {
      ia = (await create("doc", { body: a, tags: [a, "x"] })).id;
      ib = (await create("doc", { body: b, tags: [b] })).id;
      ic = (await create("doc", { body: c, tags: [c, "x"] })).id;
      iShort = (await create("doc", { body: "zzz", tags: ["x"] })).id;
    });

    const q = (property: string, op: string, value: unknown) =>
      queryItems(db, userId, bundleId, { itemType: "doc", filters: [{ property, op, value } as ItemFilter], limit: 100 }).then(
        (r) => ids(r.data),
      );

    it("equality matches exactly one of them", async () => {
      expect(await q("body", "eq", b)).toEqual([ib]);
      const neq = await q("body", "neq", b);
      expect(neq).toEqual(expect.arrayContaining([ia, ic, iShort]));
      expect(neq).not.toContain(ib);
    });

    it("range comparisons are exact past the prefix", async () => {
      // Other tests' rows share the type; look only at the three that share a prefix.
      const among = (rows: string[]) => rows.filter((id) => [ia, ib, ic].includes(id));
      expect(among(await q("body", "gt", a))).toEqual([ib, ic].sort());
      expect(among(await q("body", "gte", b))).toEqual([ib, ic].sort());
      expect(among(await q("body", "lt", c))).toEqual([ia, ib].sort());
      expect(among(await q("body", "lte", a))).toEqual([ia]);
    });

    it("in matches exactly", async () => {
      expect(await q("body", "in", [a, c])).toEqual([ia, ic].sort());
    });

    it("multi set operators match exactly", async () => {
      expect(await q("tags", "has", b)).toEqual([ib]);
      expect(await q("tags", "has_any", [a, b])).toEqual([ia, ib].sort());
      expect(await q("tags", "has_all", [a, "x"])).toEqual([ia]);
      const none = await q("tags", "has_none", [a, c]);
      expect(none).toContain(ib);
      expect(none).toContain(iShort);
      expect(none).not.toContain(ia);
      expect(none).not.toContain(ic);
    });
  });

  describe("unique on long values", () => {
    const prefix = randomText(VALUE_INDEX_PREFIX);
    const k1 = `${prefix}1${randomText(4_000)}`;
    const k2 = `${prefix}2${randomText(4_000)}`;

    it("rejects an exact duplicate long value", async () => {
      await create("doc", { key: k1 });
      await expect(create("doc", { key: k1 })).rejects.toThrow(/unique/i);
    });

    it("accepts two long values that differ only after the index prefix", async () => {
      const item = await create("doc", { key: k2 });
      expect(item.values.key).toBe(k2);
    });

    it("rejects an update to an existing long value", async () => {
      const other = await create("doc", { key: "other" });
      await expect(updateItems(db, userId, bundleId, [{ id: other.id, set: { key: k1 } }])).rejects.toThrow(
        /unique/i,
      );
    });

    it("enabling unique on a property holding such values: distinct ones pass, a duplicate is refused", async () => {
      const p = randomText(VALUE_INDEX_PREFIX);
      const v1 = `${p}1${randomText(3_000)}`;
      const v2 = `${p}2${randomText(3_000)}`;
      await create("later", { code: v1 });
      const dup = await create("later", { code: v2 });

      const types = await listItemTypesUnchecked(db, bundleId);
      const type = types.find((t) => t.name === "later")!;
      const prop = type.properties.find((x) => x.name === "code")!;
      await updateProperty(db, userId, type.id, prop.id, { config: { unique: true } });

      await updateProperty(db, userId, type.id, prop.id, { config: {} });
      await updateItems(db, userId, bundleId, [{ id: dup.id, set: { code: v1 } }]);
      await expect(updateProperty(db, userId, type.id, prop.id, { config: { unique: true } })).rejects.toThrow(
        /duplicate|unique/i,
      );
    });
  });
});
