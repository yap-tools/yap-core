/**
 * Access keys: identity-only credentials. A key proves who is making a
 * request — it carries no permissions. Users may hold multiple active keys;
 * rotation revokes the old key immediately, with no grace period.
 */
import { and, asc, eq, isNull } from "drizzle-orm";

import { generateAccessKey, hashKey } from "../crypto.js";
import type { Db } from "../db/index.js";
import { assertCanManageCredentials } from "./authScope.js";
import { notFound } from "./errors.js";
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

export interface AccessKeyInfo {
  id: string;
  name: string;
  issuer: KeyIssuer;
  createdAt: string;
}

export interface CreatedKey extends AccessKeyInfo {
  /** Secret — shown once. */
  key: string;
}

async function insertKey(db: Db, userId: string, name: string, issuer: KeyIssuer): Promise<CreatedKey> {
  const { accessKeys } = db.tables;
  const key = generateAccessKey();
  const row = {
    id: newId(),
    userId,
    name,
    issuer,
    keyHash: hashKey(key),
    createdAt: nowIso(),
    revokedAt: null,
  };
  await db.client.insert(accessKeys).values(row);
  return { id: row.id, name: row.name, issuer, createdAt: row.createdAt, key };
}

async function selectKeys(db: Db, userId: string): Promise<AccessKeyInfo[]> {
  const { accessKeys } = db.tables;
  return db.client
    .select({
      id: accessKeys.id,
      name: accessKeys.name,
      issuer: accessKeys.issuer,
      createdAt: accessKeys.createdAt,
    })
    .from(accessKeys)
    .where(and(eq(accessKeys.userId, userId), isNull(accessKeys.revokedAt)))
    .orderBy(asc(accessKeys.createdAt), asc(accessKeys.id));
}

/** Revokes the user's active key and the OAuth grants it authorized; returns its name. */
async function revokeKey(db: Db, userId: string, keyId: string): Promise<string> {
  const { accessKeys } = db.tables;
  // One statement decides it: a key already revoked (or another user's) matches nothing.
  const revoked = await db.client
    .update(accessKeys)
    .set({ revokedAt: nowIso() })
    .where(and(eq(accessKeys.id, keyId), eq(accessKeys.userId, userId), isNull(accessKeys.revokedAt)))
    .returning({ name: accessKeys.name });
  const existing = revoked[0];
  if (!existing) throw notFound("key", keyId);
  await revokeGrantsForKey(db, keyId);
  return existing.name;
}

// ---- The user's own keys ----------------------------------------------------

export async function createKey(db: Db, userId: string, name = ""): Promise<CreatedKey> {
  assertCanManageCredentials();
  return insertKey(db, userId, name, "user");
}

export async function listKeys(db: Db, userId: string): Promise<AccessKeyInfo[]> {
  assertCanManageCredentials();
  return selectKeys(db, userId);
}

/**
 * Revokes the old key immediately and returns a fresh secret under the same
 * name. Rotating is the user's act, so the new key's issuer is `user` whoever
 * issued the old one.
 */
export async function rotateKey(db: Db, userId: string, keyId: string): Promise<CreatedKey> {
  assertCanManageCredentials();
  const name = await revokeKey(db, userId, keyId);
  return insertKey(db, userId, name, "user");
}

export async function deleteKey(db: Db, userId: string, keyId: string): Promise<void> {
  assertCanManageCredentials();
  await revokeKey(db, userId, keyId);
}

// ---- The sysadmin key lane: any user's keys ----------------------------------
// Operator operations, reached only with the sysadmin key. Each names the user
// explicitly and 404s when there is no such user; a key id resolves only under
// the user who holds it.

/** Issues an ordinary key for the user — full authority as them, and theirs to see. */
export async function issueKeyForUser(db: Db, userId: string, name = ""): Promise<CreatedKey> {
  await getUser(db, userId);
  return insertKey(db, userId, name, "sysadmin");
}

export async function listKeysForUser(db: Db, userId: string): Promise<AccessKeyInfo[]> {
  await getUser(db, userId);
  return selectKeys(db, userId);
}

export async function revokeKeyForUser(db: Db, userId: string, keyId: string): Promise<void> {
  await getUser(db, userId);
  await revokeKey(db, userId, keyId);
}

/** Resolves a presented secret to a user id, or null. Revoked keys never match. */
export async function authenticateKey(db: Db, presentedKey: string): Promise<string | null> {
  return (await authenticateKeyRow(db, presentedKey))?.userId ?? null;
}

/** Like authenticateKey but also identifies the key row — the consent screen
 * binds OAuth grants to the specific key that authorized them. */
export async function authenticateKeyRow(
  db: Db,
  presentedKey: string,
): Promise<{ userId: string; keyId: string } | null> {
  const { accessKeys } = db.tables;
  const rows = await db.client
    .select({ userId: accessKeys.userId, keyId: accessKeys.id })
    .from(accessKeys)
    .where(and(eq(accessKeys.keyHash, hashKey(presentedKey)), isNull(accessKeys.revokedAt)));
  return rows[0] ?? null;
}
