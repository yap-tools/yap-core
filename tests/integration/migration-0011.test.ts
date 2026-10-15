/**
 * The 0011 step: the `schedules` table, and `runs.user_id` / `runs.source` /
 * `runs.schedule_id`. Seeded through journal index 10 — the head before them —
 * then migrated forward on both dialects. Pinned here: a run recorded before
 * the columns reads back with all three null (nobody knows who started it,
 * and the record says so rather than guessing), and the cascades the schedule
 * rules rely on — deleting a schedule keeps its runs and clears their pointer;
 * deleting the service takes its schedules with it.
 */
import { asc, eq } from "drizzle-orm";
import { expect, it } from "vitest";

import { describeEachAdapter } from "../helpers/adapters.js";

const now = "2026-01-01T00:00:00.000Z";

describeEachAdapter("migration-0011", (adapter) => {
  it("adds schedules and the run starter columns; older runs read back with them null", async () => {
    const db = await adapter.makeFreshDb();
    try {
      await db.migrateTo(10); // apply through 0010 (the head before schedules)
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
          updated_at: now,
        },
      ]);
      await db.insertRows("runs", [
        {
          id: "r-old",
          bundle_id: "b1",
          service_id: "sv1",
          service_name: "notify",
          action: "fire",
          status: "succeeded",
          params: "{}",
          writes: "[]",
          created_at: now,
        },
      ]);

      await db.migrate(); // apply the rest, incl. 0011
      expect(await db.appliedMigrations()).toBe(db.journalLength());

      const { runs, schedules, services } = db.tables;
      const [old] = await db.client.select().from(runs).where(eq(runs.id, "r-old"));
      expect(old).toMatchObject({ userId: null, source: null, scheduleId: null });

      await db.insertRows("schedules", [
        {
          id: "sc1",
          bundle_id: "b1",
          service_id: "sv1",
          action: "fire",
          cron: "0 7 * * *",
          owner_id: "u1",
          created_at: now,
          updated_at: now,
        },
      ]);
      const [schedule] = await db.client.select().from(schedules);
      // Column defaults: no params, UTC, enabled.
      expect(schedule).toMatchObject({ params: "{}", timezone: "UTC", enabled: 1, lastRunId: null });

      await db.insertRows("runs", [
        {
          id: "r-new",
          bundle_id: "b1",
          service_id: "sv1",
          service_name: "notify",
          action: "fire",
          status: "succeeded",
          params: "{}",
          writes: "[]",
          created_at: now,
          user_id: "u1",
          source: "schedule",
          schedule_id: "sc1",
        },
      ]);

      // Deleting a schedule keeps its runs and clears their pointer.
      await db.client.delete(schedules).where(eq(schedules.id, "sc1"));
      const after = await db.client.select().from(runs).orderBy(asc(runs.id));
      expect(after.map((r) => [r.id, r.source, r.scheduleId])).toEqual([
        ["r-new", "schedule", null],
        ["r-old", null, null],
      ]);

      // Deleting a service takes its schedules with it.
      await db.insertRows("schedules", [
        {
          id: "sc2",
          bundle_id: "b1",
          service_id: "sv1",
          action: "fire",
          cron: "0 7 * * *",
          owner_id: "u1",
          created_at: now,
          updated_at: now,
        },
      ]);
      await db.client.delete(services).where(eq(services.id, "sv1"));
      expect(await db.client.select().from(schedules)).toHaveLength(0);
    } finally {
      await db.close();
    }
  });
});
