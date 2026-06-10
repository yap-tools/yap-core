/**
 * User provisioning (sysadmin-key REST operations). Every user receives a
 * personal space at provisioning — undeletable, unrenamable, unshareable —
 * and an initial access key whose secret is returned exactly once.
 */
import { asc, eq } from "drizzle-orm";

import { generateAccessKey, hashKey } from "../crypto.js";
import type { Db } from "../db/index.js";
import { invalid, notFound } from "./errors.js";
import { clampLimit, decodeCursor, toPage, type Page } from "./pagination.js";
import { newId, nowIso } from "./util.js";

export interface User {
  id: string;
  name: string;
  createdAt: string;
}

export interface CreatedUser {
  user: User;
  personalSpaceId: string;
  /** Secret access key — shown once, stored only as a hash. */
  initialKey: { id: string; name: string; key: string };
}

export async function createUser(db: Db, input: { name: string }): Promise<CreatedUser> {
  const name = input.name?.trim();
  if (!name) throw invalid("user name is required");
  const { users, spaces, accessKeys } = db.tables;
  const now = nowIso();
  const user: User = { id: newId(), name, createdAt: now };
  await db.client.insert(users).values(user);

  const personalSpaceId = newId();
  await db.client.insert(spaces).values({
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
  await db.client.insert(accessKeys).values({
    id: keyId,
    userId: user.id,
    name: "default",
    keyHash: hashKey(key),
    createdAt: now,
    revokedAt: null,
  });

  return { user, personalSpaceId, initialKey: { id: keyId, name: "default", key } };
}

export async function listUsers(db: Db, opts: { cursor?: string; limit?: string | number } = {}): Promise<Page<User>> {
  const { users } = db.tables;
  const limit = clampLimit(opts.limit);
  const offset = decodeCursor(opts.cursor);
  const rows = await db.client
    .select()
    .from(users)
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

/**
 * Deletes the user; FK cascades remove their keys, grants, user docs, owned
 * spaces and everything inside them. (Blob bytes belonging to cascaded file
 * records are not swept here — operator-level cleanup; the brief's immediate
 * blob deletion applies to the file-delete operation.)
 */
export async function deleteUser(db: Db, userId: string): Promise<void> {
  const { users } = db.tables;
  await getUser(db, userId);
  await db.client.delete(users).where(eq(users.id, userId));
}
