/**
 * Multi-statement writes are one transaction each: items create and update
 * (one per call, the whole batch), item-type create, bundle create/seed,
 * space create, and bundle and space delete. A database error part-way leaves
 * no partial rows, and the connection is usable afterwards.
 *
 * Failures are injected by making newId return an id that already exists, so
 * the Nth insert collides on its primary key. That is a real database error
 * on both adapters, raised from inside the transaction body.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { BlobStore } from "../../src/blob/index.js";
import { createBundle, deleteBundle } from "../../src/core/bundles.js";
import { createItems, queryItems, updateItems } from "../../src/core/items.js";
import { createItemType, listItemTypesUnchecked } from "../../src/core/itemTypes.js";
import { createSpace, deleteSpace } from "../../src/core/spaces.js";
import { createUser } from "../../src/core/users.js";
import * as util from "../../src/core/util.js";
import type { Db } from "../../src/db/index.js";
import { describeEachAdapter } from "../helpers/adapters.js";

vi.mock("../../src/core/util.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/util.js")>();
  return { ...actual, newId: vi.fn(actual.newId) };
});

/** From the next call on, the nth newId() returns `id` instead of a fresh one. */
function collideOnCall(n: number, id: string): void {
  let calls = 0;
  vi.mocked(util.newId).mockImplementation(() => (++calls === n ? id : randomUUID()));
}

function fakeBlob(): BlobStore & { delete: ReturnType<typeof vi.fn> } {
  return { delete: vi.fn(async () => {}) } as unknown as BlobStore & { delete: ReturnType<typeof vi.fn> };
}

type Counted = "bundles" | "bundleDocs" | "itemTypes" | "properties" | "itemValues" | "spaces" | "grants" | "files";

async function count(db: Db, table: Counted): Promise<number> {
  return (await db.client.select().from(db.tables[table] as Db["tables"]["bundles"])).length;
}

describeEachAdapter("writes: atomic multi-statement paths", (adapter) => {
  let db: Db;
  let userId: string;
  let spaceId: string;
  let bundleId: string;

  beforeEach(async () => {
    db = await adapter.makeDb();
    userId = (await createUser(db, { name: "Owner" })).user.id;
    spaceId = (await createSpace(db, userId, { name: "S" })).id;
    bundleId = (
      await createBundle(db, userId, spaceId, {
        name: "b",
        itemTypes: [{ name: "Todo", properties: [{ name: "title", datatype: "text", required: true }] }],
      })
    ).id;
  });

  afterEach(async () => {
    vi.mocked(util.newId).mockReset();
    vi.mocked(util.newId).mockImplementation(randomUUID);
    await db.close();
  });

  async function titles(): Promise<string[]> {
    const page = await queryItems(db, userId, bundleId, { itemType: "Todo", limit: 100 });
    return page.data.map((i) => String(i.values.title)).sort();
  }

  it("a create batch of 5 failing at item 3 writes none of them", async () => {
    const [existing] = await createItems(db, userId, bundleId, { itemType: "Todo", items: [{ title: "kept" }] });
    const valuesBefore = await count(db, "itemValues");

    // Each item takes two ids (item, value): call 5 is item 3's row.
    collideOnCall(5, existing!.id);
    const batch = ["a", "b", "c", "d", "e"].map((title) => ({ title }));
    await expect(createItems(db, userId, bundleId, { itemType: "Todo", items: batch })).rejects.toThrow();

    expect(await titles()).toEqual(["kept"]);
    expect(await count(db, "itemValues")).toBe(valuesBefore);

    vi.mocked(util.newId).mockImplementation(randomUUID);
    await createItems(db, userId, bundleId, { itemType: "Todo", items: batch });
    expect(await titles()).toEqual(["a", "b", "c", "d", "e", "kept"]);
  });

  it("an update failing between delete and insert keeps every old value", async () => {
    const [one, two, bystander] = await createItems(db, userId, bundleId, {
      itemType: "Todo",
      items: [{ title: "one" }, { title: "two" }, { title: "three" }],
    });
    const [valueRow] = await db.client
      .select()
      .from(db.tables.itemValues)
      .where(eq(db.tables.itemValues.itemId, bystander!.id));

    // Call 1 is the first update's new value (lands), call 2 the second's:
    // its old value is already deleted when the insert collides.
    collideOnCall(2, valueRow!.id);
    await expect(
      updateItems(db, userId, bundleId, [
        { id: one!.id, set: { title: "one!" } },
        { id: two!.id, set: { title: "two!" } },
      ]),
    ).rejects.toThrow();
    expect(await titles()).toEqual(["one", "three", "two"]);

    vi.mocked(util.newId).mockImplementation(randomUUID);
    await updateItems(db, userId, bundleId, [{ id: two!.id, set: { title: "two!" } }]);
    expect(await titles()).toEqual(["one", "three", "two!"]);
  });

  it("a bundle seed failing at the properties insert leaves no bundle", async () => {
    const [existingProp] = await db.client.select().from(db.tables.properties).limit(1);
    const before = {
      bundles: await count(db, "bundles"),
      docs: await count(db, "bundleDocs"),
      types: await count(db, "itemTypes"),
      props: await count(db, "properties"),
    };
    const design = {
      name: "seeded",
      docs: [{ name: "Readme", content: "hello" }],
      itemTypes: [
        {
          name: "Note",
          properties: [
            { name: "body", datatype: "text" as const },
            { name: "done", datatype: "boolean" as const },
          ],
        },
      ],
    };

    // Ids in order: bundle, type, the two properties, then the doc. The
    // properties are the last insert, after bundle, doc and type have run.
    collideOnCall(3, existingProp!.id);
    await expect(createBundle(db, userId, spaceId, design)).rejects.toThrow();
    expect({
      bundles: await count(db, "bundles"),
      docs: await count(db, "bundleDocs"),
      types: await count(db, "itemTypes"),
      props: await count(db, "properties"),
    }).toEqual(before);

    vi.mocked(util.newId).mockImplementation(randomUUID);
    const created = await createBundle(db, userId, spaceId, design);
    expect((await listItemTypesUnchecked(db, created.id)).map((t) => t.properties.length)).toEqual([2]);
  });

  it("an item-type create failing at the properties insert leaves no type", async () => {
    const [existingProp] = await db.client.select().from(db.tables.properties).limit(1);
    const typesBefore = await count(db, "itemTypes");

    // Call 1 is the type's id, call 2 its first property.
    collideOnCall(2, existingProp!.id);
    await expect(
      createItemType(db, userId, bundleId, { name: "Tag", properties: [{ name: "label", datatype: "text" }] }),
    ).rejects.toThrow();
    expect(await count(db, "itemTypes")).toBe(typesBefore);

    vi.mocked(util.newId).mockImplementation(randomUUID);
    await createItemType(db, userId, bundleId, { name: "Tag", properties: [{ name: "label", datatype: "text" }] });
    expect(await count(db, "itemTypes")).toBe(typesBefore + 1);
  });

  it("a space create failing at the owner grants leaves no space", async () => {
    const [existingGrant] = await db.client.select().from(db.tables.grants).limit(1);
    const spacesBefore = await count(db, "spaces");
    const grantsBefore = await count(db, "grants");

    // Call 1 is the space's id, call 2 the first grant.
    collideOnCall(2, existingGrant!.id);
    await expect(createSpace(db, userId, { name: "Doomed" })).rejects.toThrow();
    expect(await count(db, "spaces")).toBe(spacesBefore);
    expect(await count(db, "grants")).toBe(grantsBefore);

    vi.mocked(util.newId).mockImplementation(randomUUID);
    await createSpace(db, userId, { name: "Doomed" });
    expect(await count(db, "spaces")).toBe(spacesBefore + 1);
  });

  async function addFile(bundle: string): Promise<string> {
    const id = randomUUID();
    await db.client.insert(db.tables.files).values({
      id,
      bundleId: bundle,
      spaceId,
      ownerId: userId,
      status: "finalized",
      name: "f.txt",
      mimeType: "text/plain",
      size: 3,
      storageKey: `k/${id}`,
      uploadConsumed: 1,
      createdAt: new Date().toISOString(),
      finalizedAt: new Date().toISOString(),
    });
    return `k/${id}`;
  }

  /** A bundle-level grant: the row a delete must clean up by hand (no FK). */
  async function addBundleGrant(bundle: string): Promise<void> {
    await db.client.insert(db.tables.grants).values({
      id: randomUUID(),
      userId,
      resourceType: "bundle",
      resourceId: bundle,
      capability: "read_items",
      effect: "allow",
      createdAt: new Date().toISOString(),
    });
  }

  /** Lets the body run, then fails before commit: everything it did must roll back. */
  function failBeforeCommit(): void {
    const real = db.transaction.bind(db);
    db.transaction = ((fn) =>
      real(function* (tx) {
        yield* fn(tx);
        throw new Error("commit refused");
      })) as Db["transaction"];
  }

  it("a bundle delete that fails rolls back and leaves its blobs alone", async () => {
    await addFile(bundleId);
    await addBundleGrant(bundleId);
    const grantsBefore = await count(db, "grants");
    const blob = fakeBlob();
    const real = db.transaction;
    failBeforeCommit();
    await expect(deleteBundle(db, userId, bundleId, blob)).rejects.toThrow("commit refused");
    db.transaction = real;
    expect(await count(db, "bundles")).toBe(1);
    expect(await count(db, "files")).toBe(1);
    expect(await count(db, "grants")).toBe(grantsBefore);
    expect(blob.delete).not.toHaveBeenCalled();
  });

  it("a space delete that fails rolls back and leaves its blobs alone", async () => {
    await addFile(bundleId);
    await addBundleGrant(bundleId);
    const blob = fakeBlob();
    const real = db.transaction;
    const grantsBefore = await count(db, "grants");
    failBeforeCommit();
    await expect(deleteSpace(db, userId, spaceId, blob)).rejects.toThrow("commit refused");
    db.transaction = real;
    expect(await count(db, "spaces")).toBe(2); // the personal space and S
    expect(await count(db, "bundles")).toBe(1);
    expect(await count(db, "grants")).toBe(grantsBefore);
    expect(blob.delete).not.toHaveBeenCalled();
  });

  it("deletes blobs after commit, logging a failed one instead of raising", async () => {
    const keys = [await addFile(bundleId), await addFile(bundleId)];
    const blob = fakeBlob();
    blob.delete.mockRejectedValueOnce(new Error("disk gone"));
    const logger = { warn: vi.fn() };

    await deleteBundle(db, userId, bundleId, blob, logger);
    expect(await count(db, "bundles")).toBe(0);
    expect(await count(db, "files")).toBe(0);
    expect(blob.delete.mock.calls.map((c) => c[0]).sort()).toEqual([...keys].sort());
    expect(logger.warn).toHaveBeenCalledTimes(1);

  });

  it("a space delete removes its bundles, grants and blobs, logging a failed blob", async () => {
    const keys = [await addFile(bundleId), await addFile(bundleId)];
    await addBundleGrant(bundleId);
    const grantsBefore = await count(db, "grants");
    const ownGrants = (await db.client.select().from(db.tables.grants)).filter(
      (g) => g.resourceId === spaceId || g.resourceId === bundleId,
    ).length;
    const blob = fakeBlob();
    blob.delete.mockRejectedValueOnce(new Error("disk gone"));
    const logger = { warn: vi.fn() };

    await deleteSpace(db, userId, spaceId, blob, logger);
    expect(await count(db, "spaces")).toBe(1); // the personal space
    expect(await count(db, "bundles")).toBe(0);
    expect(await count(db, "files")).toBe(0);
    expect(await count(db, "grants")).toBe(grantsBefore - ownGrants);
    expect(blob.delete.mock.calls.map((c) => c[0]).sort()).toEqual([...keys].sort());
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // The next write on the same connection works.
    await createSpace(db, userId, { name: "Other" });
    expect(await count(db, "spaces")).toBe(2);
  });
});
