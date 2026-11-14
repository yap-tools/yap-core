/**
 * The 0012 step: `item_values_prop_value_idx (property_id, value)` is replaced
 * by `item_values_prop_value_prefix_idx (property_id, substr(value, 1, 600))`
 * (see src/db/valueIndex.ts). Seeded through journal index 11, the head before
 * it, then migrated forward on both dialects. Pinned here: only the index
 * changes, so stored values read back untouched, and a value too long for the
 * old index on Postgres now saves.
 */
import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";
import { expect, it } from "vitest";

import type { Db } from "../../src/db/index.js";
import { describeEachAdapter, rawAll, type Adapter } from "../helpers/adapters.js";

const now = "2026-01-01T00:00:00.000Z";

/** The value index(es) on item_values, with their definitions. */
async function valueIndexDefs(adapter: Adapter, db: Db): Promise<{ name: string; def: string }[]> {
  return rawAll<{ name: string; def: string }>(
    db,
    adapter.dialect === "pg"
      ? "SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE tablename = 'item_values' AND indexname LIKE 'item_values_prop%'"
      : "SELECT name, sql AS def FROM sqlite_master WHERE type = 'index' AND tbl_name = 'item_values' AND name LIKE 'item_values_prop%'",
  );
}

const valueIndexes = async (adapter: Adapter, db: Db) => (await valueIndexDefs(adapter, db)).map((r) => r.name);

describeEachAdapter("migration-0012", (adapter) => {
  it("swaps the value index for a prefix index and leaves the data alone", async () => {
    const db = await adapter.makeFreshDb();
    try {
      await db.migrateTo(11); // apply through 0011 (the head before the prefix index)
      expect(await valueIndexes(adapter, db)).toEqual(["item_values_prop_value_idx"]);

      await db.insertRows("users", [{ id: "u1", name: "ada", created_at: now }]);
      await db.insertRows("spaces", [
        {
          id: "s1",
          owner_id: "u1",
          name: "S",
          description: "",
          keywords: "",
          context: "",
          personal: 0,
          created_at: now,
          updated_at: now,
        },
      ]);
      await db.insertRows("bundles", [
        { id: "b1", space_id: "s1", name: "B", description: "", created_at: now, updated_at: now },
      ]);
      await db.insertRows("item_types", [{ id: "t1", bundle_id: "b1", name: "doc", created_at: now }]);
      await db.insertRows("properties", [
        { id: "p1", item_type_id: "t1", name: "body", datatype: "text", required: 0, multi: 0, config: "{}", sort_order: 0 },
      ]);
      await db.insertRows("items", [
        { id: "i1", item_type_id: "t1", bundle_id: "b1", created_at: now, updated_at: now },
        { id: "i2", item_type_id: "t1", bundle_id: "b1", created_at: now, updated_at: now },
      ]);
      // A value that fits the old index (under its ~2,700-byte entry limit).
      const before = randomBytes(1_500).toString("base64").slice(0, 2_000);
      await db.insertRows("item_values", [{ id: "v1", item_id: "i1", property_id: "p1", value: before, position: 0 }]);

      await db.migrate(); // apply the rest, incl. 0012
      expect(await db.appliedMigrations()).toBe(db.journalLength());
      const [def] = await valueIndexDefs(adapter, db);
      expect(def!.name).toBe("item_values_prop_value_prefix_idx");
      // The SQLite statement was corrected by hand; pin its shape on both.
      expect(def!.def.replace(/["`]/g, "")).toMatch(/\(property_id, ?substr\(value, 1, 600\)\)/);

      const { itemValues } = db.tables;
      const [kept] = await db.client.select().from(itemValues).where(eq(itemValues.id, "v1"));
      expect(kept!.value).toBe(before);

      // 20 KB of incompressible text: Postgres refused this under the old index.
      const long = randomBytes(15_000).toString("base64").slice(0, 20_000);
      await db.insertRows("item_values", [{ id: "v2", item_id: "i2", property_id: "p1", value: long, position: 0 }]);
      const [saved] = await db.client.select().from(itemValues).where(eq(itemValues.id, "v2"));
      expect(saved!.value).toBe(long);
    } finally {
      await db.close();
    }
  });
});
