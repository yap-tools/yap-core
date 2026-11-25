/**
 * User provisioning (sysadmin-key REST operations, and sign-up on a first
 * provider login). Every user receives a personal space at provisioning —
 * undeletable, unrenamable, unshareable — and, unless the caller asks
 * otherwise, an initial access key whose secret is returned exactly once
 * (never where key login is switched off for the instance or the new user,
 * keyLogin.ts).
 */
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";

import type { BlobStore } from "../blob/index.js";
import { generateAccessKey, hashKey } from "../crypto.js";
import { isUniqueViolation, type Db, type DbClient } from "../db/index.js";
import {
  checkDeniedCapabilities,
  parseDeniedCapabilities,
  serializeDeniedCapabilities,
  type AccountCapability,
} from "./accountCapabilities.js";
import { currentKeyScope, type KeyScope } from "./authScope.js";
import { invalid, notFound, YapError } from "./errors.js";
import { keyCreationRefused, keyRefusal, type KeyLoginConfig } from "./keyLogin.js";
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
  /**
   * An address the operator gave the user, or the one a provider vouched for
   * at sign-up; lowercased. Unique per instance when set. It matches a first
   * provider login to an invite (a user with an email and no linked identity
   * yet) and lets a grant name its grantee by address (getUserByEmail); a
   * returning user is recognised by their linked identity, never by this.
   */
  email: string | null;
  /**
   * The user logs in only through a login provider: their access keys are
   * refused everywhere and none can be made for them (keyLogin.ts). On for a
   * user a provider login created; the sysadmin sets and clears it.
   */
  providerLoginOnly: boolean;
  createdAt: string;
}

export interface CurrentUser {
  id: string;
  name: string;
  externalId: string | null;
  deniedCapabilities: AccountCapability[];
  providerLoginOnly: boolean;
  /** The calling access key's fixed scope — present only when the request
   * came with a scoped key, so a caller can see it is limited. */
  keyScope?: KeyScope;
}

type UserRow = Db["tables"]["users"]["$inferSelect"];

function toUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    externalId: row.externalId,
    deniedCapabilities: parseDeniedCapabilities(row.deniedCapabilities),
    email: row.email,
    providerLoginOnly: row.providerLoginOnly === 1,
    createdAt: row.createdAt,
  };
}

/** A user as `createUser` reports one that already existed: no key. */
export interface ExistingUser {
  created: false;
  user: User;
  personalSpaceId: string;
}

export interface CreatedUser {
  created: true;
  user: User;
  personalSpaceId: string;
  /** Secret access key — shown once, stored only as a hash. Present only
   * when one was minted (`initialKey: true`, the default). */
  initialKey?: { id: string; name: string; key: string };
}

const EMAIL_MAX_LENGTH = 254;

/** A plausible address, lowercased; the provider, not Core, proves it. */
export function checkEmail(raw: unknown): string {
  if (typeof raw !== "string") throw invalid("email must be a string");
  const email = raw.trim().toLowerCase();
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1 || /\s/.test(email)) {
    throw invalid("email must be an address like name@example.com");
  }
  if (email.length > EMAIL_MAX_LENGTH) throw invalid(`email must be at most ${EMAIL_MAX_LENGTH} characters`);
  return email;
}

/** The unique index on users.email, as isUniqueViolation names it. */
export const USERS_EMAIL_INDEX = { index: "users_email_idx", column: "users.email" };

/**
 * Runs a write that may set `email` and turns the unique index refusing it
 * into a 409 naming the user who has the address. The index decides, so a
 * concurrent write that takes the address first is caught the same way.
 */
async function withEmailConflict<T>(db: Db, email: string | null | undefined, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (!email || !isUniqueViolation(err, USERS_EMAIL_INDEX)) throw err;
    const holder = await findUserByEmail(db, email);
    throw new YapError(
      "conflict",
      `email ${email} is already used by ${holder ? `user ${holder.id}` : "another user"}`,
      holder ? { email, userId: holder.id } : { email },
    );
  }
}

/** The user carrying this stored (already normalised) address, if any. */
export async function findUserByEmail(db: Db, email: string): Promise<User | null> {
  const { users } = db.tables;
  const rows = await db.client.select().from(users).where(eq(users.email, email));
  return rows[0] ? toUser(rows[0]) : null;
}

/**
 * The user carrying this address, normalised like every stored email
 * (checkEmail), so case and surrounding space do not matter. 404 when no user
 * has it. A user with an email and no login yet (an invite) counts.
 */
export async function getUserByEmail(db: Db, raw: unknown): Promise<User> {
  const user = await findUserByEmail(db, checkEmail(raw));
  if (!user) throw new YapError("not_found", "no user with that email");
  return user;
}

const EXTERNAL_ID_MAX_LENGTH = 255;

function checkExternalId(externalId: string): string {
  if (externalId.length === 0) throw invalid("externalId must be a non-empty string");
  if (externalId.length > EXTERNAL_ID_MAX_LENGTH) {
    throw invalid(`externalId must be at most ${EXTERNAL_ID_MAX_LENGTH} characters`);
  }
  return externalId;
}

function checkFlag(raw: unknown): boolean {
  if (typeof raw !== "boolean") throw invalid("providerLoginOnly must be true or false");
  return raw;
}

/**
 * Creates a user with their personal space and, by default, an initial key,
 * as one transaction. `initialKey: false` creates the user without one (sign-up
 * on a first provider login: such a user logs in through their provider). An
 * initial key is refused where no key may be made: key login switched off for
 * the instance, or `providerLoginOnly` given (`initialKeyAllowed` says which
 * a caller may ask for). An `email` another user already has is a 409. With
 * an `externalId` the call is idempotent: if a
 * user already carries it, nothing is written and that user comes back with
 * `created: false` and no key — the `name`, `email`, `deniedCapabilities`,
 * `providerLoginOnly` and options given on the repeated call are ignored.
 */
type CreateUserInput = {
  name: string;
  externalId?: string | null;
  deniedCapabilities?: unknown;
  email?: string | null;
  providerLoginOnly?: unknown;
};
export async function createUser(
  db: Db,
  config: KeyLoginConfig,
  input: CreateUserInput & { externalId?: undefined },
  opts?: { initialKey?: true },
): Promise<CreatedUser & { initialKey: NonNullable<CreatedUser["initialKey"]> }>;
export async function createUser(
  db: Db,
  config: KeyLoginConfig,
  input: CreateUserInput,
  opts?: { initialKey?: boolean },
): Promise<CreatedUser | ExistingUser>;
export async function createUser(
  db: Db,
  config: KeyLoginConfig,
  input: CreateUserInput,
  opts: { initialKey?: boolean } = {},
): Promise<CreatedUser | ExistingUser> {
  const name = input.name?.trim();
  if (!name) throw invalid("user name is required");
  const externalId = input.externalId == null ? null : checkExternalId(input.externalId);
  const deniedCapabilities =
    input.deniedCapabilities === undefined ? [] : checkDeniedCapabilities(input.deniedCapabilities);
  const email = input.email == null ? null : checkEmail(input.email);
  const providerLoginOnly = input.providerLoginOnly === undefined ? false : checkFlag(input.providerLoginOnly);
  const mintKey = opts.initialKey !== false;
  // The same guard as every other key (keys.ts insertKey), checked before the
  // transaction: the user is new, so only the instance and the input decide it.
  const refused = mintKey ? keyRefusal(config, providerLoginOnly) : null;
  if (refused) throw keyCreationRefused(config, refused);
  const { users, spaces, accessKeys } = db.tables;
  // A repeated create (its externalId already names a user) stops at that
  // index's DO NOTHING on both dialects, so its email is never checked: the
  // read ignores it. Only a new user's address can be refused.
  return withEmailConflict(db, email, () => db.transaction(function* (tx) {
    // The unique index decides races: a concurrent create with the same
    // externalId either waits for this transaction or inserts nothing. The
    // loop covers the user it lost to being deleted before it could be read.
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = nowIso();
      const user: User = { id: newId(), name, externalId, deniedCapabilities, email, providerLoginOnly, createdAt: now };
      const inserted: UserRow[] = yield tx
        .insert(users)
        .values({
          ...user,
          deniedCapabilities: serializeDeniedCapabilities(deniedCapabilities),
          providerLoginOnly: providerLoginOnly ? 1 : 0,
        })
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
        return { created: false, user: toUser(found.user), personalSpaceId: found.personalSpaceId };
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

      if (!mintKey) return { created: true, user, personalSpaceId };

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

      return { created: true, user, personalSpaceId, initialKey: { id: keyId, name: "default", key } };
    }
    throw new Error(`could not create or find the user with externalId ${externalId}`);
  }));
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
 * account-level capabilities, replaced whole (an empty list clears it), the
 * email address (null clears it), and whether they log in through a provider
 * only. Setting an email on a user with no linked identity invites them: the
 * first provider login with that address (verified by the provider, or trusted
 * for it) claims the account. An address another user already has is a 409.
 * Setting `providerLoginOnly` refuses their keys from the next request on and
 * deletes the OAuth grants (and unexchanged codes) their keys authorized, in
 * the same transaction, so a client connected through a key reconnects
 * through the provider; their keys stay stored. Clearing it makes the keys
 * work again but brings no grant back. Binds the user's very next operation.
 * Validation runs before the write, so a rejected patch leaves the row untouched.
 */
export async function updateUser(
  db: Db,
  userId: string,
  patch: { deniedCapabilities?: unknown; email?: unknown; providerLoginOnly?: unknown },
): Promise<User> {
  if (patch.deniedCapabilities === undefined && patch.email === undefined && patch.providerLoginOnly === undefined) {
    throw invalid("nothing to update: give deniedCapabilities, email or providerLoginOnly");
  }
  const set: { deniedCapabilities?: string; email?: string | null; providerLoginOnly?: number } = {};
  if (patch.deniedCapabilities !== undefined) {
    set.deniedCapabilities = serializeDeniedCapabilities(checkDeniedCapabilities(patch.deniedCapabilities));
  }
  if (patch.email !== undefined) set.email = patch.email === null ? null : checkEmail(patch.email);
  if (patch.providerLoginOnly !== undefined) set.providerLoginOnly = checkFlag(patch.providerLoginOnly) ? 1 : 0;
  const { users } = db.tables;
  // An unknown user updates no row, so it is a 404 before any conflict.
  return withEmailConflict(db, set.email, () => db.transaction(function* (tx) {
    const updated: UserRow[] = yield tx.update(users).set(set).where(eq(users.id, userId)).returning();
    if (updated.length === 0) throw notFound("user", userId);
    if (set.providerLoginOnly === 1) yield* revokeKeyBackedGrants(tx, db.tables, userId);
    return toUser(updated[0]!);
  }));
}

/**
 * Deletes every OAuth grant and unexchanged code of the user that was made
 * with one of their access keys, inside the caller's transaction. Grants made
 * after a provider login carry no key and stay.
 */
export function* revokeKeyBackedGrants(
  tx: DbClient,
  tables: Db["tables"],
  userId: string,
): Generator<unknown, void, unknown> {
  const { oauthCodes, oauthGrants } = tables;
  yield tx.delete(oauthCodes).where(and(eq(oauthCodes.userId, userId), isNotNull(oauthCodes.keyId)));
  yield tx.delete(oauthGrants).where(and(eq(oauthGrants.userId, userId), isNotNull(oauthGrants.keyId)));
}

/** The caller's identity. Read inside the request's scope context, which is
 * where the calling key's scope comes from. */
export async function whoami(db: Db, userId: string): Promise<CurrentUser> {
  const user = await getUser(db, userId);
  const keyScope = currentKeyScope();
  return {
    id: user.id,
    name: user.name,
    externalId: user.externalId,
    deniedCapabilities: user.deniedCapabilities,
    providerLoginOnly: user.providerLoginOnly,
    ...(keyScope ? { keyScope: { role: keyScope.role } } : {}),
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
