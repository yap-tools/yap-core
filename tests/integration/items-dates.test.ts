/**
 * Strict date input, end to end on both dialects: the two accepted forms are
 * stored as one UTC instant; every other form is refused on create, on update
 * and as a filter value, over the core API, REST and MCP alike, with an error
 * that names the property, shows the value and says what to send. A backup
 * taken before the change restores and reads back unchanged.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { exportBackup } from "../../src/backup/export.js";
import { importArchive } from "../../src/backup/import.js";
import { createBlobStore } from "../../src/blob/index.js";
import { createBundle } from "../../src/core/bundles.js";
import { createItems, getItems, queryItems, updateItems } from "../../src/core/items.js";
import { createSpace } from "../../src/core/spaces.js";
import { createUser } from "../../src/core/users.js";
import type { YapConfig } from "../../src/config.js";
import type { Db } from "../../src/db/index.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp, type McpTestClient } from "../helpers/mcp.js";

const ACCEPTED: [string, string][] = [
  ["2026-11-16", "2026-11-16T00:00:00.000Z"],
  ["2026-11-16T09:00:00+01:00", "2026-11-16T08:00:00.000Z"],
  ["2026-11-16T08:00:00Z", "2026-11-16T08:00:00.000Z"],
];
const REFUSED = ["2026-11-16T09:00:00", "Nov 16, 2026", "2026/11/16", "2026", "2026-02-30"];

/** The refusal: property named, value shown, what to send. */
const refusal = (subject: RegExp, value: string) =>
  new RegExp(`${subject.source} expects a date, got ${JSON.stringify(value).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}: send YYYY-MM-DD for a day, or a timestamp with Z or an offset`);

describeEachAdapter("strict date input (core)", (adapter) => {
  let db: Db;
  let userId: string;
  let bundleId: string;

  beforeAll(async () => {
    db = await adapter.makeDb();
    userId = (await createUser(db, { name: "Owner" })).user.id;
    const space = await createSpace(db, userId, { name: "Work" });
    bundleId = (
      await createBundle(db, userId, space.id, {
        name: "b",
        itemTypes: [
          {
            name: "task",
            properties: [
              { name: "title", datatype: "text", required: true },
              { name: "due", datatype: "date" },
              { name: "seen", datatype: "date", multi: true },
            ],
          },
        ],
      })
    ).id;
  });
  afterAll(async () => {
    await db.close();
  });

  it.each(ACCEPTED)("create, update and filter accept %s, stored as %s", async (input, stored) => {
    const [made] = await createItems(db, userId, bundleId, { itemType: "task", items: [{ title: input, due: input, seen: [input] }] });
    expect(made!.values.due).toBe(stored);
    expect(made!.values.seen).toEqual([stored]);
    const [updated] = await updateItems(db, userId, bundleId, [{ id: made!.id, set: { due: input } }]);
    expect(updated!.values.due).toBe(stored);
    for (const op of ["eq", "gte", "lte", "in"] as const) {
      const page = await queryItems(db, userId, bundleId, {
        itemType: "task",
        filters: [
          { property: "title", op: "eq", value: input },
          { property: "due", op, value: op === "in" ? [input] : input },
        ],
      });
      expect(page.data.map((i) => i.id), op).toEqual([made!.id]);
    }
  });

  it.each(REFUSED)("create, update and filter refuse %s", async (input) => {
    await expect(createItems(db, userId, bundleId, { itemType: "task", items: [{ title: "x", due: input }] })).rejects.toThrow(
      refusal(/property "due"/, input),
    );
    await expect(createItems(db, userId, bundleId, { itemType: "task", items: [{ title: "x", seen: ["2026-11-16", input] }] })).rejects.toThrow(
      refusal(/property "seen"/, input),
    );
    const [made] = await createItems(db, userId, bundleId, { itemType: "task", items: [{ title: "kept", due: "2026-01-01" }] });
    await expect(updateItems(db, userId, bundleId, [{ id: made!.id, set: { due: input } }])).rejects.toThrow(refusal(/property "due"/, input));
    expect((await getItems(db, userId, bundleId, [made!.id]))[0]!.values.due).toBe("2026-01-01T00:00:00.000Z");
    for (const op of ["eq", "neq", "gt", "lt"] as const) {
      await expect(
        queryItems(db, userId, bundleId, { itemType: "task", filters: [{ property: "due", op, value: input }] }),
        op,
      ).rejects.toThrow(refusal(/filter on "due"/, input));
    }
    await expect(
      queryItems(db, userId, bundleId, { itemType: "task", filters: [{ property: "due", op: "in", value: ["2026-11-16", input] }] }),
    ).rejects.toThrow(refusal(/"due"/, input));
  });

  it("contains stays a substring match on the stored UTC text", async () => {
    const [made] = await createItems(db, userId, bundleId, { itemType: "task", items: [{ title: "contains", due: "2031-07-04T10:00:00+02:00" }] });
    const page = await queryItems(db, userId, bundleId, { itemType: "task", filters: [{ property: "due", op: "contains", value: "2031-07-04T08" }] });
    expect(page.data.map((i) => i.id)).toEqual([made!.id]);
  });
});

describeEachAdapter("strict date input (REST and MCP)", (adapter) => {
  let app: TestApp;
  let rest: ApiClient;
  let mcp: McpTestClient;
  let spaceId: string;
  let bundleId: string;
  let itemId: string;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const u = await sysadmin.post("/v1/users", { name: "Alice" });
    rest = apiClient(app.baseUrl, u.body.initialKey.key);
    mcp = await connectMcp(app.baseUrl, u.body.initialKey.key);
    spaceId = (await rest.post("/v1/spaces", { name: "Work" })).body.id;
    bundleId = (await rest.post(`/v1/spaces/${spaceId}/bundles`, { name: "b" })).body.id;
    await rest.post(`/v1/bundles/${bundleId}/item-types`, {
      name: "task",
      properties: [{ name: "due", datatype: "date" }],
    });
    itemId = (await rest.post(`/v1/bundles/${bundleId}/items`, { itemType: "task", items: [{ due: "2026-11-16" }] })).body.data[0].id;
  });
  afterAll(async () => {
    await mcp.close();
    await app.stop();
  });

  const one = async (tool: string, params: unknown) =>
    (await mcp.call("call", { space_id: spaceId, calls: [{ bundle_id: bundleId, tool, params }] })).results[0];

  it("REST stores the accepted forms and refuses the rest with a 400", async () => {
    const ok = await rest.patch(`/v1/items/${itemId}`, { set: { due: "2026-11-16T09:00:00+01:00" } });
    expect(ok.body.values.due).toBe("2026-11-16T08:00:00.000Z");
    for (const input of REFUSED) {
      const created = await rest.post(`/v1/bundles/${bundleId}/items`, { itemType: "task", items: [{ due: input }] });
      expect(created.status, input).toBe(400);
      expect(created.body.error.message).toMatch(refusal(/property "due"/, input));
      const patched = await rest.patch(`/v1/items/${itemId}`, { set: { due: input } });
      expect(patched.status, input).toBe(400);
      expect(patched.body.error.message).toMatch(refusal(/property "due"/, input));
      const filters = encodeURIComponent(JSON.stringify([{ property: "due", op: "eq", value: input }]));
      const queried = await rest.get(`/v1/bundles/${bundleId}/items?itemType=task&filters=${filters}`);
      expect(queried.status, input).toBe(400);
      expect(queried.body.error.message).toMatch(refusal(/filter on "due"/, input));
    }
  });

  it("MCP stores the accepted forms and refuses the rest", async () => {
    const ok = await one("update_items", { updates: [{ id: itemId, set: { due: "2026-11-16T08:00:00Z" } }] });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect(ok.result[0].values.due).toBe("2026-11-16T08:00:00.000Z");
    for (const input of REFUSED) {
      for (const [tool, params, subject] of [
        ["create_items", { item_type: "task", items: [{ due: input }] }, /property "due"/],
        ["update_items", { updates: [{ id: itemId, set: { due: input } }] }, /property "due"/],
        ["query_items", { item_type: "task", filters: [{ property: "due", op: "lt", value: input }] }, /filter on "due"/],
      ] as const) {
        const res = await one(tool, params);
        expect(res.ok, `${tool} ${input}`).toBe(false);
        expect(res.error.code).toBe("invalid_request");
        expect(res.error.message).toMatch(refusal(subject, input));
      }
    }
  });
});

describeEachAdapter("strict date input (backup)", (adapter) => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("a backup holding stored dates restores and reads back unchanged", async () => {
    const work = mkdtempSync(join(tmpdir(), "yap-dates-"));
    dirs.push(work);
    const blob = await createBlobStore({ blob: { driver: "fs", root: join(work, "blobs") }, masterKey: Buffer.alloc(32), baseUrl: "http://localhost:0" } as YapConfig);
    const source = await adapter.makeDb();
    const userId = (await createUser(source, { name: "Owner" })).user.id;
    const space = await createSpace(source, userId, { name: "Work" });
    const bundleId = (
      await createBundle(source, userId, space.id, {
        name: "b",
        itemTypes: [{ name: "task", properties: [{ name: "due", datatype: "date" }, { name: "seen", datatype: "date", multi: true }] }],
      })
    ).id;
    const [item] = await createItems(source, userId, bundleId, {
      itemType: "task",
      items: [{ due: "2026-11-16T08:00:00Z", seen: ["2026-11-15", "2026-11-16T09:00:00+01:00"] }],
    });
    const out = join(work, "backup.tar.gz");
    await exportBackup({ db: source, blob, trigger: "manual", yapVersion: "0.0.0", outPath: out });
    const before = (await getItems(source, userId, bundleId, [item!.id]))[0]!.values;
    await source.close();

    const target = await adapter.makeFreshDb();
    await importArchive({ db: target, blob, archivePath: out });
    const after = (await getItems(target, userId, bundleId, [item!.id]))[0]!.values;
    expect(after).toEqual(before);
    expect(after).toEqual({ due: "2026-11-16T08:00:00.000Z", seen: ["2026-11-15T00:00:00.000Z", "2026-11-16T08:00:00.000Z"] });
    // Restored values are valid input again: a filter and a rewrite take them.
    const page = await queryItems(target, userId, bundleId, { itemType: "task", filters: [{ property: "due", op: "eq", value: after.due }] });
    expect(page.data.map((i) => i.id)).toEqual([item!.id]);
    const [rewritten] = await updateItems(target, userId, bundleId, [{ id: item!.id, set: { seen: after.seen } }]);
    expect(rewritten!.values.seen).toEqual(after.seen);
    await target.close();
  });
});
