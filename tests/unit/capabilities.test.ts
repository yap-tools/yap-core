/**
 * Deep unit coverage of the three-state capability resolution algorithm:
 * bundle beats space; deny beats allow at the same level; absence inherits,
 * ultimately default-deny; personal-space ownership bypasses rows entirely.
 */
import { describe, expect, it } from "vitest";

import { decide, effectiveCapabilities, resolveCapability } from "../../src/core/capabilities.js";
import { createDb, type Db } from "../../src/db/index.js";

const allow = (id: string) => ({ id, effect: "allow" });
const deny = (id: string) => ({ id, effect: "deny" });

describe("decide (pure most-specific-wins evaluation)", () => {
  it("defaults to deny when no rows exist", () => {
    expect(decide([], [])).toEqual({ allowed: false, decidedBy: "default_deny" });
  });

  it("space allow grants", () => {
    expect(decide([], [allow("s1")])).toEqual({
      allowed: true,
      decidedBy: { grantId: "s1", level: "space", effect: "allow" },
    });
  });

  it("space deny denies", () => {
    expect(decide([], [deny("s1")])).toEqual({
      allowed: false,
      decidedBy: { grantId: "s1", level: "space", effect: "deny" },
    });
  });

  it("deny beats allow at the space level", () => {
    const decision = decide([], [allow("s1"), deny("s2")]);
    expect(decision.allowed).toBe(false);
    expect(decision.decidedBy).toEqual({ grantId: "s2", level: "space", effect: "deny" });
  });

  it("bundle allow grants with no space rows", () => {
    expect(decide([allow("b1")], [])).toEqual({
      allowed: true,
      decidedBy: { grantId: "b1", level: "bundle", effect: "allow" },
    });
  });

  it("bundle deny overrides a space allow (revoke on one bundle)", () => {
    const decision = decide([deny("b1")], [allow("s1")]);
    expect(decision.allowed).toBe(false);
    expect(decision.decidedBy).toEqual({ grantId: "b1", level: "bundle", effect: "deny" });
  });

  it("bundle allow overrides a space deny", () => {
    const decision = decide([allow("b1")], [deny("s1")]);
    expect(decision.allowed).toBe(true);
    expect(decision.decidedBy).toEqual({ grantId: "b1", level: "bundle", effect: "allow" });
  });

  it("bundle allow with absent space rows grants (no inheritance needed)", () => {
    expect(decide([allow("b1")], []).allowed).toBe(true);
  });

  it("deny beats allow at the bundle level even when space allows", () => {
    const decision = decide([allow("b1"), deny("b2")], [allow("s1")]);
    expect(decision.allowed).toBe(false);
    expect(decision.decidedBy).toEqual({ grantId: "b2", level: "bundle", effect: "deny" });
  });

  it("absence at the bundle level inherits the space decision", () => {
    expect(decide([], [allow("s1")]).allowed).toBe(true);
    expect(decide([], [deny("s1")]).allowed).toBe(false);
  });
});

describe("resolveCapability (db-backed)", () => {
  async function setup(): Promise<{
    db: Db;
    userId: string;
    spaceId: string;
    bundleId: string;
    insertGrant: (resourceType: string, resourceId: string, capability: string, effect: string) => Promise<string>;
  }> {
    const db = await createDb({ dialect: "sqlite", path: ":memory:" });
    await db.migrate();
    const now = new Date().toISOString();
    const { users, spaces, bundles, grants } = db.tables;
    await db.client.insert(users).values({ id: "u1", name: "U", createdAt: now });
    await db.client.insert(spaces).values({
      id: "sp1", ownerId: "u1", name: "S", description: "", keywords: "", context: "",
      personal: 0, createdAt: now, updatedAt: now,
    });
    await db.client.insert(bundles).values({
      id: "bn1", spaceId: "sp1", name: "B", description: "", docs: "", createdAt: now, updatedAt: now,
    });
    let n = 0;
    return {
      db,
      userId: "u1",
      spaceId: "sp1",
      bundleId: "bn1",
      insertGrant: async (resourceType, resourceId, capability, effect) => {
        const id = `g${++n}`;
        await db.client.insert(grants).values({
          id, userId: "u1", resourceType, resourceId, capability, effect, createdAt: now,
        });
        return id;
      },
    };
  }

  const space = (personal = 0, ownerId = "u1") => ({ id: "sp1", ownerId, personal });

  it("space allow cascades to the bundle as baseline", async () => {
    const { db, insertGrant } = await setup();
    await insertGrant("space", "sp1", "fire_hooks", "allow");
    const decision = await resolveCapability(db, "u1", "fire_hooks", { space: space(), bundleId: "bn1" });
    expect(decision.allowed).toBe(true);
    await db.close();
  });

  it("bundle-level deny overrides the space allow, and the deciding row is identifiable", async () => {
    const { db, insertGrant } = await setup();
    await insertGrant("space", "sp1", "fire_hooks", "allow");
    const denyId = await insertGrant("bundle", "bn1", "fire_hooks", "deny");
    const decision = await resolveCapability(db, "u1", "fire_hooks", { space: space(), bundleId: "bn1" });
    expect(decision).toEqual({
      allowed: false,
      decidedBy: { grantId: denyId, level: "bundle", effect: "deny" },
    });
    await db.close();
  });

  it("rows for other bundles do not leak into the check", async () => {
    const { db, insertGrant } = await setup();
    await insertGrant("space", "sp1", "fire_hooks", "allow");
    await insertGrant("bundle", "other-bundle", "fire_hooks", "deny");
    const decision = await resolveCapability(db, "u1", "fire_hooks", { space: space(), bundleId: "bn1" });
    expect(decision.allowed).toBe(true);
    await db.close();
  });

  it("rows for other capabilities do not leak into the check", async () => {
    const { db, insertGrant } = await setup();
    await insertGrant("space", "sp1", "edit_items", "allow");
    const decision = await resolveCapability(db, "u1", "read_items", { space: space(), bundleId: "bn1" });
    expect(decision).toEqual({ allowed: false, decidedBy: "default_deny" });
    await db.close();
  });

  it("personal-space owner holds every capability implicitly, rows unconsulted", async () => {
    const { db, insertGrant } = await setup();
    await insertGrant("space", "sp1", "read_items", "deny"); // would deny if consulted
    const decision = await resolveCapability(db, "u1", "read_items", { space: space(1), bundleId: "bn1" });
    expect(decision).toEqual({ allowed: true, decidedBy: "personal_owner" });
    await db.close();
  });

  it("personal space does not grant non-owners anything", async () => {
    const { db } = await setup();
    const decision = await resolveCapability(db, "u1", "read_items", { space: space(1, "someone-else") });
    expect(decision.allowed).toBe(false);
    await db.close();
  });

  it("open-ended capability names resolve like any other", async () => {
    const { db, insertGrant } = await setup();
    await insertGrant("space", "sp1", "deploy_rockets", "allow");
    const decision = await resolveCapability(db, "u1", "deploy_rockets", { space: space() });
    expect(decision.allowed).toBe(true);
    await db.close();
  });

  it("space-only context ignores bundle rows entirely", async () => {
    const { db, insertGrant } = await setup();
    await insertGrant("bundle", "bn1", "manage_roles", "allow");
    const decision = await resolveCapability(db, "u1", "manage_roles", { space: space() });
    expect(decision.allowed).toBe(false);
    await db.close();
  });

  it("effectiveCapabilities applies per-capability overrides", async () => {
    const { db, insertGrant } = await setup();
    await insertGrant("space", "sp1", "read_items", "allow");
    await insertGrant("space", "sp1", "fire_hooks", "allow");
    await insertGrant("bundle", "bn1", "fire_hooks", "deny");
    await insertGrant("bundle", "bn1", "custom_cap", "allow");
    const atSpace = await effectiveCapabilities(db, "u1", { space: space() });
    expect(atSpace).toContain("read_items");
    expect(atSpace).toContain("fire_hooks");
    expect(atSpace).not.toContain("custom_cap");
    const atBundle = await effectiveCapabilities(db, "u1", { space: space(), bundleId: "bn1" });
    expect(atBundle).toContain("read_items"); // inherited baseline
    expect(atBundle).not.toContain("fire_hooks"); // bundle deny overrides
    expect(atBundle).toContain("custom_cap"); // bundle-only allow
    await db.close();
  });
});
