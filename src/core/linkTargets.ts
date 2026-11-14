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
 * src/serve.ts), and leaves alone, and logs, any row whose value it cannot
 * resolve unambiguously. Item writes still fall back to a name lookup for
 * exactly those leftover rows (resolveItemType in bundles.ts).
 */
import { and, eq, inArray } from "drizzle-orm";

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
  if (config?.itemType === undefined || config.itemType === null) return config;
  const id = resolveLinkTarget(config.itemType, candidates);
  if (id === null) throw invalid(unknownLinkTargetMessage(propertyName, config.itemType));
  return { ...config, itemType: id };
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
  /** The stored `config.itemType` value. */
  value: string;
}

export interface LinkTargetRewrite extends LinkTargetRow {
  /** The id the value resolves to. */
  targetId: string;
  /** The new `config` column: the stored JSON with only `itemType` changed. */
  newConfig: string;
}

export interface LinkTargetPlan {
  rewrites: LinkTargetRewrite[];
  /** Name-valued links that match no item type (or more than one): left as they are. */
  leftAlone: LinkTargetRow[];
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
  const props = await db.client
    .select({
      propertyId: properties.id,
      propertyName: properties.name,
      itemTypeId: properties.itemTypeId,
      config: properties.config,
    })
    .from(properties)
    .where(eq(properties.datatype, "item"));
  const plan: LinkTargetPlan = { rewrites: [], leftAlone: [] };
  if (props.length === 0) return plan;

  const owners = await db.client
    .select({ id: itemTypes.id, bundleId: itemTypes.bundleId, name: itemTypes.name })
    .from(itemTypes)
    .where(inArray(itemTypes.id, [...new Set(props.map((p) => p.itemTypeId))]));
  const ownerById = new Map(owners.map((t) => [t.id, t]));
  const bundleIds = [...new Set(owners.map((t) => t.bundleId))];
  const bundleTypes = bundleIds.length
    ? await db.client
        .select({ id: itemTypes.id, bundleId: itemTypes.bundleId, name: itemTypes.name })
        .from(itemTypes)
        .where(inArray(itemTypes.bundleId, bundleIds))
    : [];
  const bundleRows = bundleIds.length
    ? await db.client.select({ id: bundles.id, name: bundles.name }).from(bundles).where(inArray(bundles.id, bundleIds))
    : [];
  const bundleName = new Map(bundleRows.map((b) => [b.id, b.name]));
  const typesByBundle = new Map<string, LinkTargetCandidate[]>();
  for (const t of bundleTypes) {
    typesByBundle.set(t.bundleId, [...(typesByBundle.get(t.bundleId) ?? []), { id: t.id, name: t.name }]);
  }

  for (const p of props) {
    const parsed = parseObject(p.config);
    const value = parsed?.itemType;
    if (typeof value !== "string") continue; // no pin (or not one this rule can read)
    const owner = ownerById.get(p.itemTypeId);
    if (!owner) continue;
    const candidates = typesByBundle.get(owner.bundleId) ?? [];
    if (candidates.some((c) => c.id === value)) continue; // already an id
    const row: LinkTargetRow = {
      propertyId: p.propertyId,
      propertyName: p.propertyName,
      itemTypeId: owner.id,
      itemTypeName: owner.name,
      bundleId: owner.bundleId,
      bundleName: bundleName.get(owner.bundleId) ?? "",
      config: p.config,
      value,
    };
    const byName = candidates.filter((c) => c.name === value);
    if (byName.length !== 1) {
      plan.leftAlone.push(row);
      continue;
    }
    const targetId = byName[0]!.id;
    plan.rewrites.push({ ...row, targetId, newConfig: JSON.stringify({ ...parsed, itemType: targetId }) });
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
 * only, and only while the row still holds the config the plan read (a row
 * changed in between is skipped, and picked up by the next run). Returns the
 * number of rows changed.
 */
export async function applyLinkTargetPlan(db: Db, plan: LinkTargetPlan): Promise<number> {
  const { properties } = db.tables;
  let changed = 0;
  for (const r of plan.rewrites) {
    const res = await db.client
      .update(properties)
      .set({ config: r.newConfig })
      .where(and(eq(properties.id, r.propertyId), eq(properties.config, r.config)))
      .returning({ id: properties.id });
    changed += res.length;
  }
  return changed;
}

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
    opts.logger.warn(
      `link targets: left alone — bundle ${JSON.stringify(r.bundleName)} (${r.bundleId}), ` +
        `item type ${JSON.stringify(r.itemTypeName)}, property ${JSON.stringify(r.propertyName)} (${r.propertyId}): ` +
        `config.itemType ${JSON.stringify(r.value)} matches no single item type in its bundle; ` +
        `fix it with update_property`,
    );
  }
  return plan;
}
