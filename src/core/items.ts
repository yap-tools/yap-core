/**
 * The EAV item layer. Items are entity rows; each populated property is a
 * value row holding text. The property's declared datatype is enforced by
 * write-time validation and cast on read — including for filtering, where
 * comparisons respect the datatype (numeric for number properties via SQL
 * CAST, lexicographic for text/date/boolean).
 *
 * Query shape: one EXISTS subquery over value rows per filter (AND-combined),
 * a correlated subquery for sorting, offset-backed opaque cursors. The
 * (property_id, value) index serves the common filter path. Everything stays
 * within the SQLite∩Postgres SQL subset.
 */
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/index.js";
import {
  bundleCapabilityCtx,
  getBundleContext,
  resolveItemType,
  type BundleContext,
} from "./bundles.js";
import { requireCapability } from "./capabilities.js";
import { invalid, notFound } from "./errors.js";
import type { Property } from "./itemTypes.js";
import { clampLimit, decodeCursor, toPage, type Page } from "./pagination.js";
import { newId, nowIso } from "./util.js";

export const FILTER_OPS = ["eq", "neq", "contains", "gt", "gte", "lt", "lte", "in"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface ItemFilter {
  property: string;
  op: FilterOp;
  value: unknown;
}

export interface ItemSort {
  property: string;
  direction?: "asc" | "desc";
}

export interface ItemQuery {
  itemType: string;
  filters?: ItemFilter[];
  sort?: ItemSort;
  cursor?: string;
  limit?: string | number;
}

export interface MaterializedItem {
  id: string;
  itemType: string;
  createdAt: string;
  updatedAt: string;
  values: Record<string, unknown>;
}

// ---- Datatype handling ------------------------------------------------------

/** Validates a write value against the property datatype; returns the stored text. */
export function normalizeValue(property: Pick<Property, "name" | "datatype">, value: unknown): string {
  switch (property.datatype) {
    case "text":
      if (typeof value !== "string") {
        throw invalid(`property "${property.name}" expects text, got ${typeof value}`);
      }
      return value;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw invalid(`property "${property.name}" expects a finite number`);
      }
      return String(value);
    }
    case "boolean":
      if (typeof value !== "boolean") {
        throw invalid(`property "${property.name}" expects a boolean`);
      }
      return value ? "true" : "false";
    case "date": {
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        throw invalid(`property "${property.name}" expects an ISO-8601 date string`);
      }
      return new Date(value).toISOString();
    }
    default:
      throw invalid(`property "${property.name}" has unknown datatype ${property.datatype}`);
  }
}

/** Casts stored text back to the declared datatype for reading. */
export function castValue(property: Pick<Property, "datatype">, stored: string): unknown {
  switch (property.datatype) {
    case "number":
      return Number(stored);
    case "boolean":
      return stored === "true";
    default:
      return stored;
  }
}

// ---- Filter SQL -------------------------------------------------------------

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** The comparable SQL expression for a value row, datatype-aware. */
function storedValueExpr(property: Pick<Property, "datatype">): SQL {
  return property.datatype === "number" ? sql`CAST(iv.value AS NUMERIC)` : sql.raw("iv.value");
}

/** Normalizes a filter operand for comparison against stored values. */
function compareOperand(property: Pick<Property, "name" | "datatype">, value: unknown): string | number {
  if (property.datatype === "number") {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) throw invalid(`filter on "${property.name}" expects a number`);
    return n;
  }
  if (property.datatype === "boolean") {
    if (typeof value === "boolean") return value ? "true" : "false";
    if (value === "true" || value === "false") return value;
    throw invalid(`filter on "${property.name}" expects a boolean`);
  }
  if (property.datatype === "date") {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      throw invalid(`filter on "${property.name}" expects an ISO-8601 date string`);
    }
    return new Date(value).toISOString();
  }
  if (typeof value !== "string") throw invalid(`filter on "${property.name}" expects text`);
  return value;
}

function filterValueCondition(property: Property, op: FilterOp, value: unknown): SQL {
  const expr = storedValueExpr(property);
  switch (op) {
    case "eq":
      return sql`${expr} = ${compareOperand(property, value)}`;
    case "neq":
      return sql`${expr} <> ${compareOperand(property, value)}`;
    case "gt":
      return sql`${expr} > ${compareOperand(property, value)}`;
    case "gte":
      return sql`${expr} >= ${compareOperand(property, value)}`;
    case "lt":
      return sql`${expr} < ${compareOperand(property, value)}`;
    case "lte":
      return sql`${expr} <= ${compareOperand(property, value)}`;
    case "contains": {
      if (typeof value !== "string") throw invalid(`contains filter on "${property.name}" expects text`);
      // Case-insensitive on both dialects (SQLite LIKE is ASCII-insensitive,
      // Postgres LIKE is sensitive — lower() both sides for parity).
      return sql`lower(iv.value) LIKE ${`%${escapeLike(value.toLowerCase())}%`} ESCAPE '\\'`;
    }
    case "in": {
      if (!Array.isArray(value) || value.length === 0) {
        throw invalid(`in filter on "${property.name}" expects a non-empty array`);
      }
      const operands = value.map((v) => compareOperand(property, v));
      return sql`${expr} IN (${sql.join(
        operands.map((o) => sql`${o}`),
        sql.raw(", "),
      )})`;
    }
    default:
      throw invalid(`unknown filter op ${JSON.stringify(op)} (expected one of: ${FILTER_OPS.join(", ")})`);
  }
}

// ---- Shared helpers ---------------------------------------------------------

async function loadProperties(db: Db, itemTypeId: string): Promise<Property[]> {
  const { properties } = db.tables;
  return db.client
    .select()
    .from(properties)
    .where(eq(properties.itemTypeId, itemTypeId))
    .orderBy(asc(properties.sortOrder), asc(properties.id));
}

function propertyByName(props: Property[], name: string): Property {
  const prop = props.find((p) => p.name === name);
  if (!prop) {
    throw invalid(`unknown property "${name}" (known: ${props.map((p) => p.name).join(", ") || "none"})`);
  }
  return prop;
}

async function materialize(
  db: Db,
  itemRows: { id: string; createdAt: string; updatedAt: string }[],
  itemTypeName: string,
  props: Property[],
): Promise<MaterializedItem[]> {
  if (itemRows.length === 0) return [];
  const { itemValues } = db.tables;
  const valueRows = await db.client
    .select()
    .from(itemValues)
    .where(inArray(itemValues.itemId, itemRows.map((r) => r.id)));
  const propsById = new Map(props.map((p) => [p.id, p]));
  return itemRows.map((row) => {
    const values: Record<string, unknown> = {};
    for (const v of valueRows.filter((v) => v.itemId === row.id)) {
      const prop = propsById.get(v.propertyId);
      if (prop) values[prop.name] = castValue(prop, v.value);
    }
    return { id: row.id, itemType: itemTypeName, createdAt: row.createdAt, updatedAt: row.updatedAt, values };
  });
}

// ---- CRUD -------------------------------------------------------------------

export async function createItems(
  db: Db,
  userId: string,
  bundleId: string,
  input: { itemType: string; items: Record<string, unknown>[] },
): Promise<MaterializedItem[]> {
  const ctx = await getBundleContext(db, bundleId);
  await requireCapability(db, userId, "edit_items", bundleCapabilityCtx(ctx));
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw invalid("items must be a non-empty array");
  }
  const itemType = await resolveItemType(db, bundleId, input.itemType);
  const props = await loadProperties(db, itemType.id);

  // Validate the whole batch before writing anything (never partially applied).
  const errors: string[] = [];
  const normalized: { propertyId: string; value: string }[][] = [];
  for (const [i, itemInput] of input.items.entries()) {
    const rows: { propertyId: string; value: string }[] = [];
    if (typeof itemInput !== "object" || itemInput === null || Array.isArray(itemInput)) {
      errors.push(`items[${i}]: must be an object of property values`);
      normalized.push(rows);
      continue;
    }
    for (const [name, value] of Object.entries(itemInput)) {
      try {
        const prop = propertyByName(props, name);
        if (value === null || value === undefined) continue; // absent
        rows.push({ propertyId: prop.id, value: normalizeValue(prop, value) });
      } catch (err) {
        errors.push(`items[${i}]: ${(err as Error).message}`);
      }
    }
    for (const prop of props.filter((p) => p.required)) {
      const provided = itemInput[prop.name];
      if (provided === null || provided === undefined) {
        errors.push(`items[${i}]: required property "${prop.name}" is missing`);
      }
    }
    normalized.push(rows);
  }
  if (errors.length > 0) throw invalid(`invalid items: ${errors.join("; ")}`, { errors });

  const { items, itemValues } = db.tables;
  const now = nowIso();
  const created: { id: string; createdAt: string; updatedAt: string }[] = [];
  for (const rows of normalized) {
    const item = { id: newId(), bundleId, itemTypeId: itemType.id, createdAt: now, updatedAt: now };
    await db.client.insert(items).values(item);
    if (rows.length > 0) {
      await db.client.insert(itemValues).values(
        rows.map((r) => ({ id: newId(), itemId: item.id, propertyId: r.propertyId, value: r.value })),
      );
    }
    created.push(item);
  }
  return materialize(db, created, itemType.name, props);
}

export async function getItems(
  db: Db,
  userId: string,
  bundleId: string,
  ids: string[],
): Promise<MaterializedItem[]> {
  const ctx = await getBundleContext(db, bundleId);
  await requireCapability(db, userId, "read_items", bundleCapabilityCtx(ctx));
  if (!Array.isArray(ids) || ids.length === 0) throw invalid("ids must be a non-empty array");
  const { items, itemTypes } = db.tables;
  const rows = await db.client
    .select()
    .from(items)
    .where(and(eq(items.bundleId, bundleId), inArray(items.id, ids)));
  const result: MaterializedItem[] = [];
  // Items may span item-types; materialize per type for correct casting.
  const typeIds = [...new Set(rows.map((r) => r.itemTypeId))];
  for (const typeId of typeIds) {
    const typeRows = await db.client.select().from(itemTypes).where(eq(itemTypes.id, typeId));
    const props = await loadProperties(db, typeId);
    result.push(...(await materialize(db, rows.filter((r) => r.itemTypeId === typeId), typeRows[0]!.name, props)));
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  return result.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export async function updateItems(
  db: Db,
  userId: string,
  bundleId: string,
  updates: { id: string; set: Record<string, unknown> }[],
): Promise<MaterializedItem[]> {
  const ctx = await getBundleContext(db, bundleId);
  await requireCapability(db, userId, "edit_items", bundleCapabilityCtx(ctx));
  if (!Array.isArray(updates) || updates.length === 0) throw invalid("updates must be a non-empty array");

  const { items, itemValues, itemTypes } = db.tables;
  const itemRows = await db.client
    .select()
    .from(items)
    .where(and(eq(items.bundleId, bundleId), inArray(items.id, updates.map((u) => u.id))));
  const byId = new Map(itemRows.map((r) => [r.id, r]));
  const propsByType = new Map<string, Property[]>();
  for (const typeId of new Set(itemRows.map((r) => r.itemTypeId))) {
    propsByType.set(typeId, await loadProperties(db, typeId));
  }

  // Validate everything first.
  const errors: string[] = [];
  const plans: { itemId: string; sets: { prop: Property; value: string }[]; clears: Property[] }[] = [];
  for (const [i, update] of updates.entries()) {
    const item = byId.get(update.id);
    if (!item) {
      errors.push(`updates[${i}]: item ${update.id} not found in bundle`);
      continue;
    }
    if (typeof update.set !== "object" || update.set === null) {
      errors.push(`updates[${i}]: set must be an object`);
      continue;
    }
    const props = propsByType.get(item.itemTypeId)!;
    const plan = { itemId: item.id, sets: [] as { prop: Property; value: string }[], clears: [] as Property[] };
    for (const [name, value] of Object.entries(update.set)) {
      try {
        const prop = propertyByName(props, name);
        if (value === null) {
          if (prop.required) {
            errors.push(`updates[${i}]: required property "${prop.name}" cannot be cleared`);
          } else {
            plan.clears.push(prop);
          }
        } else {
          plan.sets.push({ prop, value: normalizeValue(prop, value) });
        }
      } catch (err) {
        errors.push(`updates[${i}]: ${(err as Error).message}`);
      }
    }
    plans.push(plan);
  }
  if (errors.length > 0) throw invalid(`invalid updates: ${errors.join("; ")}`, { errors });

  const now = nowIso();
  for (const plan of plans) {
    for (const clear of plan.clears) {
      await db.client
        .delete(itemValues)
        .where(and(eq(itemValues.itemId, plan.itemId), eq(itemValues.propertyId, clear.id)));
    }
    for (const { prop, value } of plan.sets) {
      const existing = await db.client
        .select({ id: itemValues.id })
        .from(itemValues)
        .where(and(eq(itemValues.itemId, plan.itemId), eq(itemValues.propertyId, prop.id)));
      if (existing.length > 0) {
        await db.client.update(itemValues).set({ value }).where(eq(itemValues.id, existing[0]!.id));
      } else {
        await db.client.insert(itemValues).values({ id: newId(), itemId: plan.itemId, propertyId: prop.id, value });
      }
    }
    await db.client.update(items).set({ updatedAt: now }).where(eq(items.id, plan.itemId));
  }

  // Re-materialize the updated items, grouped per item-type.
  const result: MaterializedItem[] = [];
  for (const [typeId, props] of propsByType) {
    const typeRows = await db.client.select().from(itemTypes).where(eq(itemTypes.id, typeId));
    const rows = await db.client
      .select()
      .from(items)
      .where(and(eq(items.itemTypeId, typeId), inArray(items.id, plans.map((p) => p.itemId))));
    result.push(...(await materialize(db, rows, typeRows[0]!.name, props)));
  }
  return result;
}

export async function deleteItems(db: Db, userId: string, bundleId: string, ids: string[]): Promise<number> {
  const ctx = await getBundleContext(db, bundleId);
  await requireCapability(db, userId, "edit_items", bundleCapabilityCtx(ctx));
  if (!Array.isArray(ids) || ids.length === 0) throw invalid("ids must be a non-empty array");
  const { items } = db.tables;
  const existing = await db.client
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.bundleId, bundleId), inArray(items.id, ids)));
  if (existing.length > 0) {
    await db.client.delete(items).where(inArray(items.id, existing.map((r) => r.id)));
  }
  return existing.length;
}

// ---- Query ------------------------------------------------------------------

export async function queryItems(
  db: Db,
  userId: string,
  bundleId: string,
  query: ItemQuery,
): Promise<Page<MaterializedItem>> {
  const ctx = await getBundleContext(db, bundleId);
  await requireCapability(db, userId, "read_items", bundleCapabilityCtx(ctx));
  return queryItemsUnchecked(db, ctx, query);
}

/** Internal: query without the capability check (caller already gated). */
export async function queryItemsUnchecked(db: Db, ctx: BundleContext, query: ItemQuery): Promise<Page<MaterializedItem>> {
  const bundleId = ctx.bundle.id;
  if (!query.itemType) throw invalid("itemType is required");
  const itemType = await resolveItemType(db, bundleId, query.itemType);
  const props = await loadProperties(db, itemType.id);
  const { items } = db.tables;

  const conditions: SQL[] = [];
  for (const filter of query.filters ?? []) {
    if (!filter || typeof filter.property !== "string") throw invalid("each filter needs a property name");
    const prop = propertyByName(props, filter.property);
    const condition = filterValueCondition(prop, filter.op, filter.value);
    conditions.push(
      sql`EXISTS (SELECT 1 FROM item_values iv WHERE iv.item_id = ${items.id} AND iv.property_id = ${prop.id} AND ${condition})`,
    );
  }

  const limit = clampLimit(query.limit);
  const offset = decodeCursor(query.cursor);

  const orderings: SQL[] = [];
  if (query.sort) {
    const direction = query.sort.direction ?? "asc";
    if (direction !== "asc" && direction !== "desc") throw invalid(`sort direction must be "asc" or "desc"`);
    const sortProp = propertyByName(props, query.sort.property);
    const sub = sql`(SELECT ${storedValueExpr(sortProp)} FROM item_values iv WHERE iv.item_id = ${items.id} AND iv.property_id = ${sortProp.id} LIMIT 1)`;
    // Missing values sort last in both directions, on both dialects.
    orderings.push(sql`${sub} IS NULL`);
    orderings.push(direction === "desc" ? sql`${sub} DESC` : sql`${sub} ASC`);
  } else {
    orderings.push(sql`${items.createdAt} ASC`);
  }
  orderings.push(sql`${items.id} ASC`);

  const rows = await db.client
    .select()
    .from(items)
    .where(and(eq(items.bundleId, bundleId), eq(items.itemTypeId, itemType.id), ...conditions))
    .orderBy(...orderings)
    .limit(limit + 1)
    .offset(offset);

  const page = toPage(rows, offset, limit);
  const materialized = await materialize(db, page.data, itemType.name, props);
  return { data: materialized, nextCursor: page.nextCursor };
}
