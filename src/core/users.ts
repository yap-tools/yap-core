/**
 * User provisioning (sysadmin-key REST operations). Every user receives a
 * personal space at provisioning — undeletable, unrenamable, unshareable —
 * and an initial access key whose secret is returned exactly once.
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import type { BlobStore } from "../blob/index.js";
import { generateAccessKey, hashKey } from "../crypto.js";
import type { Db } from "../db/index.js";
import {
  checkDeniedCapabilities,
  parseDeniedCapabilities,
  serializeDeniedCapabilities,
  type AccountCapability,
} from "./accountCapabilities.js";
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
  /**
   * Account-level capabilities the operator has denied this user. Empty
   * unless the sysadmin set it; see accountCapabilities.ts.
   */
  deniedCapabilities: AccountCapability[];
  createdAt: string;
}

export interface CurrentUser {
  id: string;
  name: string;
  externalId: string | null;
  deniedCapabilities: AccountCapability[];
}

type UserRow = Db["tables"]["users"]["$inferSelect"];

function toUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    externalId: row.externalId,
    deniedCapabilities: parseDeniedCapabilities(row.deniedCapabilities),
    createdAt: row.createdAt,
  };
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
  if (externalId.length === 0) throw invalid("externalId must be a non-empty string");
  if (externalId.length > EXTERNAL_ID_MAX_LENGTH) {
    throw invalid(`externalId must be at most ${EXTERNAL_ID_MAX_LENGTH} characters`);
  }
  return externalId;
}

/**
 * Creates a user with their personal space and initial key, as one
 * transaction. With an `externalId` the call is idempotent: if a user already
 * carries it, nothing is written and that user comes back without a key — the
 * `name` and `deniedCapabilities` given on the repeated call are ignored.
 */
export async function createUser(
  db: Db,
  input: { name: string; externalId?: undefined; deniedCapabilities?: unknown },
): Promise<CreatedUser>;
export async function createUser(
  db: Db,
  input: { name: string; externalId?: string | null; deniedCapabilities?: unknown },
): Promise<CreatedUser | ExistingUser>;
export async function createUser(
  db: Db,
  input: { name: string; externalId?: string | null; deniedCapabilities?: unknown },
): Promise<CreatedUser | ExistingUser> {
  const name = input.name?.trim();
  if (!name) throw invalid("user name is required");
  const externalId = input.externalId == null ? null : checkExternalId(input.externalId);
  const deniedCapabilities =
    input.deniedCapabilities === undefined ? [] : checkDeniedCapabilities(input.deniedCapabilities);
  const { users, spaces, accessKeys } = db.tables;

  return db.transaction(function* (tx) {
    // The unique index decides races: a concurrent create with the same
    // externalId either waits for this transaction or inserts nothing. The
    // loop covers the user it lost to being deleted before it could be read.
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = nowIso();
      const user: User = { id: newId(), name, externalId, deniedCapabilities, createdAt: now };
      const inserted: UserRow[] = yield tx
        .insert(users)
        .values({ ...user, deniedCapabilities: serializeDeniedCapabilities(deniedCapabilities) })
        .onConflictDoNothing({ target: users.externalId })
        .returning();

      if (inserted.length === 0) {
        const existing: { user: UserRow; personalSpaceId: string | null }[] = yield tx
          .select({ user: users, personalSpaceId: spaces.id })
          .from(users)
          .leftJoin(spaces, and(eq(spaces.ownerId, users.id), eq(spaces.personal, 1)))
          .where(eq(users.externalId, externalId!));
        const found = existing[0];
        if (!found) continue;
        // Only a row written around this function (a raw insert) lacks one.
        if (!found.personalSpaceId) throw new Error(`user ${found.user.id} has no personal space`);
        return { user: toUser(found.user), personalSpaceId: found.personalSpaceId };
      }

      const personalSpaceId = newId();
      yield tx.insert(spaces).values({
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
      yield tx.insert(accessKeys).values({
        id: keyId,
        userId: user.id,
        name: "default",
        issuer: "sysadmin",
        keyHash: hashKey(key),
        createdAt: now,
        revokedAt: null,
      });

      return { user, personalSpaceId, initialKey: { id: keyId, name: "default", key } };
    }
    throw new Error(`could not create or find the user with externalId ${externalId}`);
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
  return toPage(rows.map(toUser), offset, limit);
}

export async function getUser(db: Db, userId: string): Promise<User> {
  const { users } = db.tables;
  const rows = await db.client.select().from(users).where(eq(users.id, userId));
  if (rows.length === 0) throw notFound("user", userId);
  return toUser(rows[0]!);
}

/**
 * Sets what the sysadmin may change about a user: the deny list of
 * account-level capabilities, replaced whole (an empty list clears it). It
 * binds the user's very next operation. Validation runs before the write, so
 * a rejected list leaves the stored one untouched.
 */
export async function updateUser(db: Db, userId: string, patch: { deniedCapabilities?: unknown }): Promise<User> {
  if (patch.deniedCapabilities === undefined) throw invalid("nothing to update: deniedCapabilities is required");
  const deniedCapabilities = checkDeniedCapabilities(patch.deniedCapabilities);
  const { users } = db.tables;
  const updated = await db.client
    .update(users)
    .set({ deniedCapabilities: serializeDeniedCapabilities(deniedCapabilities) })
    .where(eq(users.id, userId))
    .returning();
  if (updated.length === 0) throw notFound("user", userId);
  return toUser(updated[0]!);
}

export async function whoami(db: Db, userId: string): Promise<CurrentUser> {
  const user = await getUser(db, userId);
  return {
    id: user.id,
    name: user.name,
    externalId: user.externalId,
    deniedCapabilities: user.deniedCapabilities,
  };
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
