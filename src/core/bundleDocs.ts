/**
 * Bundle docs: named markdown documents inside a bundle — its operating
 * instructions and skills. load_bundle returns docs flagged autoload in full
 * and lists the rest; read_docs fetches content on demand. Reads require
 * bundle read access; writes require edit_docs.
 */
import { and, asc, eq, inArray, or } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { bundleCapabilityCtx, getBundleContext, requireBundleReadAccess } from "./bundles.js";
import { requireCapability } from "./capabilities.js";
import { invalid, notFound } from "./errors.js";
import { newId, nowIso } from "./util.js";

export interface BundleDocInfo {
  id: string;
  name: string;
  autoload: number;
  createdAt: string;
  updatedAt: string;
}

export interface BundleDoc extends BundleDocInfo {
  content: string;
}

type DocRow = BundleDoc & { bundleId: string };

const toDoc = ({ bundleId: _omit, ...doc }: DocRow): BundleDoc => doc;
const toInfo = ({ bundleId: _omit, content: _c, ...info }: DocRow): BundleDocInfo => info;

/** All docs in a bundle, no capability check — for callers that have already
 * established bundle read access (load_bundle, bundle GET). */
export async function listDocsUnchecked(db: Db, bundleId: string): Promise<DocRow[]> {
  const { bundleDocs } = db.tables;
  return db.client
    .select()
    .from(bundleDocs)
    .where(eq(bundleDocs.bundleId, bundleId))
    .orderBy(asc(bundleDocs.createdAt), asc(bundleDocs.id));
}

export async function listDocs(db: Db, userId: string, bundleId: string): Promise<BundleDocInfo[]> {
  const ctx = await getBundleContext(db, bundleId);
  await requireBundleReadAccess(db, userId, ctx);
  return (await listDocsUnchecked(db, bundleId)).map(toInfo);
}

/** Full content. With refs (ids or names), exactly those docs — missing refs
 * are an error; without refs, every doc in the bundle. */
export async function readDocs(db: Db, userId: string, bundleId: string, refs?: string[]): Promise<BundleDoc[]> {
  const ctx = await getBundleContext(db, bundleId);
  await requireBundleReadAccess(db, userId, ctx);
  if (refs === undefined || refs.length === 0) {
    return (await listDocsUnchecked(db, bundleId)).map(toDoc);
  }
  const { bundleDocs } = db.tables;
  const rows = await db.client
    .select()
    .from(bundleDocs)
    .where(and(eq(bundleDocs.bundleId, bundleId), or(inArray(bundleDocs.id, refs), inArray(bundleDocs.name, refs))));
  const found = new Set(rows.flatMap((r) => [r.id, r.name]));
  const missing = refs.filter((ref) => !found.has(ref));
  if (missing.length > 0) throw notFound("doc", missing.join(", "));
  return rows.map(toDoc);
}

/** Resolves a doc within a bundle by id or name. */
async function resolveDoc(db: Db, bundleId: string, ref: string): Promise<DocRow> {
  const { bundleDocs } = db.tables;
  const byId = await db.client
    .select()
    .from(bundleDocs)
    .where(and(eq(bundleDocs.bundleId, bundleId), eq(bundleDocs.id, ref)));
  if (byId.length > 0) return byId[0]!;
  const byName = await db.client
    .select()
    .from(bundleDocs)
    .where(and(eq(bundleDocs.bundleId, bundleId), eq(bundleDocs.name, ref)));
  if (byName.length === 0) throw notFound("doc", ref);
  return byName[0]!;
}

export async function getDoc(db: Db, userId: string, bundleId: string, ref: string): Promise<BundleDoc> {
  const ctx = await getBundleContext(db, bundleId);
  await requireBundleReadAccess(db, userId, ctx);
  return toDoc(await resolveDoc(db, bundleId, ref));
}

async function requireNameFree(db: Db, bundleId: string, name: string, exceptId?: string): Promise<void> {
  const { bundleDocs } = db.tables;
  const clash = await db.client
    .select({ id: bundleDocs.id })
    .from(bundleDocs)
    .where(and(eq(bundleDocs.bundleId, bundleId), eq(bundleDocs.name, name)));
  if (clash.some((r) => r.id !== exceptId)) {
    throw invalid(`a doc named "${name}" already exists in this bundle`);
  }
}

export async function createDoc(
  db: Db,
  userId: string,
  bundleId: string,
  input: { name: string; content?: string; autoload?: boolean },
): Promise<BundleDoc> {
  const ctx = await getBundleContext(db, bundleId);
  await requireCapability(db, userId, "edit_docs", bundleCapabilityCtx(ctx));
  const name = input.name?.trim();
  if (!name) throw invalid("doc name is required");
  await requireNameFree(db, bundleId, name);
  const now = nowIso();
  const row = {
    id: newId(),
    bundleId,
    name,
    content: input.content ?? "",
    autoload: input.autoload ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  };
  const { bundleDocs } = db.tables;
  await db.client.insert(bundleDocs).values(row);
  return toDoc(row);
}

export async function updateDoc(
  db: Db,
  userId: string,
  bundleId: string,
  ref: string,
  patch: { name?: string; content?: string; autoload?: boolean },
): Promise<BundleDoc> {
  const ctx = await getBundleContext(db, bundleId);
  await requireCapability(db, userId, "edit_docs", bundleCapabilityCtx(ctx));
  const doc = await resolveDoc(db, bundleId, ref);
  const name = patch.name?.trim();
  if (patch.name !== undefined) {
    if (!name) throw invalid("doc name cannot be empty");
    await requireNameFree(db, bundleId, name, doc.id);
  }
  const { bundleDocs } = db.tables;
  await db.client
    .update(bundleDocs)
    .set({
      ...(patch.name !== undefined ? { name } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.autoload !== undefined ? { autoload: patch.autoload ? 1 : 0 } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(bundleDocs.id, doc.id));
  return toDoc(await resolveDoc(db, bundleId, doc.id));
}

export async function deleteDoc(db: Db, userId: string, bundleId: string, ref: string): Promise<void> {
  const ctx = await getBundleContext(db, bundleId);
  await requireCapability(db, userId, "edit_docs", bundleCapabilityCtx(ctx));
  const doc = await resolveDoc(db, bundleId, ref);
  const { bundleDocs } = db.tables;
  await db.client.delete(bundleDocs).where(eq(bundleDocs.id, doc.id));
}
