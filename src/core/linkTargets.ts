/**
 * Link targets: the item type a link property (datatype `item`) points at.
 *
 * A link property may pin its referent's type through `config.itemType`. That
 * value is stored as the target item type's **id**, never its name, so a link
 * keeps pointing at the same type when the type is renamed, and a different
 * type that later takes the old name does not become the target.
 *
 * Callers may still send a name. It is resolved once, on save, against the
 * item types of the property's own bundle (links never cross bundles), and the
 * id is what gets stored. A value that matches no item type there is refused.
 *
 * Instances that predate this rule stored whatever the caller sent, usually a
 * name. `upgradeLinkTargets` rewrites those rows to ids at startup (see
 * src/serve.ts), and leaves alone, and logs, any row it cannot rewrite
 * safely. Item writes still resolve a pin by id first, then by name
 * (resolveItemType in bundles.ts); the name step is there for those leftover
 * rows, and no save path stores a name any more.
 */
import { and, eq, exists, inArray, like, sql } from "drizzle-orm";

import type { Db } from "../db/index.js";
import type { YapLogger } from "../logger.js";
import { invalid } from "./errors.js";
import type { PropertyConfig } from "./propertyConfig.js";

/** An item type a link may target: one of the bundle's own types. */
export interface LinkTargetCandidate {
  id: string;
  name: string;
}

/**
 * Resolves a stored or submitted `config.itemType` value to an item type id
 * among the candidates: an exact id match first, then a name held by exactly
 * one candidate. Returns null when nothing (or more than one type) matches.
 */
export function resolveLinkTarget(value: string, candidates: readonly LinkTargetCandidate[]): string | null {
  if (candidates.some((c) => c.id === value)) return value;
  const byName = candidates.filter((c) => c.name === value);
  return byName.length === 1 ? byName[0]!.id : null;
}

/** The refusal for a link target that matches no item type in the bundle. */
export function unknownLinkTargetMessage(propertyName: string, value: string): string {
  return `property "${propertyName}": config.itemType ${JSON.stringify(value)} matches no item type in this bundle`;
}

/**
 * Returns `config` with `itemType` replaced by the target's id, or throws a
 * validation error naming the property and the value when it matches nothing.
 * A config without `itemType` comes back unchanged.
 */
export function withResolvedLinkTarget(
  propertyName: string,
  config: PropertyConfig | undefined,
  candidates: readonly LinkTargetCandidate[],
): PropertyConfig | undefined {
  if (!hasLinkTarget(config)) return config;
  const id = resolveLinkTarget(config!.itemType!, candidates);
  if (id === null) throw invalid(unknownLinkTargetMessage(propertyName, config!.itemType!));
  return { ...config, itemType: id };
}

/** Whether a config pins a link target (and so needs resolving on save). */
export function hasLinkTarget(config: PropertyConfig | undefined): boolean {
  return config?.itemType !== undefined && config.itemType !== null;
}

/** The bundle's item types, as link-target candidates. */
export async function linkTargetCandidates(db: Db, bundleId: string): Promise<LinkTargetCandidate[]> {
  const { itemTypes } = db.tables;
  return db.client
    .select({ id: itemTypes.id, name: itemTypes.name })
    .from(itemTypes)
    .where(eq(itemTypes.bundleId, bundleId));
}

// ---- Upgrade: name-valued links → ids ---------------------------------------

/** A link property row the upgrade looked at. */
export interface LinkTargetRow {
  propertyId: string;
  propertyName: string;
  itemTypeId: string;
  itemTypeName: string;
  bundleId: string;
  bundleName: string;
  /** The stored `config` column, verbatim. */
  config: string;
  /** The stored `config.itemType` value (null when the config cannot be read). */
  value: string | null;
}

/** Why the upgrade left a row as it was. */
export type LeftAloneReason =
  /** The value is the name of no item type in the bundle (or of more than one). */
  | "no-match"
  /** The config is not a JSON object with a string itemType. */
  | "unreadable"
  /** The value resolves, but the stored JSON is not in the exact form Core
   *  writes, so rewriting it could change more than the one key. */
  | "not-canonical";

export interface LinkTargetRewrite extends LinkTargetRow {
  value: string;
  /** The id the value resolves to. */
  targetId: string;
  /** The new `config` column: the stored JSON with only `itemType` changed. */
  newConfig: string;
}

export interface LinkTargetPlan {
  rewrites: LinkTargetRewrite[];
  /** Link properties the upgrade could not rewrite safely: left exactly as they are. */
  leftAlone: (LinkTargetRow & { reason: LeftAloneReason })[];
}

/**
 * Finds the link properties whose `config.itemType` is not the id of an item
 * type in the property's own bundle. Each one whose value is the name of
 * exactly one item type in that bundle is planned for a rewrite to that type's
 * id; every other one is left alone. Reads only.
 *
 * Rows are matched against item types as they are named *now*. If a type was
 * renamed or deleted and another later took its old name, the link binds to
 * the type holding the name today, which is also what item writes did before
 * the upgrade.
 */
export async function planLinkTargetUpgrade(db: Db): Promise<LinkTargetPlan> {
  const { properties, itemTypes, bundles } = db.tables;
  // Only link properties whose config mentions itemType can hold a pin; the
  // rest (no constraints, or only minItems/maxItems) are never read.
  const props = await db.client
    .select({
      propertyId: properties.id,
      propertyName: properties.name,
      config: properties.config,
      itemTypeId: itemTypes.id,
      itemTypeName: itemTypes.name,
      bundleId: bundles.id,
      bundleName: bundles.name,
    })
    .from(properties)
    .innerJoin(itemTypes, eq(itemTypes.id, properties.itemTypeId))
    .innerJoin(bundles, eq(bundles.id, itemTypes.bundleId))
    .where(and(eq(properties.datatype, "item"), like(properties.config, "%itemType%")));
  const plan: LinkTargetPlan = { rewrites: [], leftAlone: [] };
  if (props.length === 0) return plan;

  const typesByBundle = new Map<string, LinkTargetCandidate[]>();
  const bundleTypes = await db.client
    .select({ id: itemTypes.id, bundleId: itemTypes.bundleId, name: itemTypes.name })
    .from(itemTypes)
    .where(inArray(itemTypes.bundleId, [...new Set(props.map((p) => p.bundleId))]));
  for (const t of bundleTypes) {
    const list = typesByBundle.get(t.bundleId);
    if (list) list.push({ id: t.id, name: t.name });
    else typesByBundle.set(t.bundleId, [{ id: t.id, name: t.name }]);
  }

  for (const row of props) {
    const parsed = parseObject(row.config);
    if (parsed && parsed.itemType === undefined) continue; // constraints, but no pin
    const value = typeof parsed?.itemType === "string" ? parsed.itemType : null;
    const candidates = typesByBundle.get(row.bundleId) ?? [];
    if (value === null) {
      plan.leftAlone.push({ ...row, value, reason: "unreadable" });
      continue;
    }
    const targetId = resolveLinkTarget(value, candidates);
    if (targetId === value) continue; // already an id
    if (targetId === null) {
      plan.leftAlone.push({ ...row, value, reason: "no-match" });
      continue;
    }
    // Core writes config with JSON.stringify (serializeConfig). When the stored
    // text is exactly that, re-serializing with the new id changes the bytes of
    // the itemType value and nothing else; any other form (whitespace, number
    // spellings, duplicate keys) is left for an operator.
    if (JSON.stringify(parsed) !== row.config) {
      plan.leftAlone.push({ ...row, value, reason: "not-canonical" });
      continue;
    }
    plan.rewrites.push({ ...row, value, targetId, newConfig: JSON.stringify({ ...parsed, itemType: targetId }) });
  }
  return plan;
}

/** JSON.parse that yields a plain object or null (never throws). */
function parseObject(stored: string): Record<string, unknown> | null {
  if (!stored) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Applies the planned rewrites: one UPDATE per row, of the `config` column
 * only, and only while the plan still holds at the moment of the write — the
 * row keeps the config the plan read, and the target type still exists in the
 * bundle under that name. A row whose plan went stale (say a schema edit during
 * the backup) is skipped and reconsidered on the next start. Returns the number
 * of rows changed.
 */
export async function applyLinkTargetPlan(db: Db, plan: LinkTargetPlan): Promise<number> {
  const { properties, itemTypes } = db.tables;
  let changed = 0;
  for (const r of plan.rewrites) {
    const targetStillNamed = db.client
      .select({ one: sql`1` })
      .from(itemTypes)
      .where(and(eq(itemTypes.id, r.targetId), eq(itemTypes.bundleId, r.bundleId), eq(itemTypes.name, r.value)));
    const res = await db.client
      .update(properties)
      .set({ config: r.newConfig })
      .where(and(eq(properties.id, r.propertyId), eq(properties.config, r.config), exists(targetStillNamed)))
      .returning({ id: properties.id });
    changed += res.length;
  }
  return changed;
}

const LEFT_ALONE_WHY: Record<LeftAloneReason, (r: LinkTargetRow) => string> = {
  unreadable: (r) => `config ${JSON.stringify(r.config)} has no readable itemType`,
  "not-canonical": (r) => `config ${JSON.stringify(r.config)} is not in the form Core writes, so it was not rewritten`,
  "no-match": (r) => `config.itemType ${JSON.stringify(r.value)} matches no single item type in its bundle`,
};

export interface UpgradeLinkTargetsOpts {
  logger: Pick<YapLogger, "info" | "warn">;
  /** Runs once, before the first row is rewritten, only when there is something to rewrite
   *  (serve.ts takes its pre-migration backup here). A throw aborts the upgrade untouched. */
  beforeRewrite?: () => Promise<void>;
}

/**
 * The startup step: plan, optionally back up, rewrite unambiguous name-valued
 * links to ids, and log the rows left alone so an operator can fix them with
 * update_property. Safe to run on every start: rows that hold ids are never
 * touched, so a second run changes nothing.
 */
export async function upgradeLinkTargets(db: Db, opts: UpgradeLinkTargetsOpts): Promise<LinkTargetPlan> {
  const plan = await planLinkTargetUpgrade(db);
  if (plan.rewrites.length > 0) {
    await opts.beforeRewrite?.();
    const changed = await applyLinkTargetPlan(db, plan);
    opts.logger.info(`link targets: stored ${changed} link propert${changed === 1 ? "y's" : "ies'"} target item type by id`);
  }
  for (const r of plan.leftAlone) {
    const why = LEFT_ALONE_WHY[r.reason](r);
    opts.logger.warn(
      `link targets: left alone — bundle ${JSON.stringify(r.bundleName)} (${r.bundleId}), ` +
        `item type ${JSON.stringify(r.itemTypeName)}, property ${JSON.stringify(r.propertyName)} (${r.propertyId}): ` +
        `${why}; set its target with update_property`,
    );
  }
  return plan;
}
