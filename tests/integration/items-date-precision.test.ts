/**
 * Day-precision date properties, end to end on both dialects: a date property
 * with config.precision "day" stores and returns YYYY-MM-DD as sent, refuses
 * timestamps and impossible dates, filters and sorts as a day, and switching
 * an existing property converts only midnight-UTC values (refusing the switch,
 * named, otherwise) and switches back. Properties without the setting keep
 * holding instants.
 */
import { createRequire } from "node:module";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBundle } from "../../src/core/bundles.js";
import { addProperty, listItemTypesUnchecked, updateProperty } from "../../src/core/itemTypes.js";
import { createItems, getItems, queryItems, updateItems, type ItemFilter } from "../../src/core/items.js";
import { createSpace } from "../../src/core/spaces.js";
import { createUser } from "../../src/core/users.js";
import type { Db } from "../../src/db/index.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp, KEY_LOGIN_ON } from "../helpers/app.js";
import { connectMcp, type McpTestClient } from "../helpers/mcp.js";

const DAY_REFUSED = [
  "2026-11-16T00:00:00+01:00",
  "2026-11-16T00:00:00.000Z",
  "2026-11-16T09:00Z",
  "2026-02-30",
  "2026-02-29",
  "2026-13-01",
  "2026-11-16 ",
  "Nov 16, 2026",
  "2026-11",
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** The refusal on a day property: subject named, value shown, what to send. */
const dayRefusal = (subject: RegExp, value: string) =>
  new RegExp(`${subject.source} expects a day, got ${escape(JSON.stringify(value))}: send YYYY-MM-DD \\(e\\.g\\. 2026-11-16\\), with no time or zone`);

describeEachAdapter("day-precision dates (core)", (adapter) => {
  let db: Db;
  let userId: string;
  let bundleId: string;

  beforeAll(async () => {
    db = await adapter.makeDb();
    userId = (await createUser(db, KEY_LOGIN_ON, { name: "Owner" })).user.id;
    const space = await createSpace(db, userId, { name: "Work" });
    bundleId = (
      await createBundle(db, userId, space.id, {
        name: "b",
        itemTypes: [
          {
            name: "task",
            properties: [
              { name: "title", datatype: "text", required: true },
              { name: "due", datatype: "date", config: { precision: "day" } },
              { name: "off", datatype: "date", multi: true, config: { precision: "day" } },
              { name: "at", datatype: "date", config: { precision: "instant" } },
            ],
          },
        ],
      })
    ).id;
  });
  afterAll(async () => {
    await db.close();
  });

  const titles = async (filters: ItemFilter[], sort?: { property: string; direction?: "asc" | "desc" }) =>
    (await queryItems(db, userId, bundleId, { itemType: "task", filters, sort })).data.map((i) => i.values.title);

  it("stores and returns a day as sent, on create and update, single and multi", async () => {
    const [made] = await createItems(db, userId, bundleId, {
      itemType: "task",
      items: [{ title: "write", due: "2026-11-16", off: ["2026-12-24", "2026-12-25"], at: "2026-11-16" }],
    });
    expect(made!.values).toMatchObject({ due: "2026-11-16", off: ["2026-12-24", "2026-12-25"], at: "2026-11-16T00:00:00.000Z" });
    const [updated] = await updateItems(db, userId, bundleId, [{ id: made!.id, set: { due: "2028-02-29" } }]);
    expect(updated!.values.due).toBe("2028-02-29");
    expect((await getItems(db, userId, bundleId, [made!.id]))[0]!.values.due).toBe("2028-02-29");
  });

  it.each(DAY_REFUSED)("refuses %s on create, update and as a filter value", async (input) => {
    await expect(createItems(db, userId, bundleId, { itemType: "task", items: [{ title: "x", due: input }] })).rejects.toThrow(
      dayRefusal(/property "due"/, input),
    );
    await expect(
      createItems(db, userId, bundleId, { itemType: "task", items: [{ title: "x", off: ["2026-11-16", input] }] }),
    ).rejects.toThrow(dayRefusal(/property "off"/, input));
    const [kept] = await createItems(db, userId, bundleId, { itemType: "task", items: [{ title: "kept", due: "2026-01-01" }] });
    await expect(updateItems(db, userId, bundleId, [{ id: kept!.id, set: { due: input } }])).rejects.toThrow(
      dayRefusal(/property "due"/, input),
    );
    expect((await getItems(db, userId, bundleId, [kept!.id]))[0]!.values.due).toBe("2026-01-01");
    for (const op of ["eq", "neq", "gte", "lt"] as const) {
      await expect(titles([{ property: "due", op, value: input }]), op).rejects.toThrow(dayRefusal(/filter on "due"/, input));
    }
    await expect(titles([{ property: "off", op: "has_all", value: ["2026-11-16", input] }])).rejects.toThrow(
      dayRefusal(/property "off"/, input),
    );
  });

  it("refuses a value that is not a string", async () => {
    await expect(createItems(db, userId, bundleId, { itemType: "task", items: [{ title: "x", due: 20261116 }] })).rejects.toThrow(
      /property "due" expects a day, got 20261116/,
    );
  });

  describe("filters and sort", () => {
    const days = ["2024-04-30", "2024-05-01", "2024-05-02", "2023-12-31", "2025-01-01"];
    let ids: string[];
    beforeAll(async () => {
      const made = await createItems(db, userId, bundleId, {
        itemType: "task",
        items: [...days.map((d) => ({ title: `f${d}`, due: d, off: [d] })), { title: "fnone" }],
      });
      ids = made.map((m) => m.id);
    });
    const only = (filters: ItemFilter[]) => [{ property: "title", op: "contains" as const, value: "f20" }, ...filters];

    it("eq and in match the day exactly", async () => {
      expect(await titles(only([{ property: "due", op: "eq", value: "2024-05-01" }]))).toEqual(["f2024-05-01"]);
      expect(
        await titles(only([{ property: "due", op: "in", value: ["2024-05-02", "2023-12-31", "1999-01-01"] }]), { property: "due" }),
      ).toEqual(["f2023-12-31", "f2024-05-02"]);
      expect(await titles(only([{ property: "off", op: "has", value: "2025-01-01" }]))).toEqual(["f2025-01-01"]);
    });

    it("ranges compare as days", async () => {
      expect(await titles(only([{ property: "due", op: "lt", value: "2024-05-01" }]), { property: "due" })).toEqual([
        "f2023-12-31",
        "f2024-04-30",
      ]);
      expect(await titles(only([{ property: "due", op: "gte", value: "2024-05-01" }]), { property: "due" })).toEqual([
        "f2024-05-01",
        "f2024-05-02",
        "f2025-01-01",
      ]);
      expect(
        await titles(only([{ property: "off", op: "gt", value: "2024-05-01", quantifier: "all" }]), { property: "due" }),
      ).toEqual(["f2024-05-02", "f2025-01-01"]);
    });

    it("sort orders by day in both directions, missing last", async () => {
      const sorted = [...days].sort().map((d) => `f${d}`);
      const ours = (list: unknown[]) => list.filter((t) => typeof t === "string" && /^f(20|none)/.test(t));
      expect(ours(await titles([], { property: "due" }))).toEqual([...sorted, "fnone"]);
      expect(ours(await titles([], { property: "due", direction: "desc" }))).toEqual([...sorted.reverse(), "fnone"]);
      expect(ids).toHaveLength(6);
    });

    it("the stored text orders like the days under the database's default collation", async () => {
      // A linguistic collation (Postgres's default en_US, say) is not byte
      // order; check fixed-width days still sort chronologically under it.
      const probe = ["2024-05-01", "2024-04-30", "1999-12-31", "2000-01-01", "2024-05-10", "2024-10-05", "0099-01-01"];
      const values = sql.join(
        probe.map((v) => sql`(${v})`),
        sql`, `,
      );
      const result: any = await (db.dialect === "pg"
        ? (db.client as any).execute(sql`SELECT v FROM (VALUES ${values}) AS t(v) ORDER BY v`)
        : (db.client as any).all(sql`SELECT column1 AS v FROM (VALUES ${values}) ORDER BY v`));
      const rows = (Array.isArray(result) ? result : result.rows) as { v: string }[];
      expect(rows.map((r) => r.v)).toEqual([...probe].sort());
    });
  });

  describe("switching an existing property", () => {
    let typeId: string;
    beforeAll(async () => {
      const [type] = await listItemTypesUnchecked(db, bundleId);
      typeId = type!.id;
    });
    const addDateProp = async (name: string, multi = false) => (await addProperty(db, userId, typeId, { name, datatype: "date", multi })).id;

    it("to day converts values that are all midnight UTC, and back again", async () => {
      const propId = await addDateProp("start", true);
      const made = await createItems(db, userId, bundleId, {
        itemType: "task",
        items: [
          { title: "s1", start: ["2026-11-16", "2026-11-17T00:00:00Z"] },
          { title: "s2", start: ["2026-11-15T01:00:00+01:00"] },
          { title: "s3" },
        ],
      });
      const toDay = await updateProperty(db, userId, typeId, propId, { config: { precision: "day" } });
      expect(JSON.parse(toDay.config)).toEqual({ precision: "day" });
      const read = async () => (await getItems(db, userId, bundleId, made.map((m) => m.id))).map((i) => i.values.start);
      expect(await read()).toEqual([["2026-11-16", "2026-11-17"], ["2026-11-15"], undefined]);
      expect(await titles([{ property: "start", op: "eq", value: "2026-11-15", quantifier: "any" }])).toEqual(["s2"]);

      // config replaces whole: leaving precision out means instant.
      await updateProperty(db, userId, typeId, propId, { config: {} });
      expect(await read()).toEqual([
        ["2026-11-16T00:00:00.000Z", "2026-11-17T00:00:00.000Z"],
        ["2026-11-15T00:00:00.000Z"],
        undefined,
      ]);
      await updateProperty(db, userId, typeId, propId, { config: { precision: "day" } });
      await updateProperty(db, userId, typeId, propId, { config: { precision: "instant" } });
      expect((await read())[1]).toEqual(["2026-11-15T00:00:00.000Z"]);
    });

    it("a patch that leaves config alone keeps the values", async () => {
      const propId = await addDateProp("kept");
      const [made] = await createItems(db, userId, bundleId, { itemType: "task", items: [{ title: "k", kept: "2026-03-01" }] });
      await updateProperty(db, userId, typeId, propId, { config: { precision: "day" } });
      await updateProperty(db, userId, typeId, propId, { name: "kept2", required: false });
      expect((await getItems(db, userId, bundleId, [made!.id]))[0]!.values.kept2).toBe("2026-03-01");
      await updateProperty(db, userId, typeId, propId, { config: { precision: "day" } });
      expect((await getItems(db, userId, bundleId, [made!.id]))[0]!.values.kept2).toBe("2026-03-01");
    });

    it("to day is refused, naming the items, when any value is not midnight UTC, and nothing changes", async () => {
      const propId = await addDateProp("when");
      const made = await createItems(db, userId, bundleId, {
        itemType: "task",
        items: [
          { title: "w1", when: "2026-11-16" },
          { title: "w2", when: "2026-11-16T00:00:00+01:00" }, // 23:00 UTC on the 15th
          { title: "w3", when: "2026-11-16T12:30:00Z" },
        ],
      });
      const [w1, w2, w3] = made.map((m) => m.id);
      const err = await updateProperty(db, userId, typeId, propId, { name: "renamed", config: { precision: "day" } }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/cannot switch "when" to precision "day"/);
      expect(err.message).toContain(w2!);
      expect(err.message).toContain(w3!);
      expect(err.message).not.toContain(w1!);
      // The rewrite of w1 and the rename rolled back with the refusal.
      const [type] = (await listItemTypesUnchecked(db, bundleId)).filter((t) => t.id === typeId);
      const prop = type!.properties.find((p) => p.id === propId)!;
      expect(prop.name).toBe("when");
      expect(prop.config).toBe("");
      expect((await getItems(db, userId, bundleId, [w1!]))[0]!.values.when).toBe("2026-11-16T00:00:00.000Z");
      // Fixed by hand, the switch goes through.
      await updateItems(db, userId, bundleId, [
        { id: w2!, set: { when: "2026-11-16" } },
        { id: w3!, set: { when: null } },
      ]);
      await updateProperty(db, userId, typeId, propId, { config: { precision: "day" } });
      expect((await getItems(db, userId, bundleId, [w1!, w2!])).map((i) => i.values.when)).toEqual(["2026-11-16", "2026-11-16"]);
    });

    it("names at most five items", async () => {
      const propId = await addDateProp("many");
      const made = await createItems(db, userId, bundleId, {
        itemType: "task",
        items: Array.from({ length: 7 }, (_, i) => ({ title: `m${i}`, many: `2026-11-1${i}T23:00:00Z` })),
      });
      const err = await updateProperty(db, userId, typeId, propId, { config: { precision: "day" } }).catch((e) => e);
      const named = made.filter((m) => err.message.includes(m.id));
      expect(named).toHaveLength(5);
    });

    /** Holds the next db.transaction call until resume(): its validation has run, its writes have not. */
    const pauseNextTransaction = () => {
      const original = db.transaction;
      let resume!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((r) => (resume = r));
      const paused = new Promise<void>((r) => (reached = r));
      db.transaction = (async (fn: any) => {
        db.transaction = original;
        reached();
        await gate;
        return original.call(db, fn);
      }) as Db["transaction"];
      return { paused, resume };
    };

    it("an item write validated before a switch commits is refused as a conflict, not stored in the old form", async () => {
      const propId = await addDateProp("raced");
      const [kept] = await createItems(db, userId, bundleId, { itemType: "task", items: [{ title: "r0", raced: "2026-11-16" }] });
      const gate = pauseNextTransaction();
      const writing = createItems(db, userId, bundleId, { itemType: "task", items: [{ title: "r1", raced: "2026-11-16T12:00:00Z" }] });
      await gate.paused;
      await updateProperty(db, userId, typeId, propId, { config: { precision: "day" } });
      gate.resume();
      await expect(writing).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/"raced" changed precision/) });
      expect(await titles([{ property: "title", op: "eq", value: "r1" }])).toEqual([]);

      const updateGate = pauseNextTransaction();
      const updating = updateItems(db, userId, bundleId, [{ id: kept!.id, set: { raced: "2026-11-20" } }]);
      await updateGate.paused;
      await updateProperty(db, userId, typeId, propId, { config: {} });
      updateGate.resume();
      await expect(updating).rejects.toMatchObject({ code: "conflict" });
      expect((await getItems(db, userId, bundleId, [kept!.id]))[0]!.values.raced).toBe("2026-11-16T00:00:00.000Z");
    });

    it("a config change decides the conversion from the precision stored when it commits", async () => {
      const propId = await addDateProp("decided");
      const [made] = await createItems(db, userId, bundleId, { itemType: "task", items: [{ title: "d", decided: "2026-11-18" }] });
      // A asks for instant while the property is instant; B switches to day first.
      const gate = pauseNextTransaction();
      const a = updateProperty(db, userId, typeId, propId, { config: { precision: "instant" } });
      await gate.paused;
      await updateProperty(db, userId, typeId, propId, { config: { precision: "day" } });
      gate.resume();
      expect(JSON.parse((await a).config)).toEqual({ precision: "instant" });
      // A saw day and converted back, so config and values agree.
      expect((await getItems(db, userId, bundleId, [made!.id]))[0]!.values.decided).toBe("2026-11-18T00:00:00.000Z");
    });

    it("on Postgres, a switch and an item write wait for each other's row lock", async (ctx) => {
      if (db.dialect !== "pg") return ctx.skip();
      const pg = createRequire(import.meta.url)("pg");
      const other = new pg.Client({ connectionString: process.env.YAP_TEST_PG_URL });
      await other.connect();
      const settled = (p: Promise<unknown>) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 300))]);
      try {
        const propId = await addDateProp("locked");
        await createItems(db, userId, bundleId, { itemType: "task", items: [{ title: "l0", locked: "2026-11-16" }] });
        // An item write in flight holds a key-share lock: the switch waits for it.
        await other.query("BEGIN");
        await other.query("SELECT 1 FROM properties WHERE id = $1 FOR KEY SHARE", [propId]);
        const switching = updateProperty(db, userId, typeId, propId, { config: { precision: "day" } });
        expect(await settled(switching)).toBe(false);
        await other.query("COMMIT");
        await switching;
        // A switch in flight holds the row for update: the item write waits for it.
        await other.query("BEGIN");
        await other.query("SELECT 1 FROM properties WHERE id = $1 FOR UPDATE", [propId]);
        const writing = createItems(db, userId, bundleId, { itemType: "task", items: [{ title: "l1", locked: "2026-11-17" }] });
        expect(await settled(writing)).toBe(false);
        await other.query("COMMIT");
        expect((await writing)[0]!.values.locked).toBe("2026-11-17");
      } finally {
        await other.end();
      }
    });

    it("refuses an unknown precision", async () => {
      const propId = await addDateProp("bad");
      await expect(updateProperty(db, userId, typeId, propId, { config: { precision: "week" as never } })).rejects.toThrow(
        /config.precision must be one of: day, instant/,
      );
    });
  });

  it("precision is only valid on a date property", async () => {
    const [type] = await listItemTypesUnchecked(db, bundleId);
    await expect(
      addProperty(db, userId, type!.id, { name: "label", datatype: "text", config: { precision: "day" } }),
    ).rejects.toThrow(/config.precision is not valid for a text property/);
  });
});

describeEachAdapter("day-precision dates (REST and MCP)", (adapter) => {
  let app: TestApp;
  let rest: ApiClient;
  let mcp: McpTestClient;
  let spaceId: string;
  let bundleId: string;
  let typeId: string;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const u = await sysadmin.post("/v1/users", { name: "Alice" });
    rest = apiClient(app.baseUrl, u.body.initialKey.key);
    mcp = await connectMcp(app.baseUrl, u.body.initialKey.key);
    spaceId = (await rest.post("/v1/spaces", { name: "Work" })).body.id;
    bundleId = (await rest.post(`/v1/spaces/${spaceId}/bundles`, { name: "b" })).body.id;
    typeId = (
      await rest.post(`/v1/bundles/${bundleId}/item-types`, {
        name: "task",
        properties: [{ name: "due", datatype: "date", config: { precision: "day" } }],
      })
    ).body.id;
  });
  afterAll(async () => {
    await mcp.close();
    await app.stop();
  });

  const one = async (tool: string, params: unknown) =>
    (await mcp.call("call", { space_id: spaceId, calls: [{ bundle_id: bundleId, tool, params }] })).results[0];

  it("REST takes a day, refuses a timestamp with a 400, and switches a property", async () => {
    const ok = await rest.post(`/v1/bundles/${bundleId}/items`, { itemType: "task", items: [{ due: "2026-11-16" }] });
    expect(ok.status).toBe(201);
    expect(ok.body.data[0].values.due).toBe("2026-11-16");
    const bad = await rest.post(`/v1/bundles/${bundleId}/items`, { itemType: "task", items: [{ due: "2026-11-16T00:00:00+01:00" }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(dayRefusal(/property "due"/, "2026-11-16T00:00:00+01:00"));
    const filters = encodeURIComponent(JSON.stringify([{ property: "due", op: "eq", value: "2026-11-16" }]));
    const found = await rest.get(`/v1/bundles/${bundleId}/items?itemType=task&filters=${filters}`);
    expect(found.body.data.map((i: any) => i.id)).toEqual([ok.body.data[0].id]);

    const added = await rest.post(`/v1/item-types/${typeId}/properties`, { name: "at", datatype: "date" });
    await rest.patch(`/v1/items/${ok.body.data[0].id}`, { set: { at: "2026-11-15T23:00:00Z" } });
    const refused = await rest.patch(`/v1/item-types/${typeId}/properties/${added.body.id}`, { config: { precision: "day" } });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain(ok.body.data[0].id);
    const badKey = await rest.patch(`/v1/item-types/${typeId}/properties/${added.body.id}`, { config: { precision: "hour" } });
    expect(badKey.status).toBe(400);
  });

  it("MCP takes a day and refuses a timestamp; the schema shows the precision", async () => {
    const ok = await one("create_items", { item_type: "task", items: [{ due: "2027-01-01" }] });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect(ok.result[0].values.due).toBe("2027-01-01");
    const bad = await one("query_items", { item_type: "task", filters: [{ property: "due", op: "lt", value: "2027-01-01T00:00:00Z" }] });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe("invalid_request");
    expect(bad.error.message).toMatch(dayRefusal(/filter on "due"/, "2027-01-01T00:00:00Z"));
    const loaded = await mcp.call("load_bundle", { bundle_ids: [bundleId] });
    const due = loaded.bundles[0].item_types[0].properties.find((p: any) => p.name === "due");
    expect(due.config).toEqual({ precision: "day" });
  });
});
