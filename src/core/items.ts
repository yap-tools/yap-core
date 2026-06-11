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
import { countDecimals, NUMBER_DEFAULT_DECIMALS, parseConfig, type PropertyConfig } from "./propertyConfig.js";
import { newId, nowIso } from "./util.js";

/** Element-wise comparison operators. On a multi-valued property they apply
 *  per element, scoped by the filter's quantifier (any/all/none). */
export const COMPARISON_OPS = ["eq", "neq", "contains", "gt", "gte", "lt", "lte", "in"] as const;
/** Set operators for multi-valued properties (membership against the set). */
export const SET_OPS = ["has", "has_any", "has_all", "has_none"] as const;
export const FILTER_OPS = [...COMPARISON_OPS, ...SET_OPS] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** How a comparison op quantifies over a multi-valued property's elements. */
export const QUANTIFIERS = ["any", "all", "none"] as const;
export type Quantifier = (typeof QUANTIFIERS)[number];

export interface ItemFilter {
  property: string;
  op: FilterOp;
  value: unknown;
  /** Default "any". Ignored for single-valued properties and set operators. */
  quantifier?: Quantifier;
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

/** A stored reference's scheme — item://<id> or file://<id>. */
const REF_SCHEMES = { item: "item://", file: "file://" } as const;

/** Validates/canonicalizes a reference value to `<scheme>://<id>`. Accepts a
 *  bare id or the full URI; the id's existence in-bundle is checked separately
 *  (validateReferences) since that needs the database. */
function normalizeRef(scheme: "item" | "file", name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(`property "${name}" expects an ${scheme} reference (${scheme}://<id> or a bare id)`);
  }
  const prefix = REF_SCHEMES[scheme];
  let id = value.trim();
  if (id.startsWith(prefix)) id = id.slice(prefix.length);
  if (id === "" || id.includes("://")) {
    throw invalid(`property "${name}" expects an ${scheme} reference, got ${JSON.stringify(value)}`);
  }
  return `${prefix}${id}`;
}

/** The bare id inside a canonical reference value. */
export function refId(value: string): string {
  const i = value.indexOf("://");
  return i === -1 ? value : value.slice(i + 3);
}

/**
 * Validates a write value against the property datatype; returns the stored
 * text. When `config` is supplied (the write path) the declared constraints are
 * enforced too — regex for text, bounds/decimals for number. It is omitted on
 * the filter path, where operands are only type-checked and canonicalized.
 */
export function normalizeValue(
  property: Pick<Property, "name" | "datatype">,
  value: unknown,
  config?: PropertyConfig,
): string {
  switch (property.datatype) {
    case "text": {
      if (typeof value !== "string") {
        throw invalid(`property "${property.name}" expects text, got ${typeof value}`);
      }
      if (config?.pattern !== undefined && !new RegExp(config.pattern).test(value)) {
        throw invalid(`property "${property.name}" must match ${config.pattern}`);
      }
      return value;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw invalid(`property "${property.name}" expects a finite number`);
      }
      if (config) {
        const decimals = config.decimals ?? NUMBER_DEFAULT_DECIMALS;
        if (countDecimals(value) > decimals) {
          throw invalid(`property "${property.name}" allows at most ${decimals} decimal place(s)`);
        }
        if (config.min !== undefined && value < config.min) {
          throw invalid(`property "${property.name}" must be >= ${config.min}`);
        }
        if (config.max !== undefined && value > config.max) {
          throw invalid(`property "${property.name}" must be <= ${config.max}`);
        }
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
    case "item":
      return normalizeRef("item", property.name, value);
    case "file":
      return normalizeRef("file", property.name, value);
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

/**
 * Normalizes a property input value into ordered stored-value rows. A
 * single-valued property yields 0 rows (null/undefined) or 1; a multi-valued
 * property yields 0..n, one per element with a `position`. Multi accepts an
 * array, or a bare scalar (coerced to a one-element list) for ergonomics; a
 * single-valued property rejects arrays. Throws on per-element type errors.
 */
export function normalizeProperty(
  property: Pick<Property, "name" | "datatype" | "multi" | "config">,
  value: unknown,
): { value: string; position: number }[] {
  const config = parseConfig(property.config);
  if (property.multi) {
    const list = value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];
    // minItems/maxItems bound a *populated* property; an empty list defers to
    // the required check (clearing an optional property stays legal).
    if (list.length > 0) {
      if (config.minItems !== undefined && list.length < config.minItems) {
        throw invalid(`property "${property.name}" requires at least ${config.minItems} value(s)`);
      }
      if (config.maxItems !== undefined && list.length > config.maxItems) {
        throw invalid(`property "${property.name}" allows at most ${config.maxItems} value(s)`);
      }
    }
    return list.map((element, position) => ({ value: normalizeValue(property, element, config), position }));
  }
  if (Array.isArray(value)) {
    throw invalid(`property "${property.name}" is single-valued; pass a scalar, not an array`);
  }
  if (value === null || value === undefined) return [];
  return [{ value: normalizeValue(property, value, config), position: 0 }];
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
  if (property.datatype === "item" || property.datatype === "file") {
    // Canonicalize so a filter operand matches stored "<scheme>://<id>".
    return normalizeValue(property, value);
  }
  if (typeof value !== "string") throw invalid(`filter on "${property.name}" expects text`);
  return value;
}

type ComparisonOp = (typeof COMPARISON_OPS)[number];

/** Builds the per-value-row SQL condition (over alias `iv`) for a comparison op. */
function filterValueCondition(property: Property, op: ComparisonOp, value: unknown): SQL {
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
  }
}

/**
 * Builds the full item-level predicate for one filter, handling the explicit
 * multi-value semantics: comparison ops are scoped by a quantifier
 * (any/all/none) and the set operators (has/has_any/has_all/has_none) match
 * against the property's value set. All forms stay within the SQLite∩Postgres
 * subset (correlated EXISTS / NOT EXISTS / COUNT DISTINCT).
 */
function buildFilterPredicate(itemId: SQL, property: Property, filter: ItemFilter): SQL {
  const pid = property.id;
  const exists = (cond: SQL): SQL =>
    sql`EXISTS (SELECT 1 FROM item_values iv WHERE iv.item_id = ${itemId} AND iv.property_id = ${pid} AND ${cond})`;
  const notExists = (cond: SQL): SQL =>
    sql`NOT EXISTS (SELECT 1 FROM item_values iv WHERE iv.item_id = ${itemId} AND iv.property_id = ${pid} AND ${cond})`;

  switch (filter.op) {
    case "has":
      return exists(filterValueCondition(property, "eq", filter.value));
    case "has_any":
      return exists(filterValueCondition(property, "in", filter.value));
    case "has_none":
      return notExists(filterValueCondition(property, "in", filter.value));
    case "has_all": {
      if (!Array.isArray(filter.value) || filter.value.length === 0) {
        throw invalid(`has_all on "${property.name}" expects a non-empty array`);
      }
      // Stored values are canonical text, so exact text equality is correct
      // membership; dedupe operands so the count target matches.
      const operands = [...new Set(filter.value.map((v) => normalizeValue(property, v)))];
      const inList = sql.join(
        operands.map((o) => sql`${o}`),
        sql.raw(", "),
      );
      return sql`(SELECT COUNT(DISTINCT iv.value) FROM item_values iv WHERE iv.item_id = ${itemId} AND iv.property_id = ${pid} AND iv.value IN (${inList})) = ${operands.length}`;
    }
    default: {
      const cond = filterValueCondition(property, filter.op, filter.value);
      switch (filter.quantifier ?? "any") {
        case "any":
          return exists(cond);
        case "none":
          return notExists(cond);
        case "all":
          // Non-empty AND no element violates the condition.
          return sql`(EXISTS (SELECT 1 FROM item_values iv WHERE iv.item_id = ${itemId} AND iv.property_id = ${pid}) AND ${notExists(sql`NOT (${cond})`)})`;
      }
    }
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
  return itemRows.map((row) => {
    const values: Record<string, unknown> = {};
    const itemVals = valueRows.filter((v) => v.itemId === row.id);
    for (const prop of props) {
      const own = itemVals.filter((v) => v.propertyId === prop.id).sort((a, b) => a.position - b.position);
      if (own.length === 0) continue;
      values[prop.name] = prop.multi
        ? own.map((v) => castValue(prop, v.value))
        : castValue(prop, own[0]!.value);
    }
    return { id: row.id, itemType: itemTypeName, createdAt: row.createdAt, updatedAt: row.updatedAt, values };
  });
}

// ---- Reference integrity ----------------------------------------------------

interface RefEntry {
  label: string;
  prop: Property;
  value: string;
}

/** Queues item/file values for existence checking (no-op for other datatypes). */
function collectRefs(refs: RefEntry[], label: string, prop: Property, rows: { value: string }[]): void {
  if (prop.datatype !== "item" && prop.datatype !== "file") return;
  for (const r of rows) refs.push({ label, prop, value: r.value });
}

/**
 * Validates that item/file reference values point at something real in this
 * bundle — an existing item (optionally of the type a property's
 * config.itemType pins) or a finalized file. Needs the database, so it runs
 * as a batched pass alongside the synchronous datatype validation rather than
 * inside normalizeValue. Returns label-prefixed error strings.
 */
async function validateReferences(db: Db, bundleId: string, refs: RefEntry[]): Promise<string[]> {
  if (refs.length === 0) return [];
  const { items, files } = db.tables;
  const errors: string[] = [];

  const itemRefs = refs.filter((r) => r.prop.datatype === "item");
  if (itemRefs.length > 0) {
    const ids = [...new Set(itemRefs.map((r) => refId(r.value)))];
    const rows = await db.client
      .select({ id: items.id, bundleId: items.bundleId, itemTypeId: items.itemTypeId })
      .from(items)
      .where(inArray(items.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const typeIdCache = new Map<string, string | null>();
    const resolveTargetTypeId = async (ref: string): Promise<string | null> => {
      if (typeIdCache.has(ref)) return typeIdCache.get(ref)!;
      let id: string | null = null;
      try {
        id = (await resolveItemType(db, bundleId, ref)).id;
      } catch {
        id = null;
      }
      typeIdCache.set(ref, id);
      return id;
    };
    for (const ref of itemRefs) {
      const row = byId.get(refId(ref.value));
      if (!row || row.bundleId !== bundleId) {
        errors.push(`${ref.label}: property "${ref.prop.name}" references ${ref.value}, which is not an item in this bundle`);
        continue;
      }
      const target = parseConfig(ref.prop.config).itemType;
      if (target !== undefined) {
        const wantId = await resolveTargetTypeId(target);
        if (wantId === null || row.itemTypeId !== wantId) {
          errors.push(`${ref.label}: property "${ref.prop.name}" must reference an item of type "${target}"`);
        }
      }
    }
  }

  const fileRefs = refs.filter((r) => r.prop.datatype === "file");
  if (fileRefs.length > 0) {
    const ids = [...new Set(fileRefs.map((r) => refId(r.value)))];
    const rows = await db.client
      .select({ id: files.id, bundleId: files.bundleId, status: files.status })
      .from(files)
      .where(inArray(files.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const ref of fileRefs) {
      const row = byId.get(refId(ref.value));
      if (!row || row.bundleId !== bundleId || row.status !== "finalized") {
        errors.push(
          `${ref.label}: property "${ref.prop.name}" references ${ref.value}, which is not a finalized file in this bundle`,
        );
      }
    }
  }
  return errors;
}

// ---- CRUD -------------------------------------------------------------------

/** Resolves an item id to its owning bundle (transport helper for /v1/items/:id). */
export async function getItemBundleId(db: Db, itemId: string): Promise<string> {
  const { items } = db.tables;
  const rows = await db.client.select({ bundleId: items.bundleId }).from(items).where(eq(items.id, itemId));
  if (rows.length === 0) throw notFound("item", itemId);
  return rows[0]!.bundleId;
}

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
  const refs: RefEntry[] = [];
  const normalized: { propertyId: string; value: string; position: number }[][] = [];
  for (const [i, itemInput] of input.items.entries()) {
    const rows: { propertyId: string; value: string; position: number }[] = [];
    if (typeof itemInput !== "object" || itemInput === null || Array.isArray(itemInput)) {
      errors.push(`items[${i}]: must be an object of property values`);
      normalized.push(rows);
      continue;
    }
    const populated = new Set<string>();
    for (const [name, value] of Object.entries(itemInput)) {
      try {
        const prop = propertyByName(props, name);
        const elements = normalizeProperty(prop, value);
        if (elements.length > 0) populated.add(prop.id);
        for (const el of elements) rows.push({ propertyId: prop.id, value: el.value, position: el.position });
        collectRefs(refs, `items[${i}]`, prop, elements);
      } catch (err) {
        errors.push(`items[${i}]: ${(err as Error).message}`);
      }
    }
    for (const prop of props.filter((p) => p.required)) {
      if (!populated.has(prop.id)) {
        errors.push(
          `items[${i}]: required property "${prop.name}" is missing${prop.multi ? " (needs at least one value)" : ""}`,
        );
      }
    }
    normalized.push(rows);
  }
  errors.push(...(await validateReferences(db, bundleId, refs)));
  if (errors.length > 0) throw invalid(`invalid items: ${errors.join("; ")}`, { errors });

  const { items, itemValues } = db.tables;
  const now = nowIso();
  const created: { id: string; createdAt: string; updatedAt: string }[] = [];
  for (const rows of normalized) {
    const item = { id: newId(), bundleId, itemTypeId: itemType.id, createdAt: now, updatedAt: now };
    await db.client.insert(items).values(item);
    if (rows.length > 0) {
      await db.client.insert(itemValues).values(
        rows.map((r) => ({ id: newId(), itemId: item.id, propertyId: r.propertyId, value: r.value, position: r.position })),
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

  // Validate everything first. Each set property is a whole-value replacement:
  // its existing rows are deleted and the new ones inserted (works uniformly
  // for single- and multi-valued properties). An empty/null value clears it.
  const errors: string[] = [];
  const refs: RefEntry[] = [];
  const plans: { itemId: string; ops: { prop: Property; rows: { value: string; position: number }[] }[] }[] = [];
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
    const plan = { itemId: item.id, ops: [] as { prop: Property; rows: { value: string; position: number }[] }[] };
    for (const [name, value] of Object.entries(update.set)) {
      try {
        const prop = propertyByName(props, name);
        const rows = normalizeProperty(prop, value);
        if (rows.length === 0 && prop.required) {
          errors.push(`updates[${i}]: required property "${prop.name}" cannot be cleared`);
        } else {
          plan.ops.push({ prop, rows });
          collectRefs(refs, `updates[${i}]`, prop, rows);
        }
      } catch (err) {
        errors.push(`updates[${i}]: ${(err as Error).message}`);
      }
    }
    plans.push(plan);
  }
  errors.push(...(await validateReferences(db, bundleId, refs)));
  if (errors.length > 0) throw invalid(`invalid updates: ${errors.join("; ")}`, { errors });

  const now = nowIso();
  for (const plan of plans) {
    for (const op of plan.ops) {
      await db.client
        .delete(itemValues)
        .where(and(eq(itemValues.itemId, plan.itemId), eq(itemValues.propertyId, op.prop.id)));
      if (op.rows.length > 0) {
        await db.client.insert(itemValues).values(
          op.rows.map((r) => ({
            id: newId(),
            itemId: plan.itemId,
            propertyId: op.prop.id,
            value: r.value,
            position: r.position,
          })),
        );
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

  const itemIdRef = sql`${items.id}`;
  const conditions: SQL[] = [];
  for (const filter of query.filters ?? []) {
    if (!filter || typeof filter.property !== "string") throw invalid("each filter needs a property name");
    if (!FILTER_OPS.includes(filter.op)) {
      throw invalid(`unknown filter op ${JSON.stringify(filter.op)} (expected one of: ${FILTER_OPS.join(", ")})`);
    }
    if (filter.quantifier !== undefined && !QUANTIFIERS.includes(filter.quantifier)) {
      throw invalid(`quantifier must be one of: ${QUANTIFIERS.join(", ")}`);
    }
    const prop = propertyByName(props, filter.property);
    conditions.push(buildFilterPredicate(itemIdRef, prop, filter));
  }

  const limit = clampLimit(query.limit);
  const offset = decodeCursor(query.cursor);

  const orderings: SQL[] = [];
  if (query.sort) {
    const direction = query.sort.direction ?? "asc";
    if (direction !== "asc" && direction !== "desc") throw invalid(`sort direction must be "asc" or "desc"`);
    const sortProp = propertyByName(props, query.sort.property);
    // For a multi-valued property, sort by its first element (lowest position).
    const sub = sql`(SELECT ${storedValueExpr(sortProp)} FROM item_values iv WHERE iv.item_id = ${items.id} AND iv.property_id = ${sortProp.id} ORDER BY iv.position ASC LIMIT 1)`;
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
