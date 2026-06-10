import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";

import type { Db } from "../../src/db/index.js";
import { describeEachAdapter } from "../helpers/adapters.js";

describeEachAdapter("db adapter", (adapter) => {
  let db: Db;

  afterEach(async () => {
    await db.close();
  });

  it("migrates and round-trips rows", async () => {
    db = await adapter.makeDb();
    const { users } = db.tables;
    const now = new Date().toISOString();
    await db.client.insert(users).values({ id: "u1", name: "Troels", createdAt: now });
    const rows = await db.client.select().from(users).where(eq(users.id, "u1"));
    expect(rows).toEqual([{ id: "u1", name: "Troels", createdAt: now }]);
  });

  it("enforces cascade deletes through foreign keys", async () => {
    db = await adapter.makeDb();
    const { users, accessKeys } = db.tables;
    const now = new Date().toISOString();
    await db.client.insert(users).values({ id: "u1", name: "A", createdAt: now });
    await db.client
      .insert(accessKeys)
      .values({ id: "k1", userId: "u1", name: "default", keyHash: "h", createdAt: now });
    await db.client.delete(users).where(eq(users.id, "u1"));
    const keys = await db.client.select().from(accessKeys);
    expect(keys).toEqual([]);
  });
});
