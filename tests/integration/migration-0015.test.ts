/**
 * The 0015 step: service approvals. Seeded through journal index 14, then
 * migrated forward, so both dialects exercise the hand-written backfill:
 * every service from before the column counts as approved (approved_at is
 * its updated_at) and runs as it did.
 */
import { expect, it } from "vitest";

import { describeEachAdapter } from "../helpers/adapters.js";

const now = "2026-01-01T00:00:00.000Z";
const later = "2026-02-01T00:00:00.000Z";

describeEachAdapter("migration-0015", (adapter) => {
  it("backfills every existing service as approved and adds the approval pages table", async () => {
    const db = await adapter.makeFreshDb();
    try {
      await db.migrateTo(14); // through 0014, the head before approvals
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
      await db.insertRows("services", [
        {
          id: "sv1",
          bundle_id: "b1",
          name: "notify",
          description: "",
          driver: "http",
          params: "[]",
          pins: "{}",
          config_encrypted: "v1.x.y.z",
          created_at: now,
          updated_at: later,
        },
      ]);

      await db.migrate();
      expect(await db.appliedMigrations()).toBe(db.journalLength());
      const rows = await db.client.select().from(db.tables.services);
      expect(rows[0]).toMatchObject({ id: "sv1", approvedAt: later, approvedBy: null });
      expect(await db.client.select().from(db.tables.serviceApprovals)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
