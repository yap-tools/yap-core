/**
 * Grant rows: (user, resource, capability, effect). A grant is the storage
 * form of a role assignment — a role is a set of capabilities, so granting a
 * role writes one row per capability. A revoke (deny) is a first-class row.
 * Personal spaces accept no grants: sharing is disabled there entirely.
 * Rows are read back with the grantee's name and email beside the user id,
 * so whoever manages roles can see who holds what; a grant can name its
 * grantee by email instead of id.
 */
import { and, asc, eq, getTableColumns } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { CAPABILITY_NAME_PATTERN, normalizeCapability, requireCapability } from "./capabilities.js";
import { invalid, notFound } from "./errors.js";
import { getSpaceRow, toSpaceRef, type Space } from "./spaces.js";
import { getUser, getUserByEmail } from "./users.js";
import { newId, nowIso } from "./util.js";

export interface Grant {
  id: string;
  userId: string;
  resourceType: string;
  resourceId: string;
  capability: string;
  effect: string;
  createdAt: string;
  /** The grantee's name and email (null when they have none), read with the row. */
  userName: string;
  userEmail: string | null;
}

export interface GrantTarget {
  type: "space" | "bundle";
  id: string;
  /** The space the target lives in (the bundle's space for bundle targets). */
  space: Space;
}

async function requireManageRoles(db: Db, actorId: string, target: GrantTarget): Promise<void> {
  await requireCapability(db, actorId, "manage_roles", {
    space: toSpaceRef(target.space),
    ...(target.type === "bundle" ? { bundleId: target.id } : {}),
  });
}

export async function createGrants(
  db: Db,
  actorId: string,
  target: GrantTarget,
  input: { userId?: unknown; email?: unknown; capabilities: string[]; effect: "allow" | "deny" },
): Promise<Grant[]> {
  const byId = input.userId != null;
  if (byId === (input.email != null)) {
    throw invalid(byId ? "give the grantee by user id or by email, not both" : "a grantee is required: a user id or an email");
  }
  if (byId && typeof input.userId !== "string") throw invalid("user id must be a string");
  if (target.space.personal) throw invalid("the personal space cannot be shared");
  if (input.effect !== "allow" && input.effect !== "deny") {
    throw invalid(`effect must be "allow" or "deny"`);
  }
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
    throw invalid("capabilities must be a non-empty array");
  }
  for (const cap of input.capabilities) {
    if (typeof cap !== "string" || !CAPABILITY_NAME_PATTERN.test(cap)) {
      throw invalid(`invalid capability name: ${JSON.stringify(cap)}`);
    }
  }
  await requireManageRoles(db, actorId, target);
  // The grantee must exist. By email: the stored address, normalised the same
  // way; a user who has not logged in yet (an invite) is a valid grantee, and
  // no user is ever created here.
  const grantee = byId ? await getUser(db, input.userId as string) : await getUserByEmail(db, input.email);

  const { grants } = db.tables;
  const now = nowIso();
  // Legacy capability names (e.g. "fire_hooks") are accepted here and
  // normalized before storage, so every stored row carries the current name.
  const rows = input.capabilities.map((capability) => ({
    id: newId(),
    userId: grantee.id,
    resourceType: target.type,
    resourceId: target.id,
    capability: normalizeCapability(capability),
    effect: input.effect,
    createdAt: now,
  }));
  await db.client.insert(grants).values(rows);
  return rows.map((row) => ({ ...row, userName: grantee.name, userEmail: grantee.email }));
}

export async function listGrants(db: Db, actorId: string, target: GrantTarget): Promise<Grant[]> {
  await requireManageRoles(db, actorId, target);
  const { grants, users } = db.tables;
  // grants.user_id cascades on user delete, so the inner join drops no row.
  return db.client
    .select({ ...getTableColumns(grants), userName: users.name, userEmail: users.email })
    .from(grants)
    .innerJoin(users, eq(users.id, grants.userId))
    .where(and(eq(grants.resourceType, target.type), eq(grants.resourceId, target.id)))
    .orderBy(asc(grants.createdAt), asc(grants.id));
}

export async function deleteGrant(db: Db, actorId: string, target: GrantTarget, grantId: string): Promise<void> {
  // Authorize first — otherwise the 404-vs-403 split lets an unauthorized
  // caller probe which grant ids exist.
  await requireManageRoles(db, actorId, target);
  const { grants } = db.tables;
  const rows = await db.client
    .select({ id: grants.id })
    .from(grants)
    .where(and(eq(grants.id, grantId), eq(grants.resourceType, target.type), eq(grants.resourceId, target.id)));
  if (rows.length === 0) throw notFound("grant", grantId);
  await db.client.delete(grants).where(eq(grants.id, grantId));
}

/** Resolves a space-level grant target. */
export async function spaceGrantTarget(db: Db, spaceId: string): Promise<GrantTarget> {
  const space = await getSpaceRow(db, spaceId);
  return { type: "space", id: spaceId, space };
}
