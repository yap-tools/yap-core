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
import { newId, nowIso } from "./util.js";

export interface AccessKeyInfo {
  id: string;
  name: string;
  createdAt: string;
}

export interface CreatedKey extends AccessKeyInfo {
  /** Secret — shown once. */
  key: string;
}

export async function createKey(db: Db, userId: string, name = ""): Promise<CreatedKey> {
  assertCanManageCredentials();
  const { accessKeys } = db.tables;
  const key = generateAccessKey();
  const row = {
    id: newId(),
    userId,
    name,
    keyHash: hashKey(key),
    createdAt: nowIso(),
    revokedAt: null,
  };
  await db.client.insert(accessKeys).values(row);
  return { id: row.id, name: row.name, createdAt: row.createdAt, key };
}

export async function listKeys(db: Db, userId: string): Promise<AccessKeyInfo[]> {
  assertCanManageCredentials();
  const { accessKeys } = db.tables;
  const rows = await db.client
    .select({ id: accessKeys.id, name: accessKeys.name, createdAt: accessKeys.createdAt })
    .from(accessKeys)
    .where(and(eq(accessKeys.userId, userId), isNull(accessKeys.revokedAt)))
    .orderBy(asc(accessKeys.createdAt), asc(accessKeys.id));
  return rows;
}

/** Revokes the old key immediately and returns a fresh secret under the same name. */
export async function rotateKey(db: Db, userId: string, keyId: string): Promise<CreatedKey> {
  assertCanManageCredentials();
  const { accessKeys } = db.tables;
  const rows = await db.client
    .select()
    .from(accessKeys)
    .where(and(eq(accessKeys.id, keyId), eq(accessKeys.userId, userId), isNull(accessKeys.revokedAt)));
  const existing = rows[0];
  if (!existing) throw notFound("key", keyId);
  await db.client.update(accessKeys).set({ revokedAt: nowIso() }).where(eq(accessKeys.id, keyId));
  await revokeGrantsForKey(db, keyId);
  return createKey(db, userId, existing.name);
}

export async function deleteKey(db: Db, userId: string, keyId: string): Promise<void> {
  assertCanManageCredentials();
  const { accessKeys } = db.tables;
  const rows = await db.client
    .select({ id: accessKeys.id })
    .from(accessKeys)
    .where(and(eq(accessKeys.id, keyId), eq(accessKeys.userId, userId), isNull(accessKeys.revokedAt)));
  if (rows.length === 0) throw notFound("key", keyId);
  await db.client.update(accessKeys).set({ revokedAt: nowIso() }).where(eq(accessKeys.id, keyId));
  await revokeGrantsForKey(db, keyId);
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
