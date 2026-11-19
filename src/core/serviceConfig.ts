/**
 * A service's config, stored in two parts.
 *
 * A driver that publishes a config schema (see drivers/schema.ts) names the
 * paths in its config that hold secrets. Core uses that list to keep a
 * service's config as:
 *
 * - **settings**: the config with every secret path taken out. Stored as plain
 *   JSON in `services.settings` and returned to the service's authors (callers
 *   holding `edit_services`), so an author can read what a service does and
 *   edit it without retyping its credentials.
 * - **secrets**: only the values at secret paths, as a sparse object of the
 *   same shape. AES-256-GCM-encrypted in `services.secrets_encrypted` and
 *   write-only: a read reports which secret paths are set, never a value.
 *
 * At run time the two are merged back into one config object, so a driver
 * sees exactly what it saw before the split and does not change.
 *
 * The whole config is also still written, encrypted, to the older
 * `services.config_encrypted` column, so the column every earlier release reads
 * stays current and an instance can roll back to one. A driver without a
 * schema keeps its whole config in that column only, as before: it runs, it is
 * not readable, and its settings column stays null.
 *
 * Services authored before the split are split at boot by
 * `backfillServiceConfigs`; see the bottom of this file.
 */
import { isDeepStrictEqual } from "node:util";

import { and, eq, isNull } from "drizzle-orm";

import { decryptSecret, encryptSecret } from "../crypto.js";
import type { Db } from "../db/index.js";
import type { YapLogger } from "../logger.js";
import type { DriverRegistry } from "./drivers/registry.js";
import type { DriverDefinition } from "./drivers/types.js";

export type ConfigObject = Record<string, unknown>;

/** One value found at a secret path: the concrete keys that lead to it. */
interface SecretLeaf {
  path: string[];
  value: unknown;
}

/** Thrown when a config cannot be split safely; the message names the path. */
export class UnsplittableConfig extends Error {}

function isPlainObject(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sets an own property, even one named `__proto__` (JSON.parse makes those
 * own keys, and a plain assignment would change the object's prototype). */
function setOwn(target: ConfigObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Moves every value at a secret path out of `node` and reports it. `*` matches
 * every key of a map. A null on the way down holds nothing and is passed over;
 * any other non-object on the way down means the config does not have the
 * shape the schema describes, so the split stops rather than guessing whether
 * that value is a secret.
 */
function takeLeaves(node: ConfigObject, segments: string[], at: string[], leaves: SecretLeaf[]): void {
  const [head, ...rest] = segments;
  const keys = head === "*" ? Object.keys(node) : Object.hasOwn(node, head!) ? [head!] : [];
  for (const key of keys) {
    const value = node[key];
    const path = [...at, key];
    if (rest.length === 0) {
      leaves.push({ path, value });
      delete node[key];
      continue;
    }
    if (value === null || value === undefined) continue;
    if (!isPlainObject(value)) {
      throw new UnsplittableConfig(`config.${path.join(".")} must be an object, as the driver's config schema describes`);
    }
    takeLeaves(value, rest, path, leaves);
  }
}

/** Own properties only: `node["__proto__"]` would otherwise read Object.prototype. */
function own(node: ConfigObject, key: string): unknown {
  return Object.hasOwn(node, key) ? node[key] : undefined;
}

function setAt(target: ConfigObject, path: string[], value: unknown): void {
  let node = target;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(own(node, key))) setOwn(node, key, {});
    node = node[key] as ConfigObject;
  }
  setOwn(node, path[path.length - 1]!, value);
}

/** Whether every key of `path` leads to a plain object in `node`. */
function objectAt(node: ConfigObject, path: string[]): boolean {
  let at: unknown = node;
  for (const key of path) {
    if (!isPlainObject(at)) return false;
    at = own(at, key);
  }
  return isPlainObject(at);
}

/** Removes the value at `path`, and any parent objects that become empty. */
function deleteAt(target: ConfigObject, path: string[]): void {
  const [head, ...rest] = path;
  if (!Object.hasOwn(target, head!)) return;
  if (rest.length === 0) {
    delete target[head!];
    return;
  }
  const child = target[head!];
  if (!isPlainObject(child)) return;
  deleteAt(child, rest);
  if (Object.keys(child).length === 0) delete target[head!];
}

/** The schema's secret paths, shortest first: when one path contains another
 * (`auth` and `auth.password`), the outer one takes the whole subtree and the
 * inner one then finds nothing left, so no value is split twice. */
function secretPaths(def: DriverDefinition): string[][] {
  return (def.configSchema?.secrets ?? []).map((s) => s.path.split(".")).sort((a, b) => a.length - b.length);
}

function leavesOf(config: ConfigObject, def: DriverDefinition): { rest: ConfigObject; leaves: SecretLeaf[] } {
  const rest = clone(config);
  const leaves: SecretLeaf[] = [];
  for (const segments of secretPaths(def)) takeLeaves(rest, segments, [], leaves);
  return { rest, leaves };
}

/** The driver's config schema decides how its services' configs are stored. */
export function splitsConfig(def: DriverDefinition | undefined): def is DriverDefinition {
  return def?.configSchema !== undefined;
}

/**
 * Splits a whole config into settings and secrets, exactly: merging the two
 * parts back gives an object deep-equal to the input. Throws
 * `UnsplittableConfig` when it cannot.
 */
export function splitConfig(def: DriverDefinition, config: unknown): { settings: ConfigObject; secrets: ConfigObject } {
  if (!isPlainObject(config)) throw new UnsplittableConfig("config must be a JSON object");
  const { rest, leaves } = leavesOf(config, def);
  const secrets: ConfigObject = {};
  for (const leaf of leaves) setAt(secrets, leaf.path, leaf.value);
  if (!isDeepStrictEqual(mergeConfig(rest, secrets), config)) {
    // Not reachable for a JSON object as far as the walk above goes; kept so a
    // config that would not come back whole is never stored in two parts.
    throw new UnsplittableConfig("config does not split cleanly into settings and secrets");
  }
  return { settings: rest, secrets };
}

/** Settings and secrets merged into the one config a driver receives. */
export function mergeConfig(settings: ConfigObject, secrets: ConfigObject): ConfigObject {
  const out = clone(settings);
  const fold = (target: ConfigObject, source: ConfigObject): void => {
    for (const [key, value] of Object.entries(source)) {
      const existing = own(target, key);
      if (isPlainObject(existing) && isPlainObject(value)) fold(existing, value);
      else setOwn(target, key, clone(value));
    }
  };
  fold(out, secrets);
  return out;
}

/** The secret paths that hold a value, as dot paths with map keys spelled out, sorted. */
export function secretsSet(def: DriverDefinition | undefined, secrets: ConfigObject): string[] {
  if (!splitsConfig(def)) return listLeafPaths(secrets);
  try {
    return leavesOf(secrets, def)
      .leaves.filter((leaf) => leaf.value !== null && leaf.value !== undefined)
      .map((leaf) => leaf.path.join("."))
      .sort();
  } catch {
    // Stored under an earlier schema whose shape this one contradicts; the
    // next boot re-splits it (see backfillServiceConfigs). Still only paths.
    return listLeafPaths(secrets);
  }
}

/** Fallback for a driver that is no longer installed: every leaf of the stored secrets. */
function listLeafPaths(node: ConfigObject, at: string[] = []): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (isPlainObject(value) && Object.keys(value).length > 0) out.push(...listLeafPaths(value, [...at, key]));
    else if (value !== null && value !== undefined) out.push([...at, key].join("."));
  }
  return out.sort();
}

/**
 * What an author's write does to a service's config, for a driver with a
 * schema. The config given is split; its settings replace the stored settings
 * whole. Its secrets are applied one path at a time on top of the stored ones
 * (`stored` null = none): a value sets that secret, null removes it, and a
 * secret the write does not mention is kept as long as the object that holds
 * it is still in the new settings. Leaving out (or nulling) the whole object
 * removes the secrets inside it too, which is how an author drops a block:
 * a mail service moving from `oauth2` to `pass` sends no `oauth2`. `kept`
 * names the stored secrets that were carried over, so a refusal can say why a
 * config the author did not send in full is being checked.
 */
export function applyConfigWrite(
  def: DriverDefinition,
  config: unknown,
  stored: ConfigObject | null,
): { settings: ConfigObject; secrets: ConfigObject; merged: ConfigObject; kept: string[] } {
  if (!isPlainObject(config)) throw new UnsplittableConfig("config must be a JSON object");
  const { rest: settings, leaves } = leavesOf(config, def);
  const secrets = clone(stored ?? {});
  const touched = new Set<string>();
  for (const leaf of leaves) {
    touched.add(leaf.path.join("."));
    if (leaf.value === null || leaf.value === undefined) deleteAt(secrets, leaf.path);
    else setAt(secrets, leaf.path, clone(leaf.value));
  }
  for (const leaf of leavesOf(secrets, def).leaves) {
    if (!touched.has(leaf.path.join(".")) && !objectAt(settings, leaf.path.slice(0, -1))) {
      deleteAt(secrets, leaf.path);
    }
  }
  const kept = secretsSet(def, secrets).filter((path) => !touched.has(path));
  return { settings, secrets, merged: mergeConfig(settings, secrets), kept };
}

// ---- Stored columns --------------------------------------------------------

/** The three config columns of a service row. */
export interface StoredConfigColumns {
  configEncrypted: string;
  /** JSON settings; null while the config is one sealed blob. */
  settings: string | null;
  secretsEncrypted: string | null;
}

/** True once a service's config is stored in two parts. */
export function isSplit(row: StoredConfigColumns): boolean {
  return row.settings !== null && row.secretsEncrypted !== null;
}

/** The stored parts of a split service. Only call when `isSplit(row)`. */
export function readParts(row: StoredConfigColumns, masterKey: Buffer): { settings: ConfigObject; secrets: ConfigObject } {
  return {
    settings: JSON.parse(row.settings!) as ConfigObject,
    secrets: JSON.parse(decryptSecret(row.secretsEncrypted!, masterKey)) as ConfigObject,
  };
}

/**
 * The config a run hands its driver: settings and secrets merged for a split
 * service, the whole blob otherwise. In memory, for the run only.
 */
export function configForRun(row: StoredConfigColumns, masterKey: Buffer): unknown {
  if (!isSplit(row)) return JSON.parse(decryptSecret(row.configEncrypted, masterKey));
  const { settings, secrets } = readParts(row, masterKey);
  return mergeConfig(settings, secrets);
}

/** The column values for a config held in two parts (the whole blob stays in step). */
export function splitColumns(
  parts: { settings: ConfigObject; secrets: ConfigObject; merged: ConfigObject },
  masterKey: Buffer,
): StoredConfigColumns {
  return {
    configEncrypted: encryptSecret(JSON.stringify(parts.merged), masterKey),
    settings: JSON.stringify(parts.settings),
    secretsEncrypted: encryptSecret(JSON.stringify(parts.secrets), masterKey),
  };
}

/** The column values for a config kept as one sealed blob (a driver without a schema). */
export function blobColumns(config: unknown, masterKey: Buffer): StoredConfigColumns {
  return { configEncrypted: encryptSecret(JSON.stringify(config), masterKey), settings: null, secretsEncrypted: null };
}

// ---- Boot backfill ----------------------------------------------------------

/** Why the backfill left a service's config as it was. */
export type BackfillSkipReason = "driver-missing" | "no-schema" | "undecryptable" | "unparseable" | "does-not-fit";

export interface BackfillSkip {
  id: string;
  name: string;
  bundleId: string;
  driver: string;
  reason: BackfillSkipReason;
  /** For `does-not-fit`: which path broke the split. Never a value. */
  detail?: string;
}

export interface BackfillResult {
  /** Sealed services split for the first time. */
  split: number;
  /** Split services whose parts were rebuilt from their sealed config. */
  resplit: number;
  skipped: BackfillSkip[];
}

export interface BackfillOpts {
  logger: Pick<YapLogger, "info" | "warn">;
  /** Runs once, before the first row is written, only when there is something
   * to split (serve.ts takes its pre-migration backup here). A throw aborts
   * the backfill with nothing written. */
  beforeWrite?: () => Promise<void>;
}

const SKIP_WHY: Record<BackfillSkipReason, (s: BackfillSkip) => string> = {
  "driver-missing": (s) => `driver "${s.driver}" is not installed`,
  "no-schema": (s) => `driver "${s.driver}" publishes no config schema, so the config stays one sealed blob`,
  undecryptable: () => "its config cannot be decrypted with the current YAP_MASTER_KEY",
  unparseable: () => "its decrypted config is not a JSON object",
  "does-not-fit": (s) => `its config does not fit the driver's config schema (${s.detail})`,
};

/** The sealed config as an object, or the reason it cannot be read as one. */
function openBlob(blob: string, masterKey: Buffer): ConfigObject | "undecryptable" | "unparseable" {
  let plaintext: string;
  try {
    plaintext = decryptSecret(blob, masterKey);
  } catch {
    return "undecryptable";
  }
  try {
    const config: unknown = JSON.parse(plaintext);
    return isPlainObject(config) ? config : "unparseable";
  } catch {
    return "unparseable";
  }
}

/**
 * The boot step. Every service whose driver publishes a schema has its sealed
 * config decrypted and split by that schema:
 *
 * - **Not yet split**: settings and secrets are written for the first time.
 * - **Already split, and the parts still match** what splitting the sealed
 *   config by the driver's current schema gives: never touched. That is every
 *   service this release wrote, so a second boot changes nothing.
 * - **Already split, but the parts no longer match**: the parts are rebuilt
 *   from the sealed config. Two things cause it. An earlier release (after a
 *   rollback) edited the service, writing only the sealed column; without this
 *   the edit would be lost and a removed credential would come back. Or the
 *   driver's secret paths changed; without this a newly secret field would
 *   stay readable in the settings.
 *
 * The sealed blob is never changed or deleted, so a service that cannot be
 * split runs exactly as before. Left alone, and logged: a service not yet split
 * whose driver is not installed or has no schema, or whose blob cannot be
 * decrypted, is not a JSON object, or has a non-object where the schema puts a
 * secret path through an object. Those are looked at again on the next boot,
 * so a driver that later ships a schema gets its services split then. A split
 * service whose driver lost its schema or is gone keeps running from its parts.
 *
 * Each write lands only while the row still holds exactly the columns read.
 */
export async function backfillServiceConfigs(
  db: Db,
  registry: DriverRegistry,
  masterKey: Buffer,
  opts: BackfillOpts,
): Promise<BackfillResult> {
  const { services } = db.tables;
  const rows = await db.client
    .select({
      id: services.id,
      name: services.name,
      bundleId: services.bundleId,
      driver: services.driver,
      configEncrypted: services.configEncrypted,
      settings: services.settings,
      secretsEncrypted: services.secretsEncrypted,
    })
    .from(services);

  const planned: Array<{ row: (typeof rows)[number]; settings: string; secretsEncrypted: string }> = [];
  const skipped: BackfillSkip[] = [];
  for (const row of rows) {
    const split = isSplit(row);
    const skip = (reason: BackfillSkipReason, detail?: string): void => {
      skipped.push({ id: row.id, name: row.name, bundleId: row.bundleId, driver: row.driver, reason, detail });
    };
    const def = registry.has(row.driver) ? registry.get(row.driver) : undefined;
    if (!def || !splitsConfig(def)) {
      if (!split) skip(def ? "no-schema" : "driver-missing");
      continue;
    }
    const config = openBlob(row.configEncrypted, masterKey);
    if (typeof config === "string") {
      skip(config);
      continue;
    }
    let parts: { settings: ConfigObject; secrets: ConfigObject };
    try {
      parts = splitConfig(def, config);
    } catch (err) {
      if (!(err instanceof UnsplittableConfig)) throw err;
      skip("does-not-fit", err.message);
      continue;
    }
    if (split) {
      let current: { settings: ConfigObject; secrets: ConfigObject } | null = null;
      try {
        current = readParts(row, masterKey);
      } catch {
        // Unreadable parts: rebuilt from the sealed config below.
      }
      if (current && isDeepStrictEqual(current, parts)) continue;
    }
    planned.push({
      row,
      settings: JSON.stringify(parts.settings),
      secretsEncrypted: encryptSecret(JSON.stringify(parts.secrets), masterKey),
    });
  }

  let split = 0;
  let resplit = 0;
  if (planned.length > 0) {
    await opts.beforeWrite?.();
    for (const p of planned) {
      const { row } = p;
      // Only the two part columns are written: the blob stays byte-identical.
      const res = await db.client
        .update(services)
        .set({ settings: p.settings, secretsEncrypted: p.secretsEncrypted })
        .where(
          and(
            eq(services.id, row.id),
            eq(services.configEncrypted, row.configEncrypted),
            row.settings === null ? isNull(services.settings) : eq(services.settings, row.settings),
            row.secretsEncrypted === null
              ? isNull(services.secretsEncrypted)
              : eq(services.secretsEncrypted, row.secretsEncrypted),
          ),
        )
        .returning({ id: services.id });
      if (res.length === 0) continue;
      if (isSplit(row)) {
        resplit++;
        opts.logger.warn(
          `service configs: rebuilt settings and secrets of service ${JSON.stringify(row.name)} (${row.id}) in bundle ` +
            `${row.bundleId} from its sealed config, which they no longer matched (an earlier release edited it, ` +
            `or driver "${row.driver}" changed its secret paths)`,
        );
      } else split++;
    }
    if (split > 0) {
      opts.logger.info(`service configs: split ${split} service${split === 1 ? "" : "s"} into settings and secrets`);
    }
  }
  for (const s of skipped) {
    const line =
      `service configs: left alone — service ${JSON.stringify(s.name)} (${s.id}) in bundle ${s.bundleId}: ` +
      `${SKIP_WHY[s.reason](s)}`;
    // A driver without a schema is a supported, permanent state; the rest want an operator's look.
    if (s.reason === "no-schema") opts.logger.info(line);
    else opts.logger.warn(line);
  }
  return { split, resplit, skipped };
}
