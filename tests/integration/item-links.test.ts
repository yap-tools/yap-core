/**
 * Link properties store their target item type by id (see
 * src/core/linkTargets.ts). Pinned here on both adapters, through every save
 * path: a target given by name is stored as the id, a rename of the target
 * leaves link writes working, a new type that takes the old name does not
 * become the target, and a target that matches nothing is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBundle } from "../../src/core/bundles.js";
import { createItems } from "../../src/core/items.js";
import {
  addProperty,
  createItemType,
  listItemTypesUnchecked,
  updateItemType,
  updateProperty,
} from "../../src/core/itemTypes.js";
import { parseConfig } from "../../src/core/propertyConfig.js";
import { createSpace } from "../../src/core/spaces.js";
import { createUser } from "../../src/core/users.js";
import type { Db } from "../../src/db/index.js";
import { describeEachAdapter } from "../helpers/adapters.js";

describeEachAdapter("item links target item types by id", (adapter) => {
  let db: Db;
  let userId: string;
  let spaceId: string;
  let n = 0;

  beforeAll(async () => {
    db = await adapter.makeDb();
    const { user } = await createUser(db, { name: "Owner" });
    userId = user.id;
    spaceId = (await createSpace(db, userId, { name: "S" })).id;
  });
  afterAll(async () => {
    await db.close();
  });

  async function types(bundleId: string) {
    const all = await listItemTypesUnchecked(db, bundleId);
    const byName = (name: string) => all.find((t) => t.name === name)!;
    const target = (type: string, prop: string) =>
      parseConfig(byName(type).properties.find((p) => p.name === prop)!.config).itemType;
    return { all, byName, target };
  }

  /** A bundle with a "task" type and a "project" type, no links yet. */
  async function twoTypes() {
    const bundle = await createBundle(db, userId, spaceId, {
      name: `b${++n}`,
      itemTypes: [
        { name: "project", properties: [{ name: "title", datatype: "text" }] },
        { name: "task", properties: [{ name: "title", datatype: "text" }] },
      ],
    });
    const t = await types(bundle.id);
    return { bundleId: bundle.id, projectId: t.byName("project").id, taskId: t.byName("task").id };
  }

  /**
   * The rename check every save path must pass: rename the target, link writes
   * still work; a new type taking the old name is not the target.
   */
  async function expectSurvivesRename(bundleId: string, holderId: string, prop: string, targetId: string) {
    const before = (await types(bundleId)).all.find((t) => t.id === targetId)!.name;
    const referent = (await createItems(db, userId, bundleId, { itemType: targetId, items: [{}] }))[0]!.id;

    await updateItemType(db, userId, targetId, { name: `${before}-renamed` });
    const written = await createItems(db, userId, bundleId, { itemType: holderId, items: [{ [prop]: referent }] });
    expect(written[0]!.values[prop]).toBe(`item://${referent}`);

    const impostor = await createItemType(db, userId, bundleId, { name: before, properties: [] });
    const decoy = (await createItems(db, userId, bundleId, { itemType: impostor.id, items: [{}] }))[0]!.id;
    await expect(
      createItems(db, userId, bundleId, { itemType: holderId, items: [{ [prop]: decoy }] }),
    ).rejects.toThrow(`must reference an item of type "${before}-renamed"`);
    const holder = (await types(bundleId)).all.find((t) => t.id === holderId)!;
    expect(parseConfig(holder.properties.find((p) => p.name === prop)!.config).itemType).toBe(targetId);
  }

  describe("add_property", () => {
    it("stores a target given by name as the id, and survives a rename", async () => {
      const { bundleId, taskId, projectId } = await twoTypes();
      const prop = await addProperty(db, userId, taskId, {
        name: "project",
        datatype: "item",
        config: { itemType: "project" },
      });
      expect(parseConfig(prop.config).itemType).toBe(projectId);
      await expectSurvivesRename(bundleId, taskId, "project", projectId);
    });

    it("keeps a target given by id", async () => {
      const { taskId, projectId } = await twoTypes();
      const prop = await addProperty(db, userId, taskId, {
        name: "project",
        datatype: "item",
        config: { itemType: projectId },
      });
      expect(parseConfig(prop.config).itemType).toBe(projectId);
    });

    it("refuses a target that matches no item type, naming the property and value", async () => {
      const { taskId } = await twoTypes();
      await expect(
        addProperty(db, userId, taskId, { name: "owner", datatype: "item", config: { itemType: "person" } }),
      ).rejects.toThrow('property "owner": config.itemType "person" matches no item type in this bundle');
    });

    it("refuses an item type of another bundle, by id or by name", async () => {
      const here = await twoTypes();
      const there = await createBundle(db, userId, spaceId, {
        name: `b${++n}`,
        itemTypes: [{ name: "elsewhere", properties: [] }],
      });
      const foreignId = (await types(there.id)).byName("elsewhere").id;
      for (const itemType of [foreignId, "elsewhere"]) {
        await expect(
          addProperty(db, userId, here.taskId, { name: "x", datatype: "item", config: { itemType } }),
        ).rejects.toThrow(/matches no item type in this bundle/);
      }
    });
  });

  describe("create_item_type", () => {
    it("stores ids for links to an existing type and to itself", async () => {
      const { bundleId, projectId } = await twoTypes();
      const created = await createItemType(db, userId, bundleId, {
        name: "note",
        properties: [
          { name: "project", datatype: "item", config: { itemType: "project" } },
          { name: "parent", datatype: "item", config: { itemType: "note" } },
        ],
      });
      const t = await types(bundleId);
      expect(t.target("note", "project")).toBe(projectId);
      expect(t.target("note", "parent")).toBe(created.id);
      await expectSurvivesRename(bundleId, created.id, "parent", created.id);
    });

    it("refuses an unknown target and writes nothing", async () => {
      const { bundleId } = await twoTypes();
      await expect(
        createItemType(db, userId, bundleId, {
          name: "note",
          properties: [{ name: "about", datatype: "item", config: { itemType: "ghost" } }],
        }),
      ).rejects.toThrow('property "about": config.itemType "ghost" matches no item type in this bundle');
      expect((await types(bundleId)).all.map((t) => t.name).sort()).toEqual(["project", "task"]);
    });
  });

  describe("update_property", () => {
    it("resolves a config patch's target to the id, and refuses an unknown one", async () => {
      const { bundleId, taskId, projectId } = await twoTypes();
      const prop = await addProperty(db, userId, taskId, { name: "project", datatype: "item" });
      const updated = await updateProperty(db, userId, taskId, prop.id, { config: { itemType: "project" } });
      expect(parseConfig(updated.config).itemType).toBe(projectId);
      await expect(
        updateProperty(db, userId, taskId, prop.id, { config: { itemType: "ghost" } }),
      ).rejects.toThrow('property "project": config.itemType "ghost" matches no item type in this bundle');
      expect((await types(bundleId)).target("task", "project")).toBe(projectId);
      await expectSurvivesRename(bundleId, taskId, "project", projectId);
    });

    it("leaves a stored target alone when the patch has no config", async () => {
      const { taskId, projectId } = await twoTypes();
      const prop = await addProperty(db, userId, taskId, {
        name: "project",
        datatype: "item",
        config: { itemType: "project" },
      });
      const renamed = await updateProperty(db, userId, taskId, prop.id, { name: "proj" });
      expect(parseConfig(renamed.config).itemType).toBe(projectId);
    });
  });

  describe("bundle creation with seeded types", () => {
    it("stores ids for types that link to each other and to themselves, in one call", async () => {
      const bundle = await createBundle(db, userId, spaceId, {
        name: `b${++n}`,
        itemTypes: [
          // "task" links forward to "project", which is seeded after it.
          {
            name: "task",
            properties: [
              { name: "project", datatype: "item", config: { itemType: "project" } },
              { name: "blocks", datatype: "item", multi: true, config: { itemType: "task", maxItems: 3 } },
            ],
          },
          { name: "project", properties: [{ name: "lead", datatype: "item", config: { itemType: "task" } }] },
        ],
      });
      const t = await types(bundle.id);
      const taskId = t.byName("task").id;
      const projectId = t.byName("project").id;
      expect(t.target("task", "project")).toBe(projectId);
      expect(t.target("task", "blocks")).toBe(taskId);
      expect(t.target("project", "lead")).toBe(taskId);
      // Other config keys ride along untouched.
      const blocks = t.byName("task").properties.find((p) => p.name === "blocks")!;
      expect(parseConfig(blocks.config)).toEqual({ itemType: taskId, maxItems: 3 });

      await expectSurvivesRename(bundle.id, taskId, "project", projectId);
      await expectSurvivesRename(bundle.id, projectId, "lead", taskId);
    });

    it("refuses a target outside the call, and creates no bundle", async () => {
      const name = `b${++n}`;
      await expect(
        createBundle(db, userId, spaceId, {
          name,
          itemTypes: [
            { name: "task", properties: [{ name: "owner", datatype: "item", config: { itemType: "person" } }] },
          ],
        }),
      ).rejects.toMatchObject({
        details: {
          errors: [
            'itemTypes[0].properties[0]: property "owner": config.itemType "person" matches no item type in this bundle',
          ],
        },
      });
      const { bundles } = db.tables;
      const rows = await db.client.select().from(bundles);
      expect(rows.some((b) => b.name === name)).toBe(false);
    });
  });
});
