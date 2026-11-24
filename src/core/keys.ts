/**
 * Access keys: identity credentials. A key proves who is making a request; an
 * unscoped key carries its user's full authority and no permissions of its
 * own. A key may instead carry a fixed scope — a role mask (`admin`, `member`
 * or `read-only`, the same masks as an OAuth token's role) that narrows what
 * the key may do below its user's authority: effective rights are the user's
 * grants intersected with the mask. A scope is set when the key is created and
 * never changes, and it limits what, never where — reach stays with grants.
 *
 * A scoped key is a narrower stand-in for its user, never the user acting in
 * person: it cannot manage keys or connected apps (so it cannot widen itself
 * or mint a wider key), and it cannot log in to the pages Core serves for a
 * person's own decisions (`pageLogin`).
 *
 * Users may hold multiple active keys; rotation revokes the old key
 * immediately, with no grace period.
 *
 * Key login can be switched off for the whole instance or for one user
 * (keyLogin.ts): `authenticateKey` then refuses the key with that reason, and
 * no key can be made (`insertKey`). Revoking a key always works.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { constantTimeEqual, generateAccessKey, hashKey, OAUTH_ACCESS_TOKEN_PREFIX } from "../crypto.js";
import type { Db, DbClient } from "../db/index.js";
import { requireAccountCapability } from "./accountCapabilities.js";
import { assertCanManageCredentials, isTokenRole, TOKEN_ROLES, type KeyScope } from "./authScope.js";
import { invalid, notFound } from "./errors.js";
import { keyCreationRefused, keyRefusal, type KeyLoginConfig, type KeyRefusal } from "./keyLogin.js";
import { revokeGrantsForKey } from "./oauth.js";
import { getUser } from "./users.js";
import { newId, nowIso } from "./util.js";

/**
 * Who issued a key: the user themself (minted or rotated over `/v1/keys`), or
 * the operator (the initial key from user creation, or one issued over the
 * sysadmin key lane). It records where the key came from and nothing else —
 * every key carries the same full authority as its user.
 */
export type KeyIssuer = "user" | "sysadmin";

export type { KeyScope };

export interface AccessKeyInfo {
  id: string;
  name: string;
  issuer: KeyIssuer;
  /** Null for an unscoped key (the user's full authority). */
  scope: KeyScope | null;
  createdAt: string;
}

/**
 * Validates a key scope from an API boundary. Absent or null means unscoped.
 * Only `role` is accepted: `spaces` and `bundles` (which an OAuth scope may
 * carry) are refused by name, because a key scope limits what a key can do,
 * never where — to limit where a machine acts, give it its own user with
 * grants only where it needs them.
 */
export function checkKeyScope(input: unknown): KeyScope | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw invalid('scope must be an object such as {"role":"read-only"}, or null for an unscoped key');
  }
  const fields = Object.keys(input);
  const located = fields.filter((field) => field === "spaces" || field === "bundles");
  if (located.length > 0) {
    throw invalid(
      "a key scope limits what a key can do, never where: spaces and bundles are not accepted (give the key's holder its own user with grants where it needs them)",
      { refused: located },
    );
  }
  const unknown = fields.filter((field) => field !== "role");
  if (unknown.length > 0) throw invalid("scope accepts role only", { unknown });
  const role = (input as { role?: unknown }).role;
  if (!isTokenRole(role)) throw invalid("scope.role must be one of the roles", { allowed: TOKEN_ROLES });
  return { role };
}

/** Reads the stored column back. Throws on anything that is not a valid
 * scope, so callers can fail closed. */
function parseStoredScope(stored: string | null): KeyScope | null {
  if (stored === null) return null;
  const scope = checkKeyScope(JSON.parse(stored));
  if (!scope) throw new Error("access_keys.scope holds JSON null");
  return scope;
}

function serializeScope(scope: KeyScope | null): string | null {
  return scope ? JSON.stringify({ role: scope.role }) : null;
}

export interface CreatedKey extends AccessKeyInfo {
  /** Secret — shown once. */
  key: string;
}

/**
 * Inside a transaction: reads the user's provider-login-only flag through a
 * no-op update, which locks the user row. Setting the flag (users.ts
 * updateUser, an invite claim) updates the same row first, so a key or grant
 * written after this in the same transaction either lands before the flag is
 * set, and is then refused or deleted with the rest, or waits and sees it set.
 * Throws not_found for no such user.
 */
export function* lockedProviderLoginOnly(
  tx: DbClient,
  tables: Db["tables"],
  userId: string,
): Generator<unknown, boolean, any> {
  const { users } = tables;
  const rows: { providerLoginOnly: number }[] = yield tx
    .update(users)
    .set({ providerLoginOnly: sql`${users.providerLoginOnly}` })
    .where(eq(users.id, userId))
    .returning({ providerLoginOnly: users.providerLoginOnly });
  const row = rows[0];
  if (!row) throw notFound("user", userId);
  return row.providerLoginOnly === 1;
}

function newKeyRow(userId: string, name: string, issuer: KeyIssuer, scope: KeyScope | null) {
  const key = generateAccessKey();
  const row = {
    id: newId(),
    userId,
    name,
    issuer,
    scope: serializeScope(scope),
    keyHash: hashKey(key),
    createdAt: nowIso(),
    revokedAt: null,
  };
  const created: CreatedKey = { id: row.id, name: row.name, issuer, scope, createdAt: row.createdAt, key };
  return { row, created };
}

/**
 * Every user key is made here or in `rotateKey` (the initial key of a new
 * user aside, see users.ts), behind the same guard: refused where key login is
 * off for the instance or the user. The check and the insert are one
 * transaction, serialised with a change to the flag.
 */
async function insertKey(
  db: Db,
  config: KeyLoginConfig,
  userId: string,
  name: string,
  issuer: KeyIssuer,
  scope: KeyScope | null,
): Promise<CreatedKey> {
  const { accessKeys } = db.tables;
  const { row, created } = newKeyRow(userId, name, issuer, scope);
  return db.transaction(function* (tx) {
    const refused = keyRefusal(config, yield* lockedProviderLoginOnly(tx, db.tables, userId));
    if (refused) throw keyCreationRefused(config, refused);
    yield tx.insert(accessKeys).values(row);
    return created;
  });
}

async function selectKeys(db: Db, userId: string): Promise<AccessKeyInfo[]> {
  const { accessKeys } = db.tables;
  const rows = await db.client
    .select({
      id: accessKeys.id,
      name: accessKeys.name,
      issuer: accessKeys.issuer,
      scope: accessKeys.scope,
      createdAt: accessKeys.createdAt,
    })
    .from(accessKeys)
    .where(and(eq(accessKeys.userId, userId), isNull(accessKeys.revokedAt)))
    .orderBy(asc(accessKeys.createdAt), asc(accessKeys.id));
  return rows.map((row) => ({ ...row, scope: parseStoredScope(row.scope) }));
}

/** Revokes the user's active key and the OAuth grants it authorized; returns
 * its name and scope. */
async function revokeKey(db: Db, userId: string, keyId: string): Promise<{ name: string; scope: KeyScope | null }> {
  const { accessKeys } = db.tables;
  // One statement decides it: a key already revoked (or another user's) matches nothing.
  const revoked = await db.client
    .update(accessKeys)
    .set({ revokedAt: nowIso() })
    .where(and(eq(accessKeys.id, keyId), eq(accessKeys.userId, userId), isNull(accessKeys.revokedAt)))
    .returning({ name: accessKeys.name, scope: accessKeys.scope });
  const existing = revoked[0];
  if (!existing) throw notFound("key", keyId);
  await revokeGrantsForKey(db, keyId);
  return { name: existing.name, scope: parseStoredScope(existing.scope) };
}

// ---- The user's own keys ----------------------------------------------------
// Self-service, so each is gated twice: by the credential's scope (a scoped
// key, or a non-admin token, may not manage credentials) and by the
// operator's `manage_keys` denial.

/** Mints a key for the user, unscoped unless `scope` is given. */
export async function createKey(
  db: Db,
  config: KeyLoginConfig,
  userId: string,
  name = "",
  scope?: unknown,
): Promise<CreatedKey> {
  assertCanManageCredentials();
  const checked = checkKeyScope(scope);
  await requireAccountCapability(db, userId, "manage_keys");
  return insertKey(db, config, userId, name, "user", checked);
}

export async function listKeys(db: Db, userId: string): Promise<AccessKeyInfo[]> {
  assertCanManageCredentials();
  await requireAccountCapability(db, userId, "manage_keys");
  return selectKeys(db, userId);
}

/**
 * Revokes the old key immediately and returns a fresh secret under the same
 * name and scope (a scope never changes, rotation included). Rotating is the
 * user's act, so the new key's issuer is `user` whoever issued the old one.
 * Refused, with the old key left alone, where no key may be made.
 */
export async function rotateKey(db: Db, config: KeyLoginConfig, userId: string, keyId: string): Promise<CreatedKey> {
  assertCanManageCredentials();
  await requireAccountCapability(db, userId, "manage_keys");
  const { accessKeys, oauthCodes, oauthGrants } = db.tables;
  // One transaction: a refused rotation revokes nothing, and one that goes
  // ahead revokes the old key, its grants and makes the new key together.
  return db.transaction(function* (tx) {
    const refused = keyRefusal(config, yield* lockedProviderLoginOnly(tx, db.tables, userId));
    if (refused) throw keyCreationRefused(config, refused);
    const revoked: { name: string; scope: string | null }[] = yield tx
      .update(accessKeys)
      .set({ revokedAt: nowIso() })
      .where(and(eq(accessKeys.id, keyId), eq(accessKeys.userId, userId), isNull(accessKeys.revokedAt)))
      .returning({ name: accessKeys.name, scope: accessKeys.scope });
    const old = revoked[0];
    if (!old) throw notFound("key", keyId);
    yield tx.delete(oauthCodes).where(eq(oauthCodes.keyId, keyId));
    yield tx.delete(oauthGrants).where(eq(oauthGrants.keyId, keyId));
    const { row, created } = newKeyRow(userId, old.name, "user", parseStoredScope(old.scope));
    yield tx.insert(accessKeys).values(row);
    return created;
  });
}

export async function deleteKey(db: Db, userId: string, keyId: string): Promise<void> {
  assertCanManageCredentials();
  await requireAccountCapability(db, userId, "manage_keys");
  await revokeKey(db, userId, keyId);
}

// ---- The sysadmin key lane: any user's keys ----------------------------------
// Operator operations, reached only with the sysadmin key, and independent of
// what the user may do for themself: a `manage_keys` denial does not apply
// here. Key login switched off does apply, for the instance or the user: a key
// made here would only be refused at login. Each names the user
// explicitly and 404s when there is no such user; a key id resolves only under
// the user who holds it.

/** Issues an ordinary key for the user — their full authority, or the given
 * scope of it — theirs to see, rotate and revoke. */
export async function issueKeyForUser(
  db: Db,
  config: KeyLoginConfig,
  userId: string,
  name = "",
  scope?: unknown,
): Promise<CreatedKey> {
  const checked = checkKeyScope(scope);
  await getUser(db, userId);
  return insertKey(db, config, userId, name, "sysadmin", checked);
}

export async function listKeysForUser(db: Db, userId: string): Promise<AccessKeyInfo[]> {
  await getUser(db, userId);
  return selectKeys(db, userId);
}

export async function revokeKeyForUser(db: Db, userId: string, keyId: string): Promise<void> {
  await getUser(db, userId);
  await revokeKey(db, userId, keyId);
}

export interface AuthenticatedKey {
  userId: string;
  /** The key row — the consent screen binds OAuth grants to it. */
  keyId: string;
  /** The key's fixed scope; null for an unscoped key. */
  scope: KeyScope | null;
}

export type KeyAuthentication = ({ ok: true } & AuthenticatedKey) | { ok: false; reason: "invalid" | KeyRefusal };

/**
 * Resolves a presented secret to its key: user, key id and scope. Revoked
 * keys never match. A stored scope this version cannot read fails closed: the
 * key does not authenticate, rather than running unscoped. A key that matches
 * but may not be used (keyLogin.ts) is refused with that reason; with key
 * login off for the instance every key is refused before any lookup, so the
 * answer is the same for a valid key and a made-up one.
 */
export async function authenticateKey(
  db: Db,
  config: KeyLoginConfig,
  presentedKey: string,
): Promise<KeyAuthentication> {
  if (!config.keyLogin) return { ok: false, reason: "key-login-off" };
  const { accessKeys, users } = db.tables;
  const rows = await db.client
    .select({
      userId: accessKeys.userId,
      keyId: accessKeys.id,
      scope: accessKeys.scope,
      providerLoginOnly: users.providerLoginOnly,
    })
    .from(accessKeys)
    .innerJoin(users, eq(accessKeys.userId, users.id))
    .where(and(eq(accessKeys.keyHash, hashKey(presentedKey)), isNull(accessKeys.revokedAt)));
  const row = rows[0];
  if (!row) return { ok: false, reason: "invalid" };
  let scope: KeyScope | null;
  try {
    scope = parseStoredScope(row.scope);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const refused = keyRefusal(config, row.providerLoginOnly === 1);
  if (refused) return { ok: false, reason: refused };
  return { ok: true, userId: row.userId, keyId: row.keyId, scope };
}

/**
 * Whether a key a page logged in with may still be used: there, unrevoked,
 * and not refused by key login switched off (the connections page re-checks
 * it on every disconnect).
 */
export async function keyStillUsable(db: Db, config: KeyLoginConfig, userId: string, keyId: string): Promise<boolean> {
  if (!config.keyLogin) return false;
  const { accessKeys, users } = db.tables;
  const rows = await db.client
    .select({ providerLoginOnly: users.providerLoginOnly })
    .from(accessKeys)
    .innerJoin(users, eq(accessKeys.userId, users.id))
    .where(and(eq(accessKeys.id, keyId), eq(accessKeys.userId, userId), isNull(accessKeys.revokedAt)));
  const row = rows[0];
  return row !== undefined && keyRefusal(config, row.providerLoginOnly === 1) === null;
}

/** Why a page login was refused, so each page can word it for its own reader. */
export type PageLoginRefusal = "missing" | "sysadmin" | "oauth-token" | "scoped-key" | "invalid" | KeyRefusal;

/** The words every page uses for a scoped key. */
export const SCOPED_KEY_LOGIN_REFUSED = "This key is limited. Log in with a full key.";

/**
 * The access-key login a person gives on one of the pages Core serves itself:
 * the OAuth consent screen, the connected-apps page, the secret form and the
 * service approve page. Core has no passwords or sessions, so it is a user
 * access key pasted into the page — or, where the operator configured a login
 * provider, a provider login instead (personLogin.ts puts the two together). Refused: the sysadmin key (an operator credential, not
 * a person), an OAuth token, which an app holds on a person's behalf, and a
 * scoped key, which a machine holds on a person's behalf — exactly what must
 * not be able to stand in for them here. (This is what stops an agent with a
 * scoped admin key from approving the service it wrote.) Also refused: any key
 * where key login is switched off, for the instance or for that user.
 */
export async function pageLogin(
  db: Db,
  config: KeyLoginConfig & { sysadminKey: string },
  presented: string,
): Promise<{ ok: true; userId: string; keyId: string } | { ok: false; reason: PageLoginRefusal }> {
  const key = presented.trim();
  if (!key) return { ok: false, reason: "missing" };
  if (constantTimeEqual(key, config.sysadminKey)) return { ok: false, reason: "sysadmin" };
  if (key.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) return { ok: false, reason: "oauth-token" };
  const row = await authenticateKey(db, config, key);
  if (!row.ok) return { ok: false, reason: row.reason };
  if (row.scope) return { ok: false, reason: "scoped-key" };
  return { ok: true, userId: row.userId, keyId: row.keyId };
}
