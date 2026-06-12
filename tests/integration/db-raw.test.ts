import { expect, it } from "vitest";

import { describeEachAdapter } from "../helpers/adapters.js";

describeEachAdapter("db raw access", (adapter) => {
  it("reports journal length and applied migrations", async () => {
    const db = await adapter.makeDb();
    const journal = db.journalLength();
    expect(journal).toBeGreaterThanOrEqual(4);
    expect(await db.appliedMigrations()).toBe(journal);
    await db.close();
  });

  it("lists data tables excluding drizzle bookkeeping", async () => {
    const db = await adapter.makeDb();
    const tables = await db.listDataTables();
    expect(tables).toContain("users");
    expect(tables).toContain("item_values");
    expect(tables.some((t) => t.includes("drizzle"))).toBe(false);
    await db.close();
  });

  it("round-trips raw rows and reads consistently inside a snapshot", async () => {
    const db = await adapter.makeDb();
    await db.insertRows("users", [
      { id: "u1", name: "a", created_at: "2026-01-01T00:00:00Z" },
      { id: "u2", name: "b", created_at: "2026-01-01T00:00:00Z" },
    ]);
    const rows = await db.snapshotRead(async (read) => read("users"));
    expect(rows.map((r) => r.id).sort()).toEqual(["u1", "u2"]);
    await db.close();
  });

  it("migrateTo stops at the requested index and migrate() finishes the rest", async () => {
    const db = await adapter.makeFreshDb();
    expect(await db.appliedMigrations()).toBe(0);
    await db.migrateTo(0);
    expect(await db.appliedMigrations()).toBe(1);
    await db.migrate();
    expect(await db.appliedMigrations()).toBe(db.journalLength());
    await db.close();
  });

  it("dropAllTables empties the database", async () => {
    const db = await adapter.makeDb();
    await db.insertRows("users", [{ id: "u1", name: "a", created_at: "x" }]);
    await db.dropAllTables();
    expect(await db.appliedMigrations()).toBe(0);
    expect(await db.listDataTables()).toEqual([]);
    await db.close();
  });
});
