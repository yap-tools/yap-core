/**
 * Capability resolution — the heart of the permission model.
 *
 * Storage: explicit allow/deny grant rows (user, resource, capability, effect).
 * Resolution: most-specific-wins. A bundle-level row overrides a space-level
 * row; deny beats allow at the same level; absence inherits, ultimately
 * defaulting to deny. The personal space is the one place rows are not
 * consulted: its owner implicitly holds every capability.
 *
 * `decide` is a pure function over the fetched rows so the three-state
 * algorithm can be unit-tested exhaustively; `resolveCapability` is the
 * db-backed wrapper.
 */
import { and, eq, inArray, or } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { forbidden } from "./errors.js";

export const CONTENT_CAPABILITIES = [
  "read_items",
  "edit_items",
  "edit_docs",
  "read_files",
  "edit_files",
  "fire_hooks",
  "edit_hooks",
] as const;

/** Container capabilities manage the space itself; they cascade mechanically
 * like any capability but gate space-level actions, not bundle content. */
export const CONTAINER_CAPABILITIES = ["create_bundles", "edit_bundles", "manage_roles", "manage_space"] as const;

export const KNOWN_CAPABILITIES: readonly string[] = [...CONTENT_CAPABILITIES, ...CONTAINER_CAPABILITIES];

/** The set is open-ended and extensible: any slug-shaped name is a valid capability. */
export const CAPABILITY_NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

export type Effect = "allow" | "deny";

export interface GrantRow {
  id: string;
  effect: string;
}

export type Decision =
  | { allowed: true; decidedBy: "personal_owner" }
  | { allowed: boolean; decidedBy: { grantId: string; level: "bundle" | "space"; effect: Effect } }
  | { allowed: false; decidedBy: "default_deny" };

/** Pure most-specific-wins evaluation over already-fetched grant rows. */
export function decide(bundleRows: GrantRow[], spaceRows: GrantRow[]): Decision {
  for (const [level, rows] of [
    ["bundle", bundleRows],
    ["space", spaceRows],
  ] as const) {
    if (rows.length === 0) continue;
    const denyRow = rows.find((r) => r.effect === "deny");
    const row = denyRow ?? rows[0]!;
    return {
      allowed: !denyRow,
      decidedBy: { grantId: row.id, level, effect: denyRow ? "deny" : "allow" },
    };
  }
  return { allowed: false, decidedBy: "default_deny" };
}

export interface SpaceRef {
  id: string;
  ownerId: string;
  personal: number;
}

export interface CapabilityContext {
  space: SpaceRef;
  bundleId?: string;
}

export async function resolveCapability(
  db: Db,
  userId: string,
  capability: string,
  ctx: CapabilityContext,
): Promise<Decision> {
  if (ctx.space.personal && ctx.space.ownerId === userId) {
    return { allowed: true, decidedBy: "personal_owner" };
  }
  const { grants } = db.tables;
  const rows = await db.client
    .select({ id: grants.id, effect: grants.effect, resourceType: grants.resourceType, resourceId: grants.resourceId })
    .from(grants)
    .where(
      and(
        eq(grants.userId, userId),
        eq(grants.capability, capability),
        or(
          and(eq(grants.resourceType, "space"), eq(grants.resourceId, ctx.space.id)),
          ...(ctx.bundleId ? [and(eq(grants.resourceType, "bundle"), eq(grants.resourceId, ctx.bundleId))] : []),
        ),
      ),
    );
  const bundleRows = rows.filter((r) => r.resourceType === "bundle");
  const spaceRows = rows.filter((r) => r.resourceType === "space");
  return decide(bundleRows, spaceRows);
}

/** Throws `forbidden` (with the deciding row identified) unless allowed. */
export async function requireCapability(
  db: Db,
  userId: string,
  capability: string,
  ctx: CapabilityContext,
): Promise<void> {
  const decision = await resolveCapability(db, userId, capability, ctx);
  if (!decision.allowed) {
    throw forbidden(`missing capability ${capability}`, { capability, decidedBy: decision.decidedBy });
  }
}

/**
 * Effective capability set for role display: every capability either known or
 * mentioned in the user's rows on this space/bundle, resolved individually.
 */
export async function effectiveCapabilities(
  db: Db,
  userId: string,
  ctx: CapabilityContext,
): Promise<string[]> {
  if (ctx.space.personal && ctx.space.ownerId === userId) {
    return [...KNOWN_CAPABILITIES];
  }
  const { grants } = db.tables;
  const resourceIds = ctx.bundleId ? [ctx.space.id, ctx.bundleId] : [ctx.space.id];
  const rows = await db.client
    .select({
      id: grants.id,
      effect: grants.effect,
      capability: grants.capability,
      resourceType: grants.resourceType,
      resourceId: grants.resourceId,
    })
    .from(grants)
    .where(and(eq(grants.userId, userId), inArray(grants.resourceId, resourceIds)));
  const caps = new Set<string>([...KNOWN_CAPABILITIES, ...rows.map((r) => r.capability)]);
  const result: string[] = [];
  for (const cap of caps) {
    const capRows = rows.filter((r) => r.capability === cap);
    const decision = decide(
      capRows.filter((r) => r.resourceType === "bundle" && r.resourceId === ctx.bundleId),
      capRows.filter((r) => r.resourceType === "space" && r.resourceId === ctx.space.id),
    );
    if (decision.allowed) result.push(cap);
  }
  return result.sort();
}

/**
 * "Bundle read access": the user holds at least one effective allow of any
 * capability on the bundle. Gates load_bundle, read_docs, and bundle listing.
 */
export async function hasAnyCapability(db: Db, userId: string, ctx: CapabilityContext): Promise<boolean> {
  const caps = await effectiveCapabilities(db, userId, ctx);
  return caps.length > 0;
}
