/**
 * Bundles: the unit a user authors and stores — docs, item-types, files, and
 * hooks live inside. Creation validates the entire design first and applies
 * it atomically-in-effect: invalid input is rejected with actionable errors,
 * never partially applied.
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import type { BlobStore } from "../blob/index.js";
import type { Db } from "../db/index.js";
import { hasAnyCapability, requireCapability } from "./capabilities.js";
import { invalid, notFound } from "./errors.js";
import type { GrantTarget } from "./grants.js";
import { clampLimit, decodeCursor, toPage, type Page } from "./pagination.js";
import { serializeConfig, validatePropertyConfig, type PropertyConfig } from "./propertyConfig.js";
import { getSpaceRow, toSpaceRef, type Space } from "./spaces.js";
import { newId, nowIso } from "./util.js";

// item → reference to another item in the same bundle (item://<id>);
// file → reference to a finalized file in the same bundle (file://<id>).
export const DATATYPES = ["text", "number", "boolean", "date", "item", "file"] as const;
export type Datatype = (typeof DATATYPES)[number];

export interface PropertyInput {
  name: string;
  datatype: Datatype;
  required?: boolean;
  /** When true the property holds an ordered list of values of `datatype`. */
  multi?: boolean;
  /** Per-datatype constraints (regex, number bounds/decimals, item bounds, …). */
  config?: PropertyConfig;
}

export interface ItemTypeInput {
  name: string;
  properties: PropertyInput[];
}

export interface BundleDocInput {
  name: string;
  content?: string;
  /** When true, load_bundle returns this doc's content automatically. */
  autoload?: boolean;
}

export interface BundleInput {
  name: string;
  description?: string;
  docs?: BundleDocInput[];
  itemTypes?: ItemTypeInput[];
}

export interface Bundle {
  id: string;
  spaceId: string;
  name: string;
  description: string;
  docs: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Validates a bundle design, returning actionable error details. Validation
 * runs in full before any write so nothing is partially applied.
 */
export function validateBundleInput(input: BundleInput): string[] {
  const errors: string[] = [];
  if (!input.name?.trim()) errors.push("bundle name is required");
  const docNames = new Set<string>();
  for (const [i, doc] of (input.docs ?? []).entries()) {
    const docName = doc.name?.trim();
    if (!docName) {
      errors.push(`docs[${i}]: doc name is required`);
    } else if (docNames.has(docName)) {
      errors.push(`docs[${i}]: duplicate doc name "${docName}"`);
    } else {
      docNames.add(docName);
    }
  }
  const typeNames = new Set<string>();
  for (const [i, itemType] of (input.itemTypes ?? []).entries()) {
    const where = `itemTypes[${i}]`;
    const typeName = itemType.name?.trim();
    if (!typeName) {
      errors.push(`${where}: item-type name is required`);
    } else if (typeNames.has(typeName)) {
      errors.push(`${where}: duplicate item-type name "${typeName}"`);
    } else {
      typeNames.add(typeName);
    }
    const propNames = new Set<string>();
    for (const [j, prop] of (itemType.properties ?? []).entries()) {
      const propWhere = `${where}.properties[${j}]`;
      const propName = prop.name?.trim();
      if (!propName) {
        errors.push(`${propWhere}: property name is required`);
      } else if (propNames.has(propName)) {
        errors.push(`${propWhere}: duplicate property name "${propName}"`);
      } else {
        propNames.add(propName);
      }
      if (!DATATYPES.includes(prop.datatype)) {
        errors.push(
          `${propWhere}: invalid datatype ${JSON.stringify(prop.datatype)} (expected one of: ${DATATYPES.join(", ")})`,
        );
      } else {
        for (const err of validatePropertyConfig(prop.datatype, !!prop.multi, prop.config ?? {})) {
          errors.push(`${propWhere}: ${err}`);
        }
      }
    }
  }
  return errors;
}

export async function createBundle(db: Db, userId: string, spaceId: string, input: BundleInput): Promise<Bundle> {
  const space = await getSpaceRow(db, spaceId);
  await requireCapability(db, userId, "create_bundles", { space: toSpaceRef(space) });

  const errors = validateBundleInput(input);
  if (errors.length > 0) {
    throw invalid("invalid bundle design", { errors });
  }

  const name = input.name.trim();
  const { bundles, bundleDocs, itemTypes, properties } = db.tables;
  const clash = await db.client
    .select({ id: bundles.id })
    .from(bundles)
    .where(and(eq(bundles.spaceId, spaceId), eq(bundles.name, name)));
  if (clash.length > 0) throw invalid(`a bundle named "${name}" already exists in this space`);

  const now = nowIso();
  const bundle: Bundle = {
    id: newId(),
    spaceId,
    name,
    description: input.description ?? "",
    docs: "",
    createdAt: now,
    updatedAt: now,
  };
  await db.client.insert(bundles).values(bundle);
  for (const doc of input.docs ?? []) {
    await db.client.insert(bundleDocs).values({
      id: newId(),
      bundleId: bundle.id,
      name: doc.name.trim(),
      content: doc.content ?? "",
      autoload: doc.autoload ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const itemType of input.itemTypes ?? []) {
    const itemTypeId = newId();
    await db.client.insert(itemTypes).values({
      id: itemTypeId,
      bundleId: bundle.id,
      name: itemType.name.trim(),
      createdAt: now,
    });
    if (itemType.properties.length > 0) {
      await db.client.insert(properties).values(
        itemType.properties.map((prop, order) => ({
          id: newId(),
          itemTypeId,
          name: prop.name.trim(),
          datatype: prop.datatype,
          required: prop.required ? 1 : 0,
          multi: prop.multi ? 1 : 0,
          config: serializeConfig(prop.config),
          sortOrder: order,
        })),
      );
    }
  }
  return bundle;
}

export async function getBundleRow(db: Db, bundleId: string): Promise<Bundle> {
  const { bundles } = db.tables;
  const rows = await db.client.select().from(bundles).where(eq(bundles.id, bundleId));
  if (rows.length === 0) throw notFound("bundle", bundleId);
  return rows[0]!;
}

export interface BundleContext {
  bundle: Bundle;
  space: Space;
}

/** Loads a bundle plus its space — the standard capability-check context. */
export async function getBundleContext(db: Db, bundleId: string): Promise<BundleContext> {
  const bundle = await getBundleRow(db, bundleId);
  const space = await getSpaceRow(db, bundle.spaceId);
  return { bundle, space };
}

/** Capability context for a check on this bundle (bundle overrides space). */
export function bundleCapabilityCtx(ctx: BundleContext): { space: ReturnType<typeof toSpaceRef>; bundleId: string } {
  return { space: toSpaceRef(ctx.space), bundleId: ctx.bundle.id };
}

/** Grant target for bundle-level grants. */
export async function bundleGrantTarget(db: Db, bundleId: string): Promise<GrantTarget> {
  const { bundle, space } = await getBundleContext(db, bundleId);
  return { type: "bundle", id: bundle.id, space };
}

/** Requires "bundle read access": at least one effective capability. */
export async function requireBundleReadAccess(db: Db, userId: string, ctx: BundleContext): Promise<void> {
  if (!(await hasAnyCapability(db, userId, bundleCapabilityCtx(ctx)))) {
    throw notFound("bundle", ctx.bundle.id);
  }
}

/** Lists bundles in a space the user can see (any effective capability). */
export async function listBundles(
  db: Db,
  userId: string,
  spaceId: string,
  opts: { cursor?: string; limit?: string | number } = {},
): Promise<Page<Bundle>> {
  const space = await getSpaceRow(db, spaceId);
  const { bundles } = db.tables;
  const limit = clampLimit(opts.limit);
  const offset = decodeCursor(opts.cursor);
  const rows = await db.client
    .select()
    .from(bundles)
    .where(eq(bundles.spaceId, spaceId))
    .orderBy(asc(bundles.createdAt), asc(bundles.id));
  const visible: Bundle[] = [];
  for (const bundle of rows) {
    if (await hasAnyCapability(db, userId, { space: toSpaceRef(space), bundleId: bundle.id })) {
      visible.push(bundle);
    }
  }
  return toPage(visible.slice(offset, offset + limit + 1), offset, limit);
}

export async function updateBundle(
  db: Db,
  userId: string,
  bundleId: string,
  patch: { name?: string; description?: string },
): Promise<Bundle> {
  const ctx = await getBundleContext(db, bundleId);
  // Invisible to users with no access at all (404, like GET); holders of some
  // access but not edit_bundles get an explicit 403 with the deciding row.
  await requireBundleReadAccess(db, userId, ctx);
  await requireCapability(db, userId, "edit_bundles", bundleCapabilityCtx(ctx));
  const { bundles } = db.tables;
  const name = patch.name !== undefined ? patch.name.trim() : undefined;
  if (name !== undefined) {
    if (!name) throw invalid("bundle name cannot be empty");
    const clash = await db.client
      .select({ id: bundles.id })
      .from(bundles)
      .where(and(eq(bundles.spaceId, ctx.bundle.spaceId), eq(bundles.name, name)));
    if (clash.some((r) => r.id !== bundleId)) {
      throw invalid(`a bundle named "${name}" already exists in this space`);
    }
  }
  await db.client
    .update(bundles)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(bundles.id, bundleId));
  return getBundleRow(db, bundleId);
}

export async function deleteBundle(db: Db, userId: string, bundleId: string, blob: BlobStore): Promise<void> {
  const ctx = await getBundleContext(db, bundleId);
  await requireBundleReadAccess(db, userId, ctx);
  await requireCapability(db, userId, "edit_bundles", bundleCapabilityCtx(ctx));
  const { bundles, grants, files } = db.tables;
  // Capture blob keys before the file rows cascade away (FK), then delete the
  // bytes — "deleting a file record deletes the underlying blob immediately"
  // applies to cascade deletions too, not just the single-file path.
  const fileRows = await db.client.select({ storageKey: files.storageKey }).from(files).where(eq(files.bundleId, bundleId));
  await db.client.delete(bundles).where(eq(bundles.id, bundleId));
  for (const row of fileRows) await blob.delete(row.storageKey);
  // Grant rows have no FK to resources; clean up bundle-level rows explicitly.
  await db.client
    .delete(grants)
    .where(and(eq(grants.resourceType, "bundle"), eq(grants.resourceId, bundleId)));
}

/** Resolves an item-type within a bundle by id or name. */
export async function resolveItemType(
  db: Db,
  bundleId: string,
  itemTypeRef: string,
): Promise<{ id: string; bundleId: string; name: string; createdAt: string }> {
  const { itemTypes } = db.tables;
  const rows = await db.client
    .select()
    .from(itemTypes)
    .where(and(eq(itemTypes.bundleId, bundleId), eq(itemTypes.id, itemTypeRef)));
  if (rows.length > 0) return rows[0]!;
  const byName = await db.client
    .select()
    .from(itemTypes)
    .where(and(eq(itemTypes.bundleId, bundleId), eq(itemTypes.name, itemTypeRef)));
  if (byName.length === 0) throw notFound("item-type", itemTypeRef);
  return byName[0]!;
}
