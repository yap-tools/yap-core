/**
 * User provisioning (sysadmin-key REST operations). Every user receives a
 * personal space at provisioning — undeletable, unrenamable, unshareable —
 * and an initial access key whose secret is returned exactly once.
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import type { BlobStore } from "../blob/index.js";
import { generateAccessKey, hashKey } from "../crypto.js";
import type { Db } from "../db/index.js";
import { invalid, notFound } from "./errors.js";
import { clampLimit, decodeCursor, toPage, type Page } from "./pagination.js";
import { newId, nowIso } from "./util.js";

export interface User {
  id: string;
  name: string;
  /**
   * Correlation id from whatever system created the user. Opaque to Yap,
   * unique per instance when set, and never changed after creation.
   */
  externalId: string | null;
  createdAt: string;
}

export interface CurrentUser {
  id: string;
  name: string;
}

/** A user as `createUser` reports one that already existed: no key. */
export interface ExistingUser {
  user: User;
  personalSpaceId: string;
}

export interface CreatedUser extends ExistingUser {
  /** Secret access key — shown once, stored only as a hash. */
  initialKey: { id: string; name: string; key: string };
}

const EXTERNAL_ID_MAX_LENGTH = 255;

function checkExternalId(externalId: string): string {
  if (typeof externalId !== "string" || externalId.length === 0) throw invalid("externalId must be a non-empty string");
  if (externalId.length > EXTERNAL_ID_MAX_LENGTH) {
    throw invalid(`externalId must be at most ${EXTERNAL_ID_MAX_LENGTH} characters`);
  }
  return externalId;
}

/**
 * Creates a user with their personal space and initial key, as one
 * transaction. With an `externalId` the call is idempotent: if a user already
 * carries it, nothing is written and that user comes back without a key — the
 * `name` given on the repeated call is ignored.
 */
export async function createUser(db: Db, input: { name: string; externalId?: undefined }): Promise<CreatedUser>;
export async function createUser(
  db: Db,
  input: { name: string; externalId?: string | null },
): Promise<CreatedUser | ExistingUser>;
export async function createUser(
  db: Db,
  input: { name: string; externalId?: string | null },
): Promise<CreatedUser | ExistingUser> {
  const name = input.name?.trim();
  if (!name) throw invalid("user name is required");
  const externalId = input.externalId == null ? null : checkExternalId(input.externalId);
  const { users, spaces, accessKeys } = db.tables;

  return db.transaction(async (tx) => {
    const now = nowIso();
    const user: User = { id: newId(), name, externalId, createdAt: now };
    // The unique index decides races: a concurrent create with the same
    // externalId either waits for this transaction or inserts nothing.
    const inserted = await tx.insert(users).values(user).onConflictDoNothing({ target: users.externalId }).returning();
    if (inserted.length === 0) {
      const [existing] = await tx.select().from(users).where(eq(users.externalId, externalId!));
      const [personal] = await tx
        .select({ id: spaces.id })
        .from(spaces)
        .where(and(eq(spaces.ownerId, existing!.id), eq(spaces.personal, 1)));
      return { user: existing!, personalSpaceId: personal!.id };
    }

    const personalSpaceId = newId();
    await tx.insert(spaces).values({
      id: personalSpaceId,
      ownerId: user.id,
      name: "Personal",
      description: `Personal space of ${name}`,
      keywords: "personal",
      context: "",
      personal: 1,
      createdAt: now,
      updatedAt: now,
    });

    const key = generateAccessKey();
    const keyId = newId();
    await tx.insert(accessKeys).values({
      id: keyId,
      userId: user.id,
      name: "default",
      keyHash: hashKey(key),
      createdAt: now,
      revokedAt: null,
    });

    return { user, personalSpaceId, initialKey: { id: keyId, name: "default", key } };
  });
}

/** Lists users, oldest first; `externalId` narrows it to the one match (or none). */
export async function listUsers(
  db: Db,
  opts: { cursor?: string; limit?: string | number; externalId?: string } = {},
): Promise<Page<User>> {
  const { users } = db.tables;
  const limit = clampLimit(opts.limit);
  const offset = decodeCursor(opts.cursor);
  const rows = await db.client
    .select()
    .from(users)
    .where(opts.externalId === undefined ? undefined : eq(users.externalId, checkExternalId(opts.externalId)))
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(limit + 1)
    .offset(offset);
  return toPage(rows, offset, limit);
}

export async function getUser(db: Db, userId: string): Promise<User> {
  const { users } = db.tables;
  const rows = await db.client.select().from(users).where(eq(users.id, userId));
  if (rows.length === 0) throw notFound("user", userId);
  return rows[0]!;
}

export async function whoami(db: Db, userId: string): Promise<CurrentUser> {
  const user = await getUser(db, userId);
  return { id: user.id, name: user.name };
}

/**
 * Deletes the user. FK cascades remove their keys, user docs, the grant rows
 * where they are the grantee, and their owned spaces/bundles/items/files. Two
 * things the cascade does NOT cover and that this function handles explicitly:
 * (1) the blob bytes behind cascaded file records (no FK reaches storage), and
 * (2) grant rows OTHER users hold on the deleted user's spaces/bundles
 * (grants.resourceId has no FK), which would otherwise dangle.
 */
export async function deleteUser(db: Db, userId: string, blob: BlobStore): Promise<void> {
  const { users, spaces, bundles, files, grants } = db.tables;
  await getUser(db, userId);

  const ownedSpaces = await db.client.select({ id: spaces.id }).from(spaces).where(eq(spaces.ownerId, userId));
  const spaceIds = ownedSpaces.map((s) => s.id);
  let bundleIds: string[] = [];
  let storageKeys: string[] = [];
  if (spaceIds.length > 0) {
    const ownedBundles = await db.client.select({ id: bundles.id }).from(bundles).where(inArray(bundles.spaceId, spaceIds));
    bundleIds = ownedBundles.map((b) => b.id);
    if (bundleIds.length > 0) {
      const fileRows = await db.client
        .select({ storageKey: files.storageKey })
        .from(files)
        .where(inArray(files.bundleId, bundleIds));
      storageKeys = fileRows.map((f) => f.storageKey);
    }
  }

  await db.client.delete(users).where(eq(users.id, userId)); // cascades spaces, bundles, files, grantee grants

  const resourceIds = [...spaceIds, ...bundleIds];
  if (resourceIds.length > 0) {
    await db.client.delete(grants).where(inArray(grants.resourceId, resourceIds));
  }
  for (const key of storageKeys) await blob.delete(key);
}
