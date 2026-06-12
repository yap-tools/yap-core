/**
 * Spaces: the organizational tier below the root. Deliberately flat — spaces
 * do not nest. Space creation is an account-level right, not a granted
 * capability; creating a space seeds explicit allow rows for the creator so
 * access stays row-decided and auditable (the personal space is the only
 * implicit-capability place in the system).
 */
import { and, asc, eq, inArray, or } from "drizzle-orm";

import type { BlobStore } from "../blob/index.js";
import type { Db } from "../db/index.js";
import { assertAccountWrite } from "./authScope.js";
import { KNOWN_CAPABILITIES, hasAnyCapability, requireCapability, type SpaceRef } from "./capabilities.js";
import { invalid, notFound } from "./errors.js";
import { clampLimit, decodeCursor, toPage, type Page } from "./pagination.js";
import { newId, nowIso } from "./util.js";

export interface Space {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  keywords: string;
  context: string;
  personal: number;
  createdAt: string;
  updatedAt: string;
}

export async function createSpace(
  db: Db,
  userId: string,
  input: { name: string; description?: string; keywords?: string; context?: string },
): Promise<Space> {
  // Space creation is account-level (no capability gate), so the token-scope
  // clamp has to be asserted here rather than in capability resolution.
  assertAccountWrite();
  const name = input.name?.trim();
  if (!name) throw invalid("space name is required");
  const { spaces, grants } = db.tables;
  const now = nowIso();
  const space: Space = {
    id: newId(),
    ownerId: userId,
    name,
    description: input.description ?? "",
    keywords: input.keywords ?? "",
    context: input.context ?? "",
    personal: 0,
    createdAt: now,
    updatedAt: now,
  };
  await db.client.insert(spaces).values(space);
  await db.client.insert(grants).values(
    KNOWN_CAPABILITIES.map((capability) => ({
      id: newId(),
      userId,
      resourceType: "space",
      resourceId: space.id,
      capability,
      effect: "allow",
      createdAt: now,
    })),
  );
  return space;
}

/** A space is reachable if the user owns it or holds any grant row on it or on a bundle inside it. */
export async function listSpacesForUser(
  db: Db,
  userId: string,
  opts: { cursor?: string; limit?: string | number } = {},
): Promise<Page<Space>> {
  const { spaces, grants, bundles } = db.tables;
  const granted = await db.client
    .select({ resourceType: grants.resourceType, resourceId: grants.resourceId })
    .from(grants)
    .where(eq(grants.userId, userId));
  const spaceIds = new Set<string>(granted.filter((g) => g.resourceType === "space").map((g) => g.resourceId));
  const bundleIds = granted.filter((g) => g.resourceType === "bundle").map((g) => g.resourceId);
  if (bundleIds.length > 0) {
    const rows = await db.client
      .select({ spaceId: bundles.spaceId })
      .from(bundles)
      .where(inArray(bundles.id, bundleIds));
    for (const row of rows) spaceIds.add(row.spaceId);
  }
  const limit = clampLimit(opts.limit);
  const offset = decodeCursor(opts.cursor);
  const reachable = or(
    eq(spaces.ownerId, userId),
    ...(spaceIds.size > 0 ? [inArray(spaces.id, [...spaceIds])] : []),
  );
  const rows = await db.client
    .select()
    .from(spaces)
    .where(reachable)
    .orderBy(asc(spaces.createdAt), asc(spaces.id))
    .limit(limit + 1)
    .offset(offset);
  return toPage(rows, offset, limit);
}

export async function getSpaceRow(db: Db, spaceId: string): Promise<Space> {
  const { spaces } = db.tables;
  const rows = await db.client.select().from(spaces).where(eq(spaces.id, spaceId));
  if (rows.length === 0) throw notFound("space", spaceId);
  return rows[0]!;
}

export function toSpaceRef(space: Space): SpaceRef {
  return { id: space.id, ownerId: space.ownerId, personal: space.personal };
}

/**
 * Space reachability: owner, any effective space-level capability, or any
 * allow grant on a bundle inside the space (a bundle-only member must still
 * be able to address the space to reach their bundle).
 */
export async function canReachSpace(db: Db, userId: string, space: Space): Promise<boolean> {
  if (space.ownerId === userId) return true;
  if (await hasAnyCapability(db, userId, { space: toSpaceRef(space) })) return true;
  const { grants, bundles } = db.tables;
  const rows = await db.client
    .select({ id: grants.id })
    .from(grants)
    .innerJoin(bundles, eq(grants.resourceId, bundles.id))
    .where(
      and(
        eq(grants.userId, userId),
        eq(grants.resourceType, "bundle"),
        eq(bundles.spaceId, space.id),
        eq(grants.effect, "allow"),
      ),
    );
  return rows.length > 0;
}

export async function updateSpace(
  db: Db,
  userId: string,
  spaceId: string,
  patch: { name?: string; description?: string; keywords?: string; context?: string },
): Promise<Space> {
  const space = await getSpaceRow(db, spaceId);
  if (space.personal && patch.name !== undefined && patch.name !== space.name) {
    throw invalid("the personal space cannot be renamed");
  }
  await requireCapability(db, userId, "manage_space", { space: toSpaceRef(space) });
  if (patch.name !== undefined && !patch.name.trim()) throw invalid("space name cannot be empty");
  const { spaces } = db.tables;
  const updated = {
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.keywords !== undefined ? { keywords: patch.keywords } : {}),
    ...(patch.context !== undefined ? { context: patch.context } : {}),
    updatedAt: nowIso(),
  };
  await db.client.update(spaces).set(updated).where(eq(spaces.id, spaceId));
  return getSpaceRow(db, spaceId);
}

export async function deleteSpace(db: Db, userId: string, spaceId: string, blob: BlobStore): Promise<void> {
  const space = await getSpaceRow(db, spaceId);
  if (space.personal) throw invalid("the personal space cannot be deleted");
  await requireCapability(db, userId, "manage_space", { space: toSpaceRef(space) });
  const { spaces, grants, bundles, files } = db.tables;
  // Grant rows reference resources by id without FK (resource may be a space
  // or a bundle), so clean up explicitly — including rows on cascaded bundles.
  const bundleRows = await db.client.select({ id: bundles.id }).from(bundles).where(eq(bundles.spaceId, spaceId));
  // Capture blob keys before the file rows cascade away.
  const fileRows = await db.client.select({ storageKey: files.storageKey }).from(files).where(eq(files.spaceId, spaceId));
  await db.client.delete(spaces).where(eq(spaces.id, spaceId));
  for (const row of fileRows) await blob.delete(row.storageKey);
  await db.client
    .delete(grants)
    .where(and(eq(grants.resourceType, "space"), eq(grants.resourceId, spaceId)));
  if (bundleRows.length > 0) {
    await db.client.delete(grants).where(
      and(
        eq(grants.resourceType, "bundle"),
        inArray(grants.resourceId, bundleRows.map((b) => b.id)),
      ),
    );
  }
}
