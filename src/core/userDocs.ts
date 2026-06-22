/**
 * User docs: the one user-scoped content type. They attach to a user account
 * (not a space or bundle), travel with the user across all their spaces, and
 * are strictly personal — no roles, no sharing, no capability grants. A doc
 * flagged autoload is surfaced by `load` at the start of every session.
 */
import { and, asc, eq, inArray, or } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { assertAccountWrite } from "./authScope.js";
import { invalid, notFound } from "./errors.js";
import { applyEdits, type EditOp } from "./textEdits.js";
import { newId, nowIso } from "./util.js";

export interface UserDocInfo {
  id: string;
  name: string;
  autoload: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserDoc extends UserDocInfo {
  content: string;
}

export async function createUserDoc(
  db: Db,
  userId: string,
  input: { name: string; content?: string; autoload?: boolean },
): Promise<UserDoc> {
  assertAccountWrite();
  const name = input.name?.trim();
  if (!name) throw invalid("user doc name is required");
  const { userDocs } = db.tables;
  const existing = await db.client
    .select({ id: userDocs.id })
    .from(userDocs)
    .where(and(eq(userDocs.userId, userId), eq(userDocs.name, name)));
  if (existing.length > 0) throw invalid(`a user doc named "${name}" already exists`);
  const now = nowIso();
  const row = {
    id: newId(),
    userId,
    name,
    content: input.content ?? "",
    autoload: input.autoload ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  };
  await db.client.insert(userDocs).values(row);
  const { userId: _omit, ...doc } = row;
  return doc;
}

export async function listUserDocs(db: Db, userId: string): Promise<UserDocInfo[]> {
  const { userDocs } = db.tables;
  return db.client
    .select({
      id: userDocs.id,
      name: userDocs.name,
      autoload: userDocs.autoload,
      createdAt: userDocs.createdAt,
      updatedAt: userDocs.updatedAt,
    })
    .from(userDocs)
    .where(eq(userDocs.userId, userId))
    .orderBy(asc(userDocs.createdAt), asc(userDocs.id));
}

/** Full content of specific docs, referenced by id or name. */
export async function loadUserDocs(db: Db, userId: string, refs: string[]): Promise<UserDoc[]> {
  if (!Array.isArray(refs) || refs.length === 0) throw invalid("pass at least one user doc id or name");
  const { userDocs } = db.tables;
  const rows = await db.client
    .select()
    .from(userDocs)
    .where(and(eq(userDocs.userId, userId), or(inArray(userDocs.id, refs), inArray(userDocs.name, refs))));
  const found = new Set(rows.flatMap((r) => [r.id, r.name]));
  const missing = refs.filter((ref) => !found.has(ref));
  if (missing.length > 0) throw notFound("user doc", missing.join(", "));
  return rows.map(({ userId: _omit, ...doc }) => doc);
}

export async function getUserDoc(db: Db, userId: string, docId: string): Promise<UserDoc> {
  const { userDocs } = db.tables;
  const rows = await db.client
    .select()
    .from(userDocs)
    .where(and(eq(userDocs.userId, userId), eq(userDocs.id, docId)));
  if (rows.length === 0) throw notFound("user doc", docId);
  const { userId: _omit, ...doc } = rows[0]!;
  return doc;
}

export async function updateUserDoc(
  db: Db,
  userId: string,
  docId: string,
  patch: { name?: string; content?: string; autoload?: boolean },
): Promise<UserDoc> {
  assertAccountWrite();
  await getUserDoc(db, userId, docId);
  const name = patch.name !== undefined ? patch.name.trim() : undefined;
  if (name !== undefined && !name) throw invalid("user doc name cannot be empty");
  const { userDocs } = db.tables;
  if (name !== undefined) {
    const clash = await db.client
      .select({ id: userDocs.id })
      .from(userDocs)
      .where(and(eq(userDocs.userId, userId), eq(userDocs.name, name)));
    if (clash.some((r) => r.id !== docId)) throw invalid(`a user doc named "${name}" already exists`);
  }
  await db.client
    .update(userDocs)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.autoload !== undefined ? { autoload: patch.autoload ? 1 : 0 } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(userDocs.id, docId));
  return getUserDoc(db, userId, docId);
}

export async function patchUserDoc(db: Db, userId: string, docId: string, ops: EditOp[]): Promise<UserDoc> {
  assertAccountWrite();
  const doc = await getUserDoc(db, userId, docId);
  const content = applyEdits(doc.content, ops);
  const { userDocs } = db.tables;
  await db.client.update(userDocs).set({ content, updatedAt: nowIso() }).where(eq(userDocs.id, docId));
  return getUserDoc(db, userId, docId);
}

export async function deleteUserDoc(db: Db, userId: string, docId: string): Promise<void> {
  assertAccountWrite();
  await getUserDoc(db, userId, docId);
  const { userDocs } = db.tables;
  await db.client.delete(userDocs).where(eq(userDocs.id, docId));
}

/** Docs flagged to autoload at session start (surfaced by `load`). */
export async function autoloadedUserDocs(db: Db, userId: string): Promise<UserDoc[]> {
  const { userDocs } = db.tables;
  const rows = await db.client
    .select()
    .from(userDocs)
    .where(and(eq(userDocs.userId, userId), eq(userDocs.autoload, 1)))
    .orderBy(asc(userDocs.createdAt), asc(userDocs.id));
  return rows.map(({ userId: _omit, ...doc }) => doc);
}
