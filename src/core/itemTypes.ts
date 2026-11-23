/**
 * Item-type / property (schema) authoring. A schema is a set of property
 * rows, which is what makes it freely mutable after items exist: rename =
 * update one row, add = insert one, remove = delete the row (value rows
 * cascade-delete immediately). Schema authoring is REST-first and gated by
 * edit_bundles — edit_items does not imply schema-editing rights.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Db, DbClient } from "../db/index.js";
import { valueIndexPrefix } from "../db/valueIndex.js";
import {
  DATATYPES,
  getBundleContext,
  requireBundleCapability,
  requireBundleReadAccess,
  type Datatype,
  type PropertyInput,
} from "./bundles.js";
import { MIDNIGHT_UTC_SUFFIX as MIDNIGHT_UTC, STORED_DAY_LENGTH, STORED_INSTANT_LENGTH } from "./dates.js";
import { invalid, notFound, YapError } from "./errors.js";
import { hasLinkTarget, linkTargetCandidates, withResolvedLinkTarget } from "./linkTargets.js";
import {
  isDayPrecision,
  parseConfig,
  serializeConfig,
  validatePropertyConfig,
  type PropertyConfig,
} from "./propertyConfig.js";
import { displayValue, newId, nowIso } from "./util.js";

export interface Property {
  id: string;
  itemTypeId: string;
  name: string;
  datatype: string;
  required: number;
  multi: number;
  /** JSON-text per-datatype constraints; "" = none. Parse with parseConfig. */
  config: string;
  sortOrder: number;
}

/**
 * Read-side view of a property: the public/transport shape. Parses the stored
 * config JSON and normalizes the EAV storage ints (required/multi) to booleans,
 * so the read shape matches the boolean write shape across REST and MCP.
 */
export function propertyView<T extends { config: string; required: number; multi: number }>(
  p: T,
): Omit<T, "config" | "required" | "multi"> & { config: PropertyConfig; required: boolean; multi: boolean } {
  return { ...p, config: parseConfig(p.config), required: !!p.required, multi: !!p.multi };
}

/** Read-side view of an item-type with its properties' config parsed. */
export function itemTypeView(t: ItemTypeWithProperties) {
  return { ...t, properties: t.properties.map(propertyView) };
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
  await requireBundleCapability(db, userId, "edit_bundles", ctx);
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
    const cfgErrors = validatePropertyConfig(prop.datatype, !!prop.multi, prop.config ?? {});
    if (cfgErrors.length > 0) throw invalid(`property "${prop.name}": ${cfgErrors.join("; ")}`);
  }

  // Link targets resolve to ids before anything is written. The new type is a
  // candidate too, so a property can link to the type it belongs to.
  const id = newId();
  const candidates = propInputs.some((p) => hasLinkTarget(p.config))
    ? [...(await linkTargetCandidates(db, bundleId)), { id, name }]
    : [];
  const configs = propInputs.map((prop) => withResolvedLinkTarget(prop.name.trim(), prop.config, candidates));

  // The type and its properties are one transaction: no type without them.
  await db.transaction(function* (tx) {
    yield tx.insert(itemTypes).values({ id, bundleId, name, createdAt: nowIso() });
    if (propInputs.length > 0) {
      yield tx.insert(properties).values(
        propInputs.map((prop, order) => ({
          id: newId(),
          itemTypeId: id,
          name: prop.name.trim(),
          datatype: prop.datatype,
          required: prop.required ? 1 : 0,
          multi: prop.multi ? 1 : 0,
          config: serializeConfig(configs[order]),
          sortOrder: order,
        })),
      );
    }
  });
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
  await requireBundleCapability(db, userId, "edit_bundles", ctx);
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
  await requireBundleCapability(db, userId, "edit_bundles", ctx);
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
  input: { name: string; datatype: Datatype; required?: boolean; multi?: boolean; config?: PropertyConfig },
): Promise<Property> {
  const { ctx } = await getItemTypeContext(db, itemTypeId);
  await requireBundleCapability(db, userId, "edit_bundles", ctx);
  const name = input.name?.trim();
  if (!name) throw invalid("property name is required");
  if (!DATATYPES.includes(input.datatype)) throw invalid(`invalid datatype ${JSON.stringify(input.datatype)}`);
  const cfgErrors = validatePropertyConfig(input.datatype, !!input.multi, input.config ?? {});
  if (cfgErrors.length > 0) throw invalid(`property "${name}": ${cfgErrors.join("; ")}`);
  const { properties } = db.tables;
  const siblings = await db.client.select().from(properties).where(eq(properties.itemTypeId, itemTypeId));
  if (siblings.some((p) => p.name === name)) throw invalid(`property "${name}" already exists on this item-type`);
  const config = hasLinkTarget(input.config)
    ? withResolvedLinkTarget(name, input.config, await linkTargetCandidates(db, ctx.bundle.id))
    : input.config;
  const row: Property = {
    id: newId(),
    itemTypeId,
    name,
    datatype: input.datatype,
    required: input.required ? 1 : 0,
    multi: input.multi ? 1 : 0,
    config: serializeConfig(config),
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
  patch: { name?: string; required?: boolean; multi?: boolean; config?: PropertyConfig; sortOrder?: number },
): Promise<Property> {
  const { ctx } = await getItemTypeContext(db, itemTypeId);
  await requireBundleCapability(db, userId, "edit_bundles", ctx);
  const { properties, itemValues } = db.tables;
  const rows = await db.client
    .select()
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.itemTypeId, itemTypeId)));
  if (rows.length === 0) throw notFound("property", propertyId);
  const current = rows[0]!;
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw invalid("property name cannot be empty");
    const siblings = await db.client.select().from(properties).where(eq(properties.itemTypeId, itemTypeId));
    if (siblings.some((p) => p.name === name && p.id !== propertyId)) {
      throw invalid(`property "${name}" already exists on this item-type`);
    }
  }
  // Config is validated against the (immutable) datatype and the effective
  // multi flag — so e.g. minItems can't survive a switch to single-valued,
  // and unique can't survive a switch to multi. A multi flip without a config
  // patch re-validates the stored config for the same reason.
  if (patch.config !== undefined || patch.multi !== undefined) {
    const effectiveMulti = patch.multi ?? current.multi === 1;
    const effectiveConfig = patch.config ?? parseConfig(current.config);
    const cfgErrors = validatePropertyConfig(current.datatype, effectiveMulti, effectiveConfig);
    if (cfgErrors.length > 0) throw invalid(`property "${current.name}": ${cfgErrors.join("; ")}`);
  }
  // single→multi is free (existing scalar reads back as a one-element list);
  // multi→single is rejected when any item holds more than one value, rather
  // than silently dropping data.
  if (patch.multi !== undefined && !patch.multi && current.multi === 1) {
    const offending = await db.client
      .select({ itemId: itemValues.itemId })
      .from(itemValues)
      .where(eq(itemValues.propertyId, propertyId))
      .groupBy(itemValues.itemId)
      .having(sql`count(*) > 1`)
      .limit(1);
    if (offending.length > 0) {
      throw invalid(
        `cannot convert "${current.name}" to single-valued: at least one item has multiple values; ` +
          `reduce those items to one value first`,
      );
    }
  }
  // Turning unique on must not grandfather existing duplicates — the flag
  // would be a lie. Reject and name the shared values so the data can be
  // fixed first. (A freshly added property has no values, so addProperty
  // needs no such guard.)
  if (patch.config?.unique === true && parseConfig(current.config).unique !== true) {
    const dupes = await db.client
      .select({ value: itemValues.value })
      .from(itemValues)
      .where(eq(itemValues.propertyId, propertyId))
      // The prefix key mirrors the value index; the full value is what keeps
      // values sharing a prefix apart.
      .groupBy(valueIndexPrefix(itemValues.value), itemValues.value)
      .having(sql`count(*) > 1`)
      .limit(5);
    if (dupes.length > 0) {
      const shown = dupes.map((d) => displayValue(d.value));
      throw invalid(
        `cannot mark "${current.name}" unique: value(s) ${shown.join(", ")} are shared by multiple items; ` +
          `deduplicate those items first`,
      );
    }
  }
  // A config patch replaces the stored config whole, so its link target is
  // resolved to an id here; a stored config the patch leaves alone is not
  // re-resolved (the startup upgrade owns rows written before ids).
  const config = hasLinkTarget(patch.config)
    ? withResolvedLinkTarget(current.name, patch.config, await linkTargetCandidates(db, ctx.bundle.id))
    : patch.config;
  // A date property switched between instant and day has its stored values
  // rewritten in the same transaction as the config, so the two never
  // disagree. A config patch replaces the config whole: leaving precision out
  // of it means instant. The precision it is switched from is read inside the
  // transaction, under a row lock on Postgres, so two concurrent config
  // changes cannot both decide from the same stale value.
  await db.transaction(function* (tx) {
    if (current.datatype === "date" && config !== undefined) {
      const query = tx.select({ config: properties.config }).from(properties).where(eq(properties.id, propertyId));
      const [fresh]: { config: string }[] = yield lockRows(db, query, "update");
      const wasDay = isDayPrecision(parseConfig(fresh?.config));
      const toDay = isDayPrecision(config);
      if (toDay !== wasDay) yield* convertDatePrecision(db, tx, current, toDay ? "day" : "instant");
    }
    yield tx
      .update(properties)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.required !== undefined ? { required: patch.required ? 1 : 0 } : {}),
        ...(patch.multi !== undefined ? { multi: patch.multi ? 1 : 0 } : {}),
        ...(config !== undefined ? { config: serializeConfig(config) } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
      })
      .where(eq(properties.id, propertyId));
  });
  const updated = await db.client.select().from(properties).where(eq(properties.id, propertyId));
  return updated[0]!;
}

/**
 * A select that locks the rows it reads until the transaction ends, on
 * Postgres. SQLite needs no row locks: its transactions run start to finish
 * without another request's statements in between (see Db.transaction).
 */
function lockRows<T>(db: Db, query: T, mode: "update" | "key share"): T {
  return db.dialect === "pg" ? (query as unknown as { for(m: string): T }).for(mode) : query;
}

/**
 * The guard an item write runs first inside its transaction: re-reads the
 * precision of the date properties it writes, and refuses the write (a
 * `conflict`, safe to retry) if any changed after its values were validated.
 * On Postgres the read key-share-locks those property rows (the lightest
 * lock that still conflicts with FOR UPDATE) until the write commits, and a precision switch locks the row for update (updateProperty),
 * so the two take turns: either the switch waits and then converts the
 * values this write committed, or this write waits and sees the new precision.
 */
export function* guardDatePrecision(db: Db, tx: DbClient, written: Property[]): Generator<unknown, void, any> {
  const dates = [...new Map(written.filter((p) => p.datatype === "date").map((p) => [p.id, p])).values()];
  if (dates.length === 0) return;
  const { properties } = db.tables;
  const query = tx
    .select({ id: properties.id, config: properties.config })
    .from(properties)
    .where(inArray(properties.id, dates.map((p) => p.id)));
  const rows: { id: string; config: string }[] = yield lockRows(db, query, "key share");
  for (const prop of dates) {
    const row = rows.find((r) => r.id === prop.id);
    if (row && isDayPrecision(parseConfig(row.config)) !== isDayPrecision(parseConfig(prop.config))) {
      throw new YapError("conflict", `property "${prop.name}" changed precision while this write was in progress; retry it`);
    }
  }
}

/**
 * Rewrites a date property's stored values for a switch of precision, inside
 * the caller's transaction (see updateProperty).
 *
 * To day: only an instant at exactly midnight UTC (`2026-11-16T00:00:00.000Z`)
 * becomes its day (`2026-11-16`). Any other instant is ambiguous — 23:00 UTC
 * is midnight at UTC+1 or a real evening — so it is never guessed at:
 * the switch is refused, naming up to five items holding such a value, and
 * the owner fixes those by hand and switches again.
 *
 * To instant: each day becomes midnight UTC of that day, which every day has.
 *
 * The matching values are rewritten first and whatever is left is checked
 * after, in one transaction. Item writes cannot slip a value in the old form
 * past it: see guardDatePrecision.
 */
function* convertDatePrecision(
  db: Db,
  tx: DbClient,
  property: Property,
  to: "day" | "instant",
): Generator<unknown, void, any> {
  const { itemValues } = db.tables;
  const ofProperty = eq(itemValues.propertyId, property.id);
  // Stored forms are told apart by length (see dates.ts); an instant longer
  // than the canonical one has an expanded year and never converts.
  const isInstant = sql`length(${itemValues.value}) = ${STORED_INSTANT_LENGTH}`;
  const isDay = sql`length(${itemValues.value}) = ${STORED_DAY_LENGTH}`;
  const convertible =
    to === "day" ? sql`${isInstant} AND substr(${itemValues.value}, ${STORED_DAY_LENGTH + 1}) = ${MIDNIGHT_UTC}` : isDay;
  yield tx
    .update(itemValues)
    .set({
      value:
        to === "day"
          ? sql`substr(${itemValues.value}, 1, ${STORED_DAY_LENGTH})`
          : sql`${itemValues.value} || ${MIDNIGHT_UTC}`,
    })
    .where(and(ofProperty, convertible));
  // After the rewrite, a converted value has the target form; anything else
  // could not be converted.
  const converted = to === "day" ? isDay : isInstant;
  const offending: { itemId: string }[] = yield tx
    .select({ itemId: itemValues.itemId })
    .from(itemValues)
    .where(and(ofProperty, sql`NOT (${converted})`))
    .groupBy(itemValues.itemId)
    .orderBy(asc(itemValues.itemId))
    .limit(5);
  if (offending.length > 0) {
    const ids = offending.map((o) => o.itemId).join(", ");
    throw invalid(
      to === "day"
        ? `cannot switch "${property.name}" to precision "day": item(s) ${ids} hold a time other than ` +
            `midnight UTC (${MIDNIGHT_UTC.slice(1)}), which has no one day to convert to; ` +
            `set each to the day it means as YYYY-MM-DD (stored as midnight UTC), or clear it, and switch again`
        : `cannot switch "${property.name}" to precision "instant": item(s) ${ids} hold a value that is not a day (YYYY-MM-DD)`,
    );
  }
}

/** Deletes the property row; its value rows cascade-delete immediately. */
export async function deleteProperty(db: Db, userId: string, itemTypeId: string, propertyId: string): Promise<void> {
  const { ctx } = await getItemTypeContext(db, itemTypeId);
  await requireBundleCapability(db, userId, "edit_bundles", ctx);
  const { properties } = db.tables;
  const rows = await db.client
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.itemTypeId, itemTypeId)));
  if (rows.length === 0) throw notFound("property", propertyId);
  await db.client.delete(properties).where(eq(properties.id, propertyId));
}
