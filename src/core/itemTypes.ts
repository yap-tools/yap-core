/**
 * Item-type / property (schema) authoring. A schema is a set of property
 * rows, which is what makes it freely mutable after items exist: rename =
 * update one row, add = insert one, remove = delete the row (value rows
 * cascade-delete immediately). Schema authoring is REST-first and gated by
 * edit_bundles — edit_items does not imply schema-editing rights.
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import type { Db } from "../db/index.js";
import {
  DATATYPES,
  bundleCapabilityCtx,
  getBundleContext,
  requireBundleReadAccess,
  type Datatype,
  type PropertyInput,
} from "./bundles.js";
import { requireCapability } from "./capabilities.js";
import { invalid, notFound } from "./errors.js";
import { newId, nowIso } from "./util.js";

export interface Property {
  id: string;
  itemTypeId: string;
  name: string;
  datatype: string;
  required: number;
  sortOrder: number;
}

export interface ItemTypeWithProperties {
  id: string;
  bundleId: string;
  name: string;
  createdAt: string;
  properties: Property[];
}

export async function listItemTypes(db: Db, userId: string, bundleId: string): Promise<ItemTypeWithProperties[]> {
  const ctx = await getBundleContext(db, bundleId);
  await requireBundleReadAccess(db, userId, ctx);
  return listItemTypesUnchecked(db, bundleId);
}

/** Internal: no capability check — for callers that already gated access. */
export async function listItemTypesUnchecked(db: Db, bundleId: string): Promise<ItemTypeWithProperties[]> {
  const { itemTypes, properties } = db.tables;
  const types = await db.client
    .select()
    .from(itemTypes)
    .where(eq(itemTypes.bundleId, bundleId))
    .orderBy(asc(itemTypes.createdAt), asc(itemTypes.id));
  if (types.length === 0) return [];
  const props = await db.client
    .select()
    .from(properties)
    .where(inArray(properties.itemTypeId, types.map((t) => t.id)))
    .orderBy(asc(properties.sortOrder), asc(properties.id));
  return types.map((t) => ({ ...t, properties: props.filter((p) => p.itemTypeId === t.id) }));
}

export async function createItemType(
  db: Db,
  userId: string,
  bundleId: string,
  input: { name: string; properties?: PropertyInput[] },
): Promise<ItemTypeWithProperties> {
  const ctx = await getBundleContext(db, bundleId);
  await requireCapability(db, userId, "edit_bundles", bundleCapabilityCtx(ctx));
  const name = input.name?.trim();
  if (!name) throw invalid("item-type name is required");
  const { itemTypes, properties } = db.tables;
  const existing = await db.client
    .select({ id: itemTypes.id })
    .from(itemTypes)
    .where(and(eq(itemTypes.bundleId, bundleId), eq(itemTypes.name, name)));
  if (existing.length > 0) throw invalid(`item-type "${name}" already exists in this bundle`);

  const propInputs = input.properties ?? [];
  const seen = new Set<string>();
  for (const prop of propInputs) {
    if (!prop.name?.trim()) throw invalid("property name is required");
    if (seen.has(prop.name.trim())) throw invalid(`duplicate property name "${prop.name.trim()}"`);
    seen.add(prop.name.trim());
    if (!DATATYPES.includes(prop.datatype)) {
      throw invalid(`invalid datatype ${JSON.stringify(prop.datatype)} for property "${prop.name}"`);
    }
  }

  const id = newId();
  await db.client.insert(itemTypes).values({ id, bundleId, name, createdAt: nowIso() });
  if (propInputs.length > 0) {
    await db.client.insert(properties).values(
      propInputs.map((prop, order) => ({
        id: newId(),
        itemTypeId: id,
        name: prop.name.trim(),
        datatype: prop.datatype,
        required: prop.required ? 1 : 0,
        sortOrder: order,
      })),
    );
  }
  const all = await listItemTypesUnchecked(db, bundleId);
  return all.find((t) => t.id === id)!;
}

async function getItemTypeContext(db: Db, itemTypeId: string) {
  const { itemTypes } = db.tables;
  const rows = await db.client.select().from(itemTypes).where(eq(itemTypes.id, itemTypeId));
  if (rows.length === 0) throw notFound("item-type", itemTypeId);
  const itemType = rows[0]!;
  const ctx = await getBundleContext(db, itemType.bundleId);
  return { itemType, ctx };
}

/** Rename: updates one row; stored values are untouched by construction. */
export async function updateItemType(
  db: Db,
  userId: string,
  itemTypeId: string,
  patch: { name?: string },
): Promise<void> {
  const { itemType, ctx } = await getItemTypeContext(db, itemTypeId);
  await requireCapability(db, userId, "edit_bundles", bundleCapabilityCtx(ctx));
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw invalid("item-type name cannot be empty");
    const { itemTypes } = db.tables;
    const clash = await db.client
      .select({ id: itemTypes.id })
      .from(itemTypes)
      .where(and(eq(itemTypes.bundleId, itemType.bundleId), eq(itemTypes.name, name)));
    if (clash.some((r) => r.id !== itemTypeId)) throw invalid(`item-type "${name}" already exists in this bundle`);
    await db.client.update(itemTypes).set({ name }).where(eq(itemTypes.id, itemTypeId));
  }
}

/** Deletes the schema and (via FK cascade) its properties, items, and values. */
export async function deleteItemType(db: Db, userId: string, itemTypeId: string): Promise<void> {
  const { ctx } = await getItemTypeContext(db, itemTypeId);
  await requireCapability(db, userId, "edit_bundles", bundleCapabilityCtx(ctx));
  const { itemTypes } = db.tables;
  await db.client.delete(itemTypes).where(eq(itemTypes.id, itemTypeId));
}

/**
 * Adds a property row. Existing items simply have no value row for it; a
 * required flag does not retroactively invalidate existing items.
 */
export async function addProperty(
  db: Db,
  userId: string,
  itemTypeId: string,
  input: { name: string; datatype: Datatype; required?: boolean },
): Promise<Property> {
  const { ctx } = await getItemTypeContext(db, itemTypeId);
  await requireCapability(db, userId, "edit_bundles", bundleCapabilityCtx(ctx));
  const name = input.name?.trim();
  if (!name) throw invalid("property name is required");
  if (!DATATYPES.includes(input.datatype)) throw invalid(`invalid datatype ${JSON.stringify(input.datatype)}`);
  const { properties } = db.tables;
  const siblings = await db.client.select().from(properties).where(eq(properties.itemTypeId, itemTypeId));
  if (siblings.some((p) => p.name === name)) throw invalid(`property "${name}" already exists on this item-type`);
  const row: Property = {
    id: newId(),
    itemTypeId,
    name,
    datatype: input.datatype,
    required: input.required ? 1 : 0,
    sortOrder: siblings.reduce((max, p) => Math.max(max, p.sortOrder), -1) + 1,
  };
  await db.client.insert(properties).values(row);
  return row;
}

/** Rename / re-flag a property: updates the one row; value rows point at the id. */
export async function updateProperty(
  db: Db,
  userId: string,
  itemTypeId: string,
  propertyId: string,
  patch: { name?: string; required?: boolean; sortOrder?: number },
): Promise<Property> {
  const { ctx } = await getItemTypeContext(db, itemTypeId);
  await requireCapability(db, userId, "edit_bundles", bundleCapabilityCtx(ctx));
  const { properties } = db.tables;
  const rows = await db.client
    .select()
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.itemTypeId, itemTypeId)));
  if (rows.length === 0) throw notFound("property", propertyId);
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw invalid("property name cannot be empty");
    const siblings = await db.client.select().from(properties).where(eq(properties.itemTypeId, itemTypeId));
    if (siblings.some((p) => p.name === name && p.id !== propertyId)) {
      throw invalid(`property "${name}" already exists on this item-type`);
    }
  }
  await db.client
    .update(properties)
    .set({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.required !== undefined ? { required: patch.required ? 1 : 0 } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
    })
    .where(eq(properties.id, propertyId));
  const updated = await db.client.select().from(properties).where(eq(properties.id, propertyId));
  return updated[0]!;
}

/** Deletes the property row; its value rows cascade-delete immediately. */
export async function deleteProperty(db: Db, userId: string, itemTypeId: string, propertyId: string): Promise<void> {
  const { ctx } = await getItemTypeContext(db, itemTypeId);
  await requireCapability(db, userId, "edit_bundles", bundleCapabilityCtx(ctx));
  const { properties } = db.tables;
  const rows = await db.client
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.itemTypeId, itemTypeId)));
  if (rows.length === 0) throw notFound("property", propertyId);
  await db.client.delete(properties).where(eq(properties.id, propertyId));
}
