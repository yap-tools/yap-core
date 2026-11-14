/**
 * The startup upgrade that rewrites name-valued link targets to ids
 * (upgradeLinkTargets in src/core/linkTargets.ts). Seeded with raw rows in
 * the shape an instance that predates the rule holds, on both adapters.
 * Pinned: unambiguous names become ids with nothing else in the row changed;
 * a name that matches nothing (also after a rename) is left byte-for-byte and
 * logged; item values are untouched; a second run changes nothing; and a
 * backup taken before the change restores into an upgraded instance with ids.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { exportBackup } from "../../src/backup/export.js";
import { importArchive } from "../../src/backup/import.js";
import { createBlobStore } from "../../src/blob/index.js";
import type { YapConfig } from "../../src/config.js";
import { createItems } from "../../src/core/items.js";
import { upgradeLinkTargets } from "../../src/core/linkTargets.js";
import type { Db } from "../../src/db/index.js";
import { describeEachAdapter, rawAll } from "../helpers/adapters.js";

const now = "2026-01-01T00:00:00.000Z";

/** Collects what the upgrade logs. */
function captureLogger() {
  const lines: { level: "info" | "warn"; text: string }[] = [];
  return {
    lines,
    logger: {
      info: (...a: unknown[]) => lines.push({ level: "info", text: a.join(" ") }),
      warn: (...a: unknown[]) => lines.push({ level: "warn", text: a.join(" ") }),
    },
  };
}

/** Each link property's stored config, verbatim. */
const PRE_CHANGE_CONFIGS = {
  // Unambiguous names, alongside other keys that must survive untouched.
  pProject: '{"itemType":"project"}',
  pBlocks: '{"itemType":"task","minItems":1,"maxItems":3}',
  // Already an id: never touched.
  pById: '{"itemType":"t-project"}',
  // A name that matches nothing.
  pGhost: '{"itemType":"ghost"}',
  // A name that matched before its target was renamed ("person" → "member").
  pRenamed: '{"itemType":"person"}',
  // A name that only exists in another bundle: links never cross bundles.
  pForeign: '{"itemType":"elsewhere"}',
  // An item property with no pin, and one whose config is not JSON.
  pNoPin: "",
  pBroken: "{not json",
};

/**
 * Two bundles, rows inserted directly (as an instance before the change holds
 * them): b1 has project / task / member (renamed from person), b2 has
 * elsewhere. Plus two items and a link value between them.
 */
async function seedPreChange(db: Db): Promise<void> {
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
    { id: "b1", space_id: "s1", name: "Work", description: "", created_at: now, updated_at: now },
    { id: "b2", space_id: "s1", name: "Other", description: "", created_at: now, updated_at: now },
  ]);
  await db.insertRows("item_types", [
    { id: "t-project", bundle_id: "b1", name: "project", created_at: now },
    { id: "t-task", bundle_id: "b1", name: "task", created_at: now },
    { id: "t-member", bundle_id: "b1", name: "member", created_at: now },
    { id: "t-elsewhere", bundle_id: "b2", name: "elsewhere", created_at: now },
  ]);
  const prop = (id: keyof typeof PRE_CHANGE_CONFIGS, itemTypeId: string, sortOrder: number, multi = 0) => ({
    id,
    item_type_id: itemTypeId,
    name: id.slice(1).toLowerCase(),
    datatype: "item",
    required: 0,
    multi,
    config: PRE_CHANGE_CONFIGS[id],
    sort_order: sortOrder,
  });
  await db.insertRows("properties", [
    prop("pProject", "t-task", 0),
    prop("pBlocks", "t-task", 1, 1),
    prop("pById", "t-task", 2),
    prop("pGhost", "t-task", 3),
    prop("pRenamed", "t-task", 4),
    prop("pForeign", "t-task", 5),
    prop("pNoPin", "t-task", 6),
    prop("pBroken", "t-task", 7),
    // A text property carrying an itemType key is not a link: ignored.
    {
      id: "pText",
      item_type_id: "t-task",
      name: "label",
      datatype: "text",
      required: 0,
      multi: 0,
      config: '{"itemType":"project"}',
      sort_order: 8,
    },
  ]);
  await db.insertRows("items", [
    { id: "i-project", item_type_id: "t-project", bundle_id: "b1", created_at: now, updated_at: now },
    { id: "i-task", item_type_id: "t-task", bundle_id: "b1", created_at: now, updated_at: now },
  ]);
  await db.insertRows("item_values", [
    { id: "v1", item_id: "i-task", property_id: "pProject", value: "item://i-project", position: 0 },
    { id: "v2", item_id: "i-task", property_id: "pGhost", value: "item://i-project", position: 0 },
  ]);
}

const configsById = async (db: Db) =>
  Object.fromEntries(
    (await rawAll<{ id: string; config: string }>(db, "SELECT id, config FROM properties ORDER BY id")).map((r) => [
      r.id,
      r.config,
    ]),
  );

const valueRows = (db: Db) => rawAll(db, "SELECT * FROM item_values ORDER BY id");

/** What every row must hold after the upgrade. */
const UPGRADED_CONFIGS = {
  ...PRE_CHANGE_CONFIGS,
  pProject: '{"itemType":"t-project"}',
  pBlocks: '{"itemType":"t-task","minItems":1,"maxItems":3}',
  pText: '{"itemType":"project"}',
};

describeEachAdapter("link target upgrade", (adapter) => {
  it("rewrites unambiguous names to ids, leaves the rest byte-for-byte and logs them; a second run changes nothing", async () => {
    const db = await adapter.makeDb();
    try {
      await seedPreChange(db);
      const valuesBefore = await valueRows(db);

      const first = captureLogger();
      let backups = 0;
      const plan = await upgradeLinkTargets(db, { logger: first.logger, beforeRewrite: async () => void backups++ });
      expect(backups).toBe(1);
      expect(plan.rewrites.map((r) => r.propertyId).sort()).toEqual(["pBlocks", "pProject"]);
      expect(plan.leftAlone.map((r) => r.propertyId).sort()).toEqual(["pForeign", "pGhost", "pRenamed"]);
      expect(await configsById(db)).toEqual(UPGRADED_CONFIGS);
      expect(await valueRows(db)).toEqual(valuesBefore);

      // Each row left alone is logged with bundle, item type, property and value.
      const warnings = first.lines.filter((l) => l.level === "warn").map((l) => l.text);
      expect(warnings).toHaveLength(3);
      const ghost = warnings.find((w) => w.includes('"ghost"'))!;
      expect(ghost).toContain('bundle "Work" (b1)');
      expect(ghost).toContain('item type "task"');
      expect(ghost).toContain('property "ghost" (pGhost)');
      expect(warnings.some((w) => w.includes('config.itemType "person"'))).toBe(true);
      expect(warnings.some((w) => w.includes('config.itemType "elsewhere"'))).toBe(true);

      // Second run: nothing to rewrite, no backup, nothing changed; the rows
      // left alone are logged again (it runs on every start).
      const second = captureLogger();
      const again = await upgradeLinkTargets(db, { logger: second.logger, beforeRewrite: async () => void backups++ });
      expect(backups).toBe(1);
      expect(again.rewrites).toEqual([]);
      expect(await configsById(db)).toEqual(UPGRADED_CONFIGS);
      expect(await valueRows(db)).toEqual(valuesBefore);
      expect(second.lines.filter((l) => l.level === "warn")).toHaveLength(3);
    } finally {
      await db.close();
    }
  });

  it("writes nothing when the backup before the rewrite fails", async () => {
    const db = await adapter.makeDb();
    try {
      await seedPreChange(db);
      const { logger } = captureLogger();
      await expect(
        upgradeLinkTargets(db, {
          logger,
          beforeRewrite: async () => {
            throw new Error("sink unavailable");
          },
        }),
      ).rejects.toThrow("sink unavailable");
      expect(await configsById(db)).toEqual({ ...PRE_CHANGE_CONFIGS, pText: '{"itemType":"project"}' });
    } finally {
      await db.close();
    }
  });

  it("keeps a left-alone row's behaviour: item writes still resolve it by name", async () => {
    const db = await adapter.makeDb();
    try {
      await seedPreChange(db);
      await upgradeLinkTargets(db, { logger: captureLogger().logger });
      // An operator now creates a type named "ghost"; the left-alone row binds
      // to it on writes, as it did before the upgrade.
      await db.insertRows("item_types", [{ id: "t-ghost", bundle_id: "b1", name: "ghost", created_at: now }]);
      await db.insertRows("items", [
        { id: "i-ghost", item_type_id: "t-ghost", bundle_id: "b1", created_at: now, updated_at: now },
      ]);
      await db.insertRows("grants", [
        {
          id: "g1",
          user_id: "u1",
          resource_type: "space",
          resource_id: "s1",
          capability: "edit_items",
          effect: "allow",
          created_at: now,
        },
      ]);
      const [written] = await createItems(db, "u1", "b1", { itemType: "task", items: [{ ghost: "i-ghost" }] });
      expect(written!.values.ghost).toBe("item://i-ghost");
    } finally {
      await db.close();
    }
  });

  describe("backups", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });
    const blobConfig = (root: string) =>
      ({ blob: { driver: "fs", root }, masterKey: Buffer.alloc(32), baseUrl: "http://localhost:0" }) as YapConfig;

    it("restores a backup taken before the change into an upgraded instance with ids", async () => {
      const work = mkdtempSync(join(tmpdir(), "yap-links-"));
      dirs.push(work);
      const blob = await createBlobStore(blobConfig(join(work, "blobs")));
      const archive = join(work, "pre-change.tar.gz");

      const source = await adapter.makeDb();
      try {
        await seedPreChange(source);
        await exportBackup({ db: source, blob, trigger: "manual", yapVersion: "0.9.0", outPath: archive });
      } finally {
        await source.close();
      }

      // Restore = import at the archive's schema position, then the normal
      // startup: migrate forward, then the link target upgrade.
      const target = await adapter.makeFreshDb();
      try {
        await importArchive({ db: target, blob, archivePath: archive });
        expect((await configsById(target)).pProject).toBe(PRE_CHANGE_CONFIGS.pProject); // verbatim
        await target.migrate();
        await upgradeLinkTargets(target, { logger: captureLogger().logger });
        expect(await configsById(target)).toEqual(UPGRADED_CONFIGS);
      } finally {
        await target.close();
      }
    });
  });
});
