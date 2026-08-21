/**
 * The 0007 step: `services.actions`, the nullable per-service action
 * allowlist. Seeded through journal index 6 — the pre-allowlist head — then
 * migrated forward, so both dialects exercise their hand-written 0007 SQL.
 * The property pinned is the null default: a service authored before the
 * column existed reads back with `actions: null`, which the services layer
 * treats as "every action the driver declares" — exactly what the row meant
 * when it was written.
 */
import { expect, it } from "vitest";

import { createHttpDriver } from "../../src/core/drivers/http.js";
import { DriverRegistry } from "../../src/core/drivers/registry.js";
import { listServicesUnchecked } from "../../src/core/services.js";
import { loadConfig } from "../../src/config.js";
import { describeEachAdapter } from "../helpers/adapters.js";

const now = "2026-01-01T00:00:00.000Z";

describeEachAdapter("migration-0007", (adapter) => {
  it("adds a nullable services.actions column that older rows read back as null (all actions)", async () => {
    const db = await adapter.makeFreshDb();
    try {
      await db.migrateTo(6); // apply through 0006 (the pre-allowlist head)
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
          params: JSON.stringify([{ name: "message", required: true }]),
          pins: "{}",
          config_encrypted: "v1.x.y.z",
          created_at: now,
          updated_at: now,
        },
      ]);

      await db.migrate(); // apply the rest, incl. 0007
      expect(await db.appliedMigrations()).toBe(db.journalLength());

      const rows = await db.client.select().from(db.tables.services);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "sv1", driver: "http", pins: "{}", actions: null });

      // Null means "every action the driver declares": the pre-0007 row lists
      // exactly what it listed before the column existed.
      const config = loadConfig({
        YAP_SYSADMIN_KEY: "sysadmin-key-for-tests",
        YAP_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
      });
      const registry = new DriverRegistry();
      registry.register(createHttpDriver(config));
      const [listed] = await listServicesUnchecked({ db, config, registry }, "b1");
      expect(listed!.actions.map((a) => a.name)).toEqual(["fire"]);
      expect(listed!.actions[0]!.params).toEqual([{ name: "message", required: true }]);
    } finally {
      await db.close();
    }
  });
});
