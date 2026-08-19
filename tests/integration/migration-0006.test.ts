/**
 * The 0006 cutover: the `hooks` table becomes `services` (with the new
 * driver/pins columns and the renamed config_encrypted blob), the `runs`
 * audit table appears, and grant capabilities are renamed in place. Seeded
 * through journal index 5 — the pre-services head — then migrated forward,
 * so both dialects exercise their hand-written 0006 SQL.
 */
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";

import { describeEachAdapter } from "../helpers/adapters.js";

const now = "2026-01-01T00:00:00.000Z";

describeEachAdapter("migration-0006", (adapter) => {
  it("migrates hooks rows into services and renames grant capabilities", async () => {
    const db = await adapter.makeFreshDb();
    try {
      await db.migrateTo(5); // apply through 0005 (the pre-services head)
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
      await db.insertRows("hooks", [
        {
          id: "h1",
          bundle_id: "b1",
          name: "notify",
          description: "",
          params: "[]",
          transport_encrypted: "v1.x.y.z",
          created_at: now,
          updated_at: now,
        },
      ]);
      await db.insertRows("grants", [
        {
          id: "g1",
          user_id: "u1",
          resource_type: "space",
          resource_id: "s1",
          capability: "fire_hooks",
          effect: "allow",
          created_at: now,
        },
        {
          id: "g2",
          user_id: "u1",
          resource_type: "bundle",
          resource_id: "b1",
          capability: "edit_hooks",
          effect: "allow",
          created_at: now,
        },
        {
          id: "g3",
          user_id: "u1",
          resource_type: "space",
          resource_id: "s1",
          capability: "read_items",
          effect: "allow",
          created_at: now,
        },
      ]);

      await db.migrate(); // apply the rest, incl. 0006
      expect(await db.appliedMigrations()).toBe(db.journalLength());

      const services = await db.client.select().from(db.tables.services);
      expect(services).toHaveLength(1);
      expect(services[0]).toMatchObject({
        id: "h1",
        bundleId: "b1",
        name: "notify",
        driver: "http",
        params: "[]",
        pins: "{}",
        configEncrypted: "v1.x.y.z",
        createdAt: now,
        updatedAt: now,
      });

      const tables = await db.listDataTables();
      expect(tables).toContain("services");
      expect(tables).toContain("runs");
      expect(tables).not.toContain("hooks");

      const grants = await db.client.select().from(db.tables.grants);
      const byId = Object.fromEntries(grants.map((g) => [g.id, g.capability]));
      expect(byId).toEqual({ g1: "run_services", g2: "edit_services", g3: "read_items" });
    } finally {
      await db.close();
    }
  });

  it("keeps runs when their service is deleted and drops them with the bundle", async () => {
    const db = await adapter.makeDb();
    try {
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
          id: "r1",
          bundle_id: "b1",
          service_id: "sv1",
          service_name: "notify",
          action: "send",
          status: "succeeded",
          params: "{}",
          result: "ok",
          error: null,
          writes: "[]",
          created_at: now,
          started_at: now,
          finished_at: now,
        },
      ]);

      const { services, runs, bundles } = db.tables;
      await db.client.delete(services).where(eq(services.id, "sv1"));
      const afterServiceDelete = await db.client.select().from(runs);
      expect(afterServiceDelete).toHaveLength(1);
      expect(afterServiceDelete[0]).toMatchObject({
        id: "r1",
        serviceId: null,
        serviceName: "notify",
        action: "send",
        status: "succeeded",
      });

      await db.client.delete(bundles).where(eq(bundles.id, "b1"));
      expect(await db.client.select().from(runs)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
