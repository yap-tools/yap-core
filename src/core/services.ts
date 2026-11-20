/**
 * Services: the bundle-owned, named capabilities agents can run. A service is
 * a driver plus the configuration that driver needs, and the two halves have
 * very different visibility — which is the whole security model, inherited
 * from hooks.ts:
 *
 * - Visible to any reader of the bundle: id, name, description, driver, and
 *   the *callable* parameters of each action. That is what an agent needs to
 *   compose a call and nothing more.
 * - Never returned by any surface: the config's secrets. A driver that
 *   publishes a config schema has its services' configs stored in two parts
 *   (serviceConfig.ts): *settings*, every non-secret field, readable by the
 *   service's authors (`edit_services`) and by no one else; and *secrets*,
 *   AES-256-GCM-encrypted at rest and write-only, of which a read shows only
 *   which paths are set. A driver without a schema keeps its whole config as
 *   one sealed blob, readable by nobody. Either way the full config is
 *   decrypted only in memory inside a run.
 * - An author's config write replaces the settings and merges the secrets: a
 *   secret the write leaves out is kept, null removes one. So an author who
 *   reads a service's settings and sends them back edited does not wipe its
 *   credentials.
 * - Pins are configuration, not parameters: a pinned value is stripped from
 *   every listing (an agent cannot even learn a pin's name is fixed by probing
 *   the listing) and merged in by the runner after the caller's half has been
 *   validated.
 * - An action allowlist narrows the driver: a service may expose some of its
 *   driver's actions rather than all of them (a read-only mail service, say).
 *   A disabled action is absent from every listing and unknown to the runner
 *   — an agent cannot learn it exists. Null means no allowlist: every action
 *   the driver declares, which is what every service authored before the
 *   column existed means.
 *
 * Authoring is gated by `edit_services` and happens on two surfaces. Over
 * REST an author sends the whole config, secrets included. Over MCP an agent
 * sends the settings only (`authoring: "mcp"`): a secret value in them is
 * refused, a driver without a config schema cannot be authored there at all,
 * and the secrets are entered by a human through a one-off form
 * (secretRequests.ts), so they never pass through the agent.
 *
 * A service written over MCP does not run until a person approves it
 * (serviceApprovals.ts): a service can send data out of the instance, and an
 * agent can be steered by something it read. An MCP create leaves it waiting;
 * an MCP update that changes what it does or where data goes puts it back to
 * waiting; a REST write counts as approved, since its author sent the whole
 * config — unless it came with a scoped access key, which is a machine
 * standing in for its user and never their approval, so it is held to the
 * MCP rule (and any config it sends waits too). Entering secrets through the form leaves the approval as it is. The
 * runner refuses a service that waits (runs.ts, `prepareRun`), so a run and a
 * schedule both do.
 *
 * A run writes to its bundle with the service's authority, not the runner's:
 * the bundle writer below skips the `edit_items` / `edit_files` check. That
 * holds because the author vouched for those writes: creating or changing a
 * service whose driver declares `writes.items` needs `edit_items` on the
 * bundle, and `writes.files` needs `edit_files`, on both surfaces. Holding
 * `edit_services` alone is not enough to give a service write access the
 * author does not have.
 *
 * Authoring-time validation is deliberately strict, because everything it
 * rejects would otherwise fail (or silently misbehave) much later, at fire
 * time, in front of an agent:
 *
 * - The driver must be installed on this server.
 * - Param specs follow the same name rule the driver registry enforces.
 * - A pin must name a declared parameter and hold a scalar — the runner
 *   `String()`s pinned values blindly, so an object pin would reach a driver
 *   as "[object Object]".
 * - An allowlist must name actions the driver declares, each once, and at
 *   least one of them — a service with nothing to run is not something an
 *   author means to create. (A stored allowlist can still go stale when a
 *   driver upgrade renames an action; `allowedActions` is lenient about that
 *   where authoring is strict.)
 * - `validateConfig` is the driver's own offline check; `validateConfigOnline`
 *   is the network-touching one (the http driver's SSRF pre-check lives
 *   there). Both run at create, and again whenever the config changes. The
 *   detailed guard message is kept intact here on purpose: authoring is an
 *   operator-facing surface, and the operator is precisely who needs to know
 *   which address was refused.
 */
import { Buffer } from "node:buffer";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import type { BlobStore } from "../blob/index.js";
import type { YapConfig } from "../config.js";
import { decryptSecret } from "../crypto.js";
import type { Db } from "../db/index.js";
import {
  getBundleContext,
  hasBundleCapability,
  requireBundleCapability,
  requireBundleReadAccess,
} from "./bundles.js";
import { createEgress } from "./drivers/egress.js";
import { PARAM_NAME, type DriverRegistry } from "./drivers/registry.js";
import type { BundleReader, BundleWriter, DriverDefinition, DriverReads } from "./drivers/types.js";
import { onScopedKey } from "./authScope.js";
import { forbidden, invalid, notFound, tooLarge, YapError } from "./errors.js";
import { parseFileRef } from "./fileRefs.js";
import { writeFileUnchecked, type FileWriteInput } from "./files.js";
import { createItemsUnchecked, getItemsUnchecked, updateItemsUnchecked, type ItemUpdateInput } from "./items.js";
import {
  applyConfigWrite,
  blobColumns,
  dropMovedSecrets,
  isSplit,
  pendingSecretCandidates,
  readParts,
  secretValuesIn,
  secretsSet,
  splitColumns,
  splitConfig,
  splitsConfig,
  UnsplittableConfig,
  type ConfigObject,
  type StoredConfigColumns,
} from "./serviceConfig.js";
import type { Resolver } from "./ssrf.js";
import { newId, nowIso } from "./util.js";

/** A service that names no driver gets the built-in one (what every hook was —
 *  legacyHooks.ts shares this constant rather than repeating the literal). */
export const DEFAULT_DRIVER = "http";

// Defined once: the zod schema validates the REST authoring boundary and the
// TypeScript type is inferred from it, so the public surface and the runner
// that consumes it cannot drift. The name rule is enforced semantically by
// validateParamSpecs (mirrors hooks.ts).
export const serviceParamSpecSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
});
export type ServiceParamSpec = z.infer<typeof serviceParamSpecSchema>;

/**
 * A pin's fixed value. Scalars only, and for the same reason `validatePins`
 * enforces it at runtime: the runner `String()`s a pinned value blindly, so an
 * object pin would reach a driver as "[object Object]".
 */
export type ServicePins = Record<string, string | number | boolean>;

export interface ServiceActionInfo {
  name: string;
  description: string;
  /** Effective specs: the action's own if it declares them, else the
   *  service's — pinned names removed either way. */
  params: ServiceParamSpec[];
}

/** Agent-visible service listing: never includes the config. */
export interface ServiceInfo {
  id: string;
  name: string;
  description: string;
  driver: string;
  actions: ServiceActionInfo[];
  /** False while the service waits for a person's approval: it was written or
   *  changed over MCP, and it does not run until approved (serviceApprovals.ts). */
  approved: boolean;
}

/**
 * What a service's authors (callers holding `edit_services` on its bundle)
 * see: the listing plus the readable half of the config. Never a secret value.
 */
export interface ServiceAuthorInfo extends ServiceInfo {
  /** The parameter specs stored on the service record (what `params` was set to). */
  params: ServiceParamSpec[];
  /** The pinned values: configuration an author set, stripped from every
   *  agent-facing listing. Returned so an author can change them without
   *  wiping the ones already there (a write replaces the set whole). */
  pins: ServicePins;
  /** The config without its secrets; null while the config is one sealed
   *  blob (its driver publishes no schema, or the boot split skipped it). */
  settings: Record<string, unknown> | null;
  /** The secret paths that hold a value (map keys spelled out, e.g.
   *  `headers.Authorization`), sorted; null exactly when `settings` is. */
  secretsSet: string[] | null;
  /** When a person last approved the service as it stands; null while it waits. */
  approvedAt: string | null;
  /** The user id of who approved it (a REST author, or the approve page's login). */
  approvedBy: string | null;
}

export interface ServiceEnv {
  db: Db;
  config: YapConfig;
  registry: DriverRegistry;
  resolver?: Resolver;
}

interface ServiceRow {
  id: string;
  bundleId: string;
  name: string;
  description: string;
  driver: string;
  params: string;
  pins: string;
  /** JSON array of action names, or null for every action the driver declares. */
  actions: string | null;
  settings: string | null;
  secretsEncrypted: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
}

// ---- Validation -------------------------------------------------------------

function validateParamSpecs(params: ServiceParamSpec[]): void {
  if (!Array.isArray(params)) throw invalid("service params must be an array of parameter specs");
  const seen = new Set<string>();
  for (const param of params) {
    if (!param || typeof param !== "object") throw invalid("each service parameter spec must be an object");
    if (!param.name || !PARAM_NAME.test(param.name)) {
      throw invalid(`invalid service parameter name ${JSON.stringify(param.name)}`);
    }
    if (seen.has(param.name)) throw invalid(`duplicate service parameter "${param.name}"`);
    seen.add(param.name);
  }
}

/**
 * Every parameter name this service could ever pass to its driver: the specs
 * on the record (which an action declaring `params: null` adopts) plus the
 * specs the driver's actions declare themselves — the union of what
 * `declaredSpecs` would return for each action. A pin outside that set names
 * nothing and would be injected into a call no action understands.
 */
function declaredNames(def: DriverDefinition, params: ServiceParamSpec[]): string[] {
  const names = new Set(params.map((p) => p.name));
  for (const action of Object.keys(def.actions)) {
    for (const spec of declaredSpecs(def, action, params)) names.add(spec.name);
  }
  return [...names];
}

function validatePins(pins: Record<string, unknown>, declared: string[]): void {
  if (typeof pins !== "object" || pins === null || Array.isArray(pins)) {
    throw invalid("service pins must be an object of parameter name → fixed value");
  }
  for (const [name, value] of Object.entries(pins)) {
    if (!declared.includes(name)) {
      throw invalid(
        `pinned parameter "${name}" is not declared by this service (declared: ${declared.join(", ") || "none"})`,
      );
    }
    // The runner String()s a pin without looking; anything but a scalar would
    // reach the driver mangled rather than rejected.
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw invalid(`pinned parameter "${name}" must be a string, number, or boolean`);
    }
  }
}

/**
 * The authoring-time rule for an allowlist: a non-empty array of distinct
 * names, each an action the driver declares. Strict on purpose — a name the
 * driver does not know would silently vanish from the service (see
 * `allowedActions`), and an author deserves to hear about the typo now.
 */
function validateActions(def: DriverDefinition, actions: string[]): void {
  if (!Array.isArray(actions) || actions.length === 0 || actions.some((a) => typeof a !== "string")) {
    throw invalid("service actions must be a non-empty array of action names");
  }
  const declared = Object.keys(def.actions);
  const duplicate = actions.find((name, i) => actions.indexOf(name) !== i);
  if (duplicate !== undefined) throw invalid(`duplicate action "${duplicate}"`);
  const unknown = actions.find((name) => !declared.includes(name));
  if (unknown !== undefined) {
    throw invalid(`unknown action "${unknown}" for driver "${def.name}" (declared: ${declared.join(", ") || "none"})`);
  }
}

function requireDriver(registry: DriverRegistry, name: string): DriverDefinition {
  if (!registry.has(name)) {
    const installed = registry
      .list()
      .map((d) => d.name)
      .join(", ");
    throw invalid(`unknown driver "${name}" (installed: ${installed || "none"})`);
  }
  return registry.get(name);
}

/**
 * Runs the driver's own config checks. A driver is trusted code but its
 * validators throw plain Errors naming the offending field, so anything that
 * is not already a YapError is wrapped into an `invalid_request` — an author
 * typo must not read as a server fault.
 */
async function validateDriverConfig(
  env: ServiceEnv,
  def: DriverDefinition,
  config: unknown,
  kept: string[] = [],
): Promise<void> {
  const wrap = (err: unknown): never => configError(def, err, keptNote(kept));
  try {
    def.validateConfig(config);
  } catch (err) {
    wrap(err);
  }
  await validateOnline(env, def, config, wrap);
}

/** When stored secrets were carried into the config being checked, say so: the
 * driver's complaint may be about a secret the author never sent this time. */
function keptNote(kept: string[]): string {
  return kept.length
    ? ` (checked with the stored secrets this write left out: ${kept.join(", ")}; set a secret path to null to remove it)`
    : "";
}

function configError(def: DriverDefinition, err: unknown, note: string): never {
  // A driver's own YapError (the http SSRF guard, the mail driver's field
  // check) keeps its code and wording; the note is only added to it.
  if (err instanceof YapError) throw note ? new YapError(err.code, `${err.message}${note}`, err.details) : err;
  throw invalid(`invalid config for driver "${def.name}": ${String((err as Error | undefined)?.message ?? err)}${note}`);
}

/**
 * Which of a config's missing secrets it needs to be valid, by the driver's
 * offline check alone. Empty when the config is valid as it is. Otherwise the
 * check is run with placeholders where secrets go (see
 * `pendingSecretCandidates`), and the first way of filling them in that the
 * driver accepts is the answer. Throws the driver's refusal, saying which
 * secrets were treated as filled in, when no way works.
 *
 * The config as it is comes first on purpose: a mail service with a complete
 * `oauth2` block never has a `pass`, and must not count as lacking one.
 */
export function neededSecrets(def: DriverDefinition, config: ConfigObject, kept: string[] = []): string[] {
  let asIs: unknown;
  try {
    def.validateConfig(config);
    return [];
  } catch (err) {
    asIs = err;
  }
  const { pending, candidates } = pendingSecretCandidates(def, config);
  if (pending.length === 0) return configError(def, asIs, keptNote(kept));
  let firstError: unknown;
  for (const candidate of candidates) {
    if (candidate.filled.length === 0) continue; // the config as it is, already tried
    try {
      def.validateConfig(candidate.config);
      return candidate.filled;
    } catch (err) {
      firstError ??= err;
    }
  }
  return configError(
    def,
    firstError ?? asIs,
    `${keptNote(kept)} (checked as if the secrets not set yet were filled in: ${pending.join(", ")})`,
  );
}

/**
 * Checks a config some of whose secrets may not be set yet: they come later,
 * through a secret request. Returns the secrets it still needs.
 *
 * The driver's offline check runs at once (`neededSecrets`). Its online check
 * may need the real secrets to mean anything (the mail driver logs in), so it
 * runs only once the config needs none: at authoring when nothing is missing,
 * otherwise on the secret-form submission that completes it.
 */
export async function validatePendingConfig(
  env: ServiceEnv,
  def: DriverDefinition,
  config: ConfigObject,
  kept: string[] = [],
): Promise<string[]> {
  const needed = neededSecrets(def, config, kept);
  if (needed.length === 0) await validateOnline(env, def, config, (err) => configError(def, err, keptNote(kept)));
  return needed;
}

async function validateOnline(
  env: ServiceEnv,
  def: DriverDefinition,
  config: unknown,
  wrap: (err: unknown) => never,
): Promise<void> {
  if (!def.validateConfigOnline) return;
  // The online check needs a guarded door of its own — this is where the http
  // driver's authoring-time SSRF pre-check happens. The handle is ours, so it
  // is disposed here rather than by the driver.
  const egress = createEgress(env.config, env.resolver);
  try {
    await def.validateConfigOnline(config, egress);
  } catch (err) {
    wrap(err);
  } finally {
    await egress.dispose();
  }
}

/**
 * Checks a config write and returns the columns to store. For a driver with a
 * config schema the write is split and its secrets merged onto `stored` (see
 * `applyConfigWrite`), and the driver checks the merged config: the one its
 * runs will get. For a driver without one the config is checked and sealed
 * whole, as it always was.
 */
async function prepareConfigWrite(
  env: ServiceEnv,
  def: DriverDefinition,
  config: unknown,
  stored: ConfigObject | null,
  authoring: Authoring = "rest",
  /** For an MCP update: the stored settings, so secrets bound to a setting that changes are dropped. */
  previousSettings?: ConfigObject,
): Promise<StoredConfigColumns> {
  if (!splitsConfig(def)) {
    // Not reachable over MCP: requireMcpAuthorable refuses a schemaless driver first.
    await validateDriverConfig(env, def, config);
    return blobColumns(config, env.config.masterKey);
  }
  let write: ReturnType<typeof applyConfigWrite>;
  try {
    if (authoring === "mcp") {
      refuseSecretValues(def, config);
      // An agent cannot see a secret, but it could send one somewhere else by
      // changing where it goes: a secret bound to a changed setting is dropped
      // and has to be entered again through a secret form.
      if (stored && previousSettings) stored = dropMovedSecrets(def, previousSettings, config, stored).secrets;
    }
    write = applyConfigWrite(def, config, stored);
  } catch (err) {
    if (err instanceof UnsplittableConfig) throw invalid(`invalid config for driver "${def.name}": ${err.message}`);
    throw err;
  }
  if (authoring === "mcp") await validatePendingConfig(env, def, write.merged, write.kept);
  else await validateDriverConfig(env, def, write.merged, write.kept);
  return splitColumns(write, env.config.masterKey);
}

/**
 * Which surface a write comes from. "rest": the whole config, secrets and all,
 * checked whole. "mcp": settings only; a secret value in them is refused and
 * secrets not set yet are allowed, to be entered through a secret request.
 */
export type Authoring = "rest" | "mcp";

/** Over MCP a secret never travels with the settings: refuse any that does. */
function refuseSecretValues(def: DriverDefinition, settings: unknown): void {
  const found = secretValuesIn(def, settings);
  if (found.length === 0) return;
  throw invalid(
    `settings.${found[0]} holds a secret value (driver "${def.name}" marks ${found.length === 1 ? "it" : `${found.join(", ")}`} secret). ` +
      "Secrets are never sent through MCP: leave them out (null removes a stored one) and call secret_request, " +
      "which gives the user a one-off form that sends them straight to the server.",
  );
}

/**
 * The MCP authoring rule for a driver: it must publish a config schema, since
 * the schema is what tells settings from secrets. A driver without one keeps
 * its services' config as one sealed secret, authored over REST only.
 */
function requireMcpAuthorable(def: DriverDefinition): void {
  if (def.configSchema !== undefined) return;
  throw invalid(
    `driver "${def.name}" publishes no config schema, so its services keep their whole config as one sealed ` +
      "secret and can only be authored over REST",
  );
}

/**
 * A run writes to its bundle with the service's authority (see the bundle
 * writer), so whoever creates or changes a service vouches for those writes
 * and must hold the matching capability on the bundle themselves.
 */
export async function requireWriteCapabilities(
  db: Db,
  userId: string,
  def: DriverDefinition,
  ctx: Awaited<ReturnType<typeof getBundleContext>>,
): Promise<void> {
  const needs: Array<["items" | "files", "edit_items" | "edit_files"]> = [
    ["items", "edit_items"],
    ["files", "edit_files"],
  ];
  for (const [surface, capability] of needs) {
    if (def.writes?.[surface] !== true) continue;
    if (await hasBundleCapability(db, userId, capability, ctx)) continue;
    throw forbidden(
      `driver "${def.name}" writes ${surface} into the bundle when it runs, so authoring its services needs ` +
        `${capability} on the bundle as well as edit_services`,
    );
  }
}

/**
 * The secrets a config write merges onto: the stored secrets of a split
 * service, or those of a sealed blob that splits by the driver's schema (a
 * service the boot split has not reached). Null when there are none to keep,
 * and when the blob cannot be read or split, in which case the write replaces
 * the config whole, as every write did before the split.
 */
function storedSecrets(env: ServiceEnv, def: DriverDefinition, row: StoredConfigColumns): ConfigObject | null {
  try {
    if (isSplit(row)) return readParts(row, env.config.masterKey).secrets;
    return splitConfig(def, JSON.parse(decryptSecret(row.configEncrypted, env.config.masterKey))).secrets;
  } catch {
    return null;
  }
}

// ---- Listing ----------------------------------------------------------------

/**
 * The specs one action declares: its own if it has any, else the service
 * record's — which is what an action declaring `params: null` (the http
 * driver, whose parameters are whatever its template uses) means by null.
 */
function declaredSpecs(def: DriverDefinition, actionName: string, serviceParams: ServiceParamSpec[]): ServiceParamSpec[] {
  return (def.actions[actionName]?.params ?? serviceParams) as ServiceParamSpec[];
}

/**
 * The one computation of "what this action's parameters are", used by the
 * listing, by the runner's validation, and by the injection of pinned values —
 * three places that each used to spell it slightly differently.
 *
 * The semantics, per action:
 *
 * - **declared** = the action's own specs if it has any, else the service
 *   record's (see `declaredSpecs`).
 * - **callable** = declared minus every pinned name. A pin is configuration:
 *   it is stripped from the listing so an agent cannot even learn the name is
 *   fixed, and supplying it in a call is an error rather than a silent
 *   override.
 * - **pinned** = only those pins the action actually declares. A pin naming a
 *   parameter some *other* action declares is neither injected into this call
 *   nor blocking for it: injecting it would hand the driver an argument this
 *   action never asked for (and, for a template-substituting driver, one it
 *   cannot place), so for this action the name is simply not a parameter at
 *   all — supplying it reads as the ordinary "unknown parameter".
 *
 * Every driver shipped today has a single action, so on those the last rule is
 * a distinction without a difference; it is what makes a multi-action driver's
 * per-action parameter contract (see drivers/http.ts's header) honest.
 */
export function resolveActionParams(
  def: DriverDefinition,
  actionName: string,
  serviceParams: ServiceParamSpec[],
  pins: ServicePins,
): { callable: ServiceParamSpec[]; pinned: ServicePins } {
  const declared = declaredSpecs(def, actionName, serviceParams);
  const callable = declared.filter((spec) => !Object.hasOwn(pins, spec.name));
  const pinned: ServicePins = {};
  for (const spec of declared) {
    if (Object.hasOwn(pins, spec.name)) pinned[spec.name] = pins[spec.name]!;
  }
  return { callable, pinned };
}

/**
 * The actions a service actually has: its stored allowlist intersected with
 * what the driver declares, in the driver's order. This is the one place the
 * stored column is read, and it is deliberately lenient where `validateActions`
 * is strict — the listing and the runner both go through it, and neither may
 * fall over on a row that was valid when it was written:
 *
 * - A name the driver no longer declares (renamed in an upgrade) drops out;
 *   the rest of the allowlist stands. Every name stale → no actions, which the
 *   runner reports as "no runnable actions".
 * - A value that is not a JSON array (or not JSON at all) fails *closed*: no
 *   actions. An allowlist is a restriction, and a restriction that cannot be
 *   read must not widen into "everything" — only null, the explicit absence
 *   of one, means that.
 *
 * Exported for the runner, so what an agent is shown and what it may run are
 * the same computation.
 */
export function allowedActions(def: DriverDefinition, stored: string | null): string[] {
  const declared = Object.keys(def.actions);
  if (stored === null) return declared;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return declared.filter((name) => parsed.includes(name));
}

/**
 * The effective, agent-visible action view: every allowed action with its
 * callable parameters.
 *
 * A service whose driver is not installed lists with no actions rather than
 * failing the whole listing: the row is real, an operator needs to see it, and
 * the runner explains the missing driver clearly at fire time.
 */
function effectiveActions(
  def: DriverDefinition | undefined,
  params: ServiceParamSpec[],
  pins: ServicePins,
  actions: string | null,
): ServiceActionInfo[] {
  if (!def) return [];
  return allowedActions(def, actions).map((name) => ({
    name,
    description: def.actions[name]!.description,
    params: resolveActionParams(def, name, params, pins).callable,
  }));
}

function toInfo(
  registry: DriverRegistry,
  row: Omit<ServiceRow, "settings" | "secretsEncrypted" | "approvedBy">,
): ServiceInfo {
  const params = JSON.parse(row.params) as ServiceParamSpec[];
  const pins = JSON.parse(row.pins) as ServicePins;
  const def = registry.has(row.driver) ? registry.get(row.driver) : undefined;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    driver: row.driver,
    actions: effectiveActions(def, params, pins, row.actions),
    approved: row.approvedAt !== null,
  };
}

/** The author's view of the config columns: settings and the set secret paths, never a secret. */
function configView(
  def: DriverDefinition | undefined,
  columns: Pick<StoredConfigColumns, "settings" | "secretsEncrypted">,
  masterKey: Buffer,
): Pick<ServiceAuthorInfo, "settings" | "secretsSet"> {
  if (columns.settings === null || columns.secretsEncrypted === null) return { settings: null, secretsSet: null };
  try {
    const { settings, secrets } = readParts({ configEncrypted: "", ...columns }, masterKey);
    return { settings, secretsSet: secretsSet(def, secrets) };
  } catch {
    // One row whose parts cannot be read (a changed master key, say) must not
    // fail the whole listing, nor a write that has already landed. It reads as
    // sealed; its runs report the failure.
    return { settings: null, secretsSet: null };
  }
}

function toAuthorInfo(env: ServiceEnv, row: ServiceRow): ServiceAuthorInfo {
  const def = env.registry.has(row.driver) ? env.registry.get(row.driver) : undefined;
  return {
    ...toInfo(env.registry, row),
    params: JSON.parse(row.params) as ServiceParamSpec[],
    pins: JSON.parse(row.pins) as ServicePins,
    ...configView(def, row, env.config.masterKey),
    approvedAt: row.approvedAt,
    approvedBy: row.approvedBy,
  };
}

/** Agent-visible listing: never includes the config. */
export async function listServicesUnchecked(env: ServiceEnv, bundleId: string): Promise<ServiceInfo[]> {
  const { services } = env.db.tables;
  const rows = await env.db.client
    .select({
      id: services.id,
      bundleId: services.bundleId,
      name: services.name,
      description: services.description,
      driver: services.driver,
      params: services.params,
      pins: services.pins,
      actions: services.actions,
      approvedAt: services.approvedAt,
    })
    .from(services)
    .where(eq(services.bundleId, bundleId))
    .orderBy(asc(services.createdAt), asc(services.id));
  return rows.map((row) => toInfo(env.registry, row));
}

/**
 * The bundle's services for a reader. A caller holding `edit_services` there
 * gets the author's view (settings and set secret paths); anyone else with
 * read access gets the agent-visible listing.
 */
export async function listServices(
  env: ServiceEnv,
  userId: string,
  bundleId: string,
): Promise<Array<ServiceInfo | ServiceAuthorInfo>> {
  const ctx = await getBundleContext(env.db, bundleId);
  await requireBundleReadAccess(env.db, userId, ctx);
  if (!(await hasBundleCapability(env.db, userId, "edit_services", ctx))) return listServicesUnchecked(env, bundleId);
  const { services } = env.db.tables;
  const rows = await env.db.client
    .select({
      id: services.id,
      bundleId: services.bundleId,
      name: services.name,
      description: services.description,
      driver: services.driver,
      params: services.params,
      pins: services.pins,
      actions: services.actions,
      settings: services.settings,
      secretsEncrypted: services.secretsEncrypted,
      approvedAt: services.approvedAt,
      approvedBy: services.approvedBy,
    })
    .from(services)
    .where(eq(services.bundleId, bundleId))
    .orderBy(asc(services.createdAt), asc(services.id));
  return rows.map((row) => toAuthorInfo(env, row));
}

/**
 * Resolves a service reference within one bundle, id first, then name (the
 * order runs use, so the two stay interchangeable). Returns the row's id.
 */
export async function resolveServiceId(db: Db, bundleId: string, ref: string): Promise<string> {
  const wanted = ref.trim();
  if (!wanted) throw invalid("no service specified: pass the service name or id");
  const { services } = db.tables;
  for (const column of [services.id, services.name]) {
    const rows = await db.client
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.bundleId, bundleId), eq(column, wanted)));
    if (rows[0]) return rows[0].id;
  }
  throw notFound("service", wanted);
}

/**
 * One service of a bundle, by name or id. A caller holding `edit_services`
 * there gets the author's view (params, pins, settings and set secret paths,
 * never a secret value); anyone else with read access gets the listing view,
 * as `listServices` gives them.
 */
export async function getService(
  env: ServiceEnv,
  userId: string,
  bundleId: string,
  ref: string,
): Promise<ServiceInfo | ServiceAuthorInfo> {
  const ctx = await getBundleContext(env.db, bundleId);
  await requireBundleReadAccess(env.db, userId, ctx);
  const row = await getServiceRow(env.db, await resolveServiceId(env.db, bundleId, ref));
  if (!(await hasBundleCapability(env.db, userId, "edit_services", ctx))) return toInfo(env.registry, row);
  return toAuthorInfo(env, row);
}

// ---- Authoring --------------------------------------------------------------

export async function getServiceRow(db: Db, serviceId: string) {
  const { services } = db.tables;
  const rows = await db.client.select().from(services).where(eq(services.id, serviceId));
  if (rows.length === 0) throw notFound("service", serviceId);
  return rows[0]!;
}

/** Resolves a service id to its owning bundle (transport helper for /v1/services/:id). */
export async function getServiceBundleId(db: Db, serviceId: string): Promise<string> {
  return (await getServiceRow(db, serviceId)).bundleId;
}

/**
 * The routing facts about a service, in one read: which bundle owns it (the
 * gate to check) and which driver it is on (whether a legacy surface may speak
 * for it at all). The legacy `/v1/hooks/:id` mounts need both and used to take
 * two round trips to get them.
 */
export async function getServiceRef(db: Db, serviceId: string): Promise<{ id: string; bundleId: string; driver: string }> {
  const { id, bundleId, driver } = await getServiceRow(db, serviceId);
  return { id, bundleId, driver };
}

async function assertNameFree(db: Db, bundleId: string, name: string, exceptId?: string): Promise<void> {
  const { services } = db.tables;
  const clash = await db.client
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.bundleId, bundleId), eq(services.name, name)));
  if (clash.some((row) => row.id !== exceptId)) {
    throw invalid(`a service named "${name}" already exists in this bundle`);
  }
}

export async function createService(
  env: ServiceEnv,
  userId: string,
  bundleId: string,
  input: {
    name: string;
    description?: string;
    driver?: string;
    params?: ServiceParamSpec[];
    pins?: ServicePins;
    /** Which of the driver's actions this service exposes; absent or null = all. */
    actions?: string[] | null;
    /** The whole config over REST; the settings only over MCP. */
    config: unknown;
  },
  opts: { authoring?: Authoring } = {},
): Promise<ServiceAuthorInfo> {
  const { db } = env;
  const authoring = opts.authoring ?? "rest";
  const ctx = await getBundleContext(db, bundleId);
  await requireBundleCapability(db, userId, "edit_services", ctx);

  const name = input.name?.trim();
  if (!name) throw invalid("service name is required");
  const driver = input.driver?.trim() || DEFAULT_DRIVER;
  const def = requireDriver(env.registry, driver);
  if (authoring === "mcp") requireMcpAuthorable(def);
  await requireWriteCapabilities(db, userId, def, ctx);
  const params = input.params ?? [];
  validateParamSpecs(params);
  const pins = (input.pins ?? {}) as Record<string, unknown>;
  validatePins(pins, declaredNames(def, params));
  if (input.actions != null) validateActions(def, input.actions);
  const actions = input.actions == null ? null : JSON.stringify(input.actions);
  const columns = await prepareConfigWrite(env, def, input.config, null, authoring);
  await assertNameFree(db, bundleId, name);

  const { services } = db.tables;
  const now = nowIso();
  const id = newId();
  const description = input.description ?? "";
  // Written over REST, the author sent the whole config and is the approval.
  // Written over MCP, or with a scoped key, it waits for a person
  // (serviceApprovals.ts).
  const approves = authoring === "rest" && !onScopedKey();
  const approvedAt = approves ? now : null;
  const approvedBy = approves ? userId : null;
  await db.client.insert(services).values({
    id,
    bundleId,
    name,
    description,
    driver,
    params: JSON.stringify(params),
    pins: JSON.stringify(pins),
    actions,
    ...columns,
    approvedAt,
    approvedBy,
    createdAt: now,
    updatedAt: now,
  });
  return {
    id,
    name,
    description,
    driver,
    actions: effectiveActions(def, params, pins as ServicePins, actions),
    params,
    pins: pins as ServicePins,
    ...configView(def, columns, env.config.masterKey),
    approved: approvedAt !== null,
    approvedAt,
    approvedBy,
  };
}

/**
 * What an approval covers, as one comparable string: everything that decides
 * what a service does and where its data goes. Name and description are not
 * in it (they change what an agent reads, not what a run does), nor secret
 * values, only which secret paths are set.
 */
function approvalShape(
  def: DriverDefinition | undefined,
  fields: { params: unknown; pins: unknown; actions: string | null },
  columns: Pick<StoredConfigColumns, "settings" | "secretsEncrypted">,
  masterKey: Buffer,
): string {
  const view = configView(def, columns, masterKey);
  let actions: unknown = fields.actions;
  try {
    // Parsed so key order and spacing do not count; a value that is not JSON is compared as it is.
    actions = fields.actions === null ? null : JSON.parse(fields.actions);
  } catch {
    /* compared raw */
  }
  return canonicalJson({
    params: fields.params,
    pins: fields.pins,
    actions,
    settings: view.settings,
    secretsSet: view.secretsSet,
  });
}

/** JSON with object keys sorted, so two equal values always print the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

export async function updateService(
  env: ServiceEnv,
  userId: string,
  serviceId: string,
  patch: {
    name?: string;
    description?: string;
    params?: ServiceParamSpec[];
    /** A record replaces the pin set wholesale; null clears it. */
    pins?: ServicePins | null;
    /** An array replaces the allowlist wholesale; null clears it (all actions). */
    actions?: string[] | null;
    /** For a driver with a config schema: replaces the settings, merges the
     *  secrets (left out = kept, null = removed). Otherwise replaces the config. */
    config?: unknown;
  },
  opts: {
    /** "replace" makes a config write replace the secrets too, as every write
     *  did before the split; the legacy hook surface keeps that contract. */
    secrets?: "merge" | "replace";
    /** "mcp": `config` holds settings only (see `Authoring`), and a service
     *  whose config is one sealed secret cannot be changed at all. */
    authoring?: Authoring;
  } = {},
): Promise<ServiceAuthorInfo> {
  const authoring = opts.authoring ?? "rest";
  const { db } = env;
  const row = await getServiceRow(db, serviceId);
  const ctx = await getBundleContext(db, row.bundleId);
  await requireBundleCapability(db, userId, "edit_services", ctx);

  // A driver can be uninstalled after its services were authored. Renaming or
  // re-describing such a service still works; anything the driver would have
  // to vouch for does not.
  const def = env.registry.has(row.driver) ? env.registry.get(row.driver) : undefined;
  const needsDriver =
    patch.params !== undefined || patch.pins !== undefined || patch.actions !== undefined || patch.config !== undefined;
  if (needsDriver && !def) {
    throw invalid(
      `service "${row.name}" needs the "${row.driver}" driver, which is not installed on this server; ` +
        `only its name and description can be changed`,
    );
  }
  if (authoring === "mcp") {
    if (!def) throw invalid(`service "${row.name}" needs the "${row.driver}" driver, which is not installed on this server`);
    requireMcpAuthorable(def);
    if (!isSplit(row)) {
      throw invalid(
        `service "${row.name}" keeps its config as one sealed secret (it could not be split into settings and ` +
          "secrets), so it can only be changed over REST",
      );
    }
  }
  if (def) await requireWriteCapabilities(db, userId, def, ctx);

  const name = patch.name !== undefined ? patch.name.trim() : undefined;
  if (name !== undefined && !name) throw invalid("service name cannot be empty");
  if (patch.params !== undefined) validateParamSpecs(patch.params);

  const params = patch.params ?? (JSON.parse(row.params) as ServiceParamSpec[]);
  const stored = JSON.parse(row.pins) as Record<string, unknown>;
  const pins: Record<string, unknown> = patch.pins === null ? {} : (patch.pins ?? stored);
  // Re-checked whenever either side moves: narrowing params can orphan a pin
  // that was legal when it was set.
  if (patch.params !== undefined || patch.pins !== undefined) validatePins(pins, declaredNames(def!, params));
  // Mirrors pins: an array replaces, null clears, absent keeps the row's.
  if (Array.isArray(patch.actions)) validateActions(def!, patch.actions);
  const actions = patch.actions === undefined ? row.actions : patch.actions && JSON.stringify(patch.actions);
  const columns =
    patch.config !== undefined
      ? await prepareConfigWrite(
          env,
          def!,
          patch.config,
          opts.secrets === "replace" ? null : storedSecrets(env, def!, row),
          authoring,
          authoring === "mcp" ? readParts(row, env.config.masterKey).settings : undefined,
        )
      : undefined;
  if (name !== undefined) await assertNameFree(db, row.bundleId, name, serviceId);

  // Approval (serviceApprovals.ts). Over MCP, a write that changes what the
  // service does or where it sends data (params, pins, actions, settings, or
  // which secrets are set) puts it back to waiting for a person; renaming it,
  // or sending back what is already stored, does not. Over REST, a write
  // that sends the config is the author's own approval, as a REST create is.
  // A scoped key is never the person: over REST it is held to the MCP rule,
  // and any config it sends puts the service back to waiting too (it may
  // replace a secret's value, which the comparison cannot see).
  const scopedKey = onScopedKey();
  let approval: { approvedAt: string | null; approvedBy: string | null } | undefined;
  if ((authoring === "mcp" || scopedKey) && def) {
    const before = approvalShape(def, { params: JSON.parse(row.params), pins: JSON.parse(row.pins), actions: row.actions }, row, env.config.masterKey);
    const after = approvalShape(def, { params, pins, actions }, columns ?? row, env.config.masterKey);
    if (before !== after) approval = { approvedAt: null, approvedBy: null };
  }
  if (authoring === "rest" && patch.config !== undefined) {
    approval = scopedKey ? { approvedAt: null, approvedBy: null } : { approvedAt: nowIso(), approvedBy: userId };
  }

  const { services, secretRequests, serviceApprovals } = db.tables;
  if (columns) {
    // A config change closes the service's open secret forms: a form was
    // handed to a human for the service as it was, and must not deliver a
    // secret to wherever the change points it. Closed before the write, so a
    // submission that reads the new config finds its form gone (it checks
    // again after reading; see secretRequests.ts).
    await db.client
      .delete(secretRequests)
      .where(and(eq(secretRequests.serviceId, serviceId), isNull(secretRequests.usedAt)));
  }
  if (approval) {
    // An approval page shows the service as it was; one opened before this
    // write must not approve what the write made of it.
    await db.client
      .delete(serviceApprovals)
      .where(and(eq(serviceApprovals.serviceId, serviceId), isNull(serviceApprovals.usedAt)));
  }
  await db.client
    .update(services)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.params !== undefined ? { params: JSON.stringify(params) } : {}),
      ...(patch.pins !== undefined ? { pins: JSON.stringify(pins) } : {}),
      ...(patch.actions !== undefined ? { actions } : {}),
      ...(columns ?? {}),
      ...(approval ?? {}),
      updatedAt: nowIso(),
    })
    // Over MCP the approval decision above was made against the row as read,
    // so the write lands only on that row: a write in between (another
    // update, an approval) fails this one rather than letting it keep an
    // approval given to something else.
    .where(
      authoring === "mcp"
        ? and(eq(services.id, serviceId), eq(services.updatedAt, row.updatedAt), eq(services.configEncrypted, row.configEncrypted))
        : eq(services.id, serviceId),
    )
    .returning({ id: services.id })
    .then((written) => {
      if (written.length === 0) throw new YapError("conflict", `service "${row.name}" changed while this update was made: read it again and retry`);
    });
  // Built from the row plus the patch rather than read back: every field of the
  // view is already resolved above — the effective actions from the *post*-patch
  // params, pins, and allowlist — so a second SELECT would only re-derive what
  // is in hand.
  return {
    id: row.id,
    name: name ?? row.name,
    description: patch.description ?? row.description,
    driver: row.driver,
    actions: effectiveActions(def, params, pins as ServicePins, actions),
    params,
    pins: pins as ServicePins,
    ...configView(def, columns ?? row, env.config.masterKey),
    approved: (approval ?? row).approvedAt !== null,
    approvedAt: (approval ?? row).approvedAt,
    approvedBy: (approval ?? row).approvedBy,
  };
}

export async function deleteService(env: ServiceEnv, userId: string, serviceId: string): Promise<void> {
  const { db } = env;
  const row = await getServiceRow(db, serviceId);
  const ctx = await getBundleContext(db, row.bundleId);
  await requireBundleCapability(db, userId, "edit_services", ctx);
  const { services } = db.tables;
  await db.client.delete(services).where(eq(services.id, serviceId));
}

// ---- The bundle reader ------------------------------------------------------

const DRIVER_INLINE_FILE_CAP_BYTES = 10 * 1024 * 1024;

function fileIdFromRef(refOrId: string): string {
  const id = parseFileRef(refOrId);
  if (id === null) throw invalid("readFile expects a file://{uuid} reference or file id");
  return id;
}

export function defaultDriverInlineFileCap(config: YapConfig): number {
  return Math.min(config.maxFileSizeBytes, DRIVER_INLINE_FILE_CAP_BYTES);
}

export interface ScopedBundleReader extends BundleReader {
  close(): Promise<void>;
}

async function readStreamUpTo(stream: Readable, maxBytes: number, fileId: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) {
        stream.destroy();
        throw tooLarge(`file ${fileId} exceeds the maximum inline read size of ${maxBytes} bytes`);
      }
      chunks.push(bytes);
    }
  } catch (err) {
    stream.destroy();
    throw err;
  }
  return Buffer.concat(chunks, total);
}

export function createBundleReader(
  db: Db,
  blob: BlobStore,
  bundleId: string,
  surfaces: DriverReads,
  defaultMaxBytes: number,
  audit: (entry: unknown) => void,
): ScopedBundleReader {
  let closed = false;
  const inFlight = new Set<Promise<unknown>>();

  const track = async <T>(start: () => Promise<T>): Promise<T> => {
    if (closed) throw invalid("this service run has ended; its read handle is no longer usable");
    const operation = start();
    inFlight.add(operation);
    try {
      return await operation;
    } finally {
      inFlight.delete(operation);
    }
  };

  const trackStream = (stream: Readable): Readable => {
    const lifetime = finished(stream, { cleanup: true }).catch(() => {});
    inFlight.add(lifetime);
    void lifetime.finally(() => inFlight.delete(lifetime));
    return stream;
  };

  return {
    async readFile(refOrId: string) {
      if (closed) throw invalid("this service run has ended; its read handle is no longer usable");
      if (!surfaces.files) throw invalid("this service did not declare file reads");
      const id = fileIdFromRef(refOrId);
      const { files } = db.tables;
      const rows = await db.client.select().from(files).where(eq(files.id, id));
      const file = rows[0];
      if (!file || file.bundleId !== bundleId || file.status !== "finalized") throw notFound("file", id);

      let announced = false;
      const announce = (): void => {
        if (announced) return;
        announced = true;
        audit({ type: "file_read", id: file.id, name: file.name, size: file.size });
      };
      const cap = (maxBytes?: number): number => {
        const limit = maxBytes ?? defaultMaxBytes;
        if (!Number.isSafeInteger(limit) || limit < 0) throw invalid("maxBytes must be a non-negative integer");
        if (file.size > limit) {
          throw tooLarge(`file ${file.id} exceeds the maximum inline read size of ${limit} bytes`);
        }
        return limit;
      };
      const open = async () => {
        const stream = await blob.getStream(file.storageKey);
        announce();
        return stream;
      };

      return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        stream: async () => track(() => open().then(trackStream)),
        bytes: async (opts?: { maxBytes?: number }) => {
          const limit = cap(opts?.maxBytes);
          const bytes = await track(() => open().then((stream) => readStreamUpTo(stream, limit, file.id)));
          return new Uint8Array(bytes);
        },
        text: async (opts?: { maxBytes?: number; encoding?: BufferEncoding }) => {
          const limit = cap(opts?.maxBytes);
          const bytes = await track(() => open().then((stream) => readStreamUpTo(stream, limit, file.id)));
          return bytes.toString(opts?.encoding ?? "utf8");
        },
      };
    },
    async getItems(ids: string[]) {
      if (closed) throw invalid("this service run has ended; its read handle is no longer usable");
      if (!surfaces.items) throw invalid("this service did not declare item reads");
      return track(async () => {
        const items = await getItemsUnchecked(db, bundleId, ids);
        if (items.length !== ids.length) {
          const found = new Set(items.map((item) => item.id));
          const missing = ids.find((id) => !found.has(id)) ?? ids[0];
          throw notFound("item", missing);
        }
        audit({ type: "item_read", ids: items.map((item) => item.id) });
        return items;
      });
    },
    async close(): Promise<void> {
      closed = true;
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
  };
}

// ---- The bundle writer ------------------------------------------------------

/**
 * The writer as its owner sees it: a `BundleWriter` plus the `close()` the
 * runner calls when the run ends. Closing matters because a driver that
 * ignores its abort signal is still running after its row is written — the
 * same reason the egress handle is disposed — and writes landing after that
 * point would be invisible in the run's audit trail.
 *
 * `close()` is async because refusing *future* calls is only half the job: a
 * write already in flight when the run ends will still land its item or file,
 * and its audit entry has to reach the run row with it. So closing rejects new calls
 * at once and then waits for every in-flight write to settle — announcement
 * included — before it resolves. The runner awaits it before serializing the
 * outcome, which is what makes "an item with no audit trail" unreachable.
 *
 * That drain is deliberately unbounded — no timeout races it. Audit integrity
 * outweighs the tail risk: a genuinely stalled write would strand the run's
 * own row write regardless of whether this wait were capped, so a timeout here
 * would only buy an inconsistent audit trail, not a faster run. A write that
 * truly never settles leaves the run `running` rather than `failed`; boot
 * recovery (`recoverInterruptedRuns`) is what reclaims it.
 */
export interface ScopedBundleWriter extends BundleWriter {
  close(): Promise<void>;
}

/**
 * The bundle-scoped write handle handed to a driver that declared writes.
 *
 * Two properties make it safe to hand to driver code:
 *
 * - Scope: the bundle is bound at construction (the run's bundle) and there is
 *   no parameter to point it anywhere else, so a driver cannot reach another
 *   bundle's item-types or file namespace.
 * - Audit: every successful write is announced through `audit`, which the runs
 *   layer persists on the run row. A write with no trail is not a shape this
 *   handle can produce — including at the end of the run, where `close()`
 *   drains whatever is still in flight so a write that lands late is announced
 *   before the row is written rather than after it.
 *
 * Validation is not relaxed for drivers: `createItemsUnchecked`,
 * `updateItemsUnchecked`, and `writeFileUnchecked` run every check the gated
 * paths run. Only the edit capability check is absent, because a run uses
 * service authority: whoever created or last changed the service held
 * `edit_items` / `edit_files` for each surface its driver declares (see
 * `requireWriteCapabilities`), and that is the grant.
 */
export function createBundleWriter(
  db: Db,
  blob: BlobStore,
  config: YapConfig,
  ownerId: string,
  bundleId: string,
  surfaces: { items?: boolean; files?: boolean },
  audit: (entry: unknown) => void,
): ScopedBundleWriter {
  let closed = false;
  // Writes started but not yet announced. A driver need not await its own
  // `createItems`/`updateItems`/`writeFile` — `void writer.createItems(...)` is legal JS — so the run can
  // reach its end with items on the way to the database. Tracking them is what
  // lets `close()` wait instead of walking away from their audit entries.
  const inFlight = new Set<Promise<unknown>>();
  return {
    async createItems(itemTypeName: string, values: Array<Record<string, unknown>>): Promise<string[]> {
      if (closed) throw invalid("this service run has ended; its write handle is no longer usable");
      if (!surfaces.items) throw invalid("this service did not declare item writes");
      const landing = (async (): Promise<string[]> => {
        const created = await createItemsUnchecked(db, bundleId, { itemType: itemTypeName, items: values }).catch(
          (err: unknown) => {
            // A uniqueness rejection is written by the *bundle's* data: the item
            // layer's message quotes the colliding value and the id of the item
            // that already holds it. A driver's failure lands on `run.error`,
            // which is agent-visible, so that message is replaced by a flat one
            // naming the rule and nothing else.
            if (err instanceof YapError && (err.code === "conflict" || /must be unique/.test(err.message))) {
              throw new YapError("conflict", "service write-back hit a uniqueness conflict");
            }
            throw err;
          },
        );
        const ids = created.map((item) => item.id);
        // The resolved type name, not the caller's reference: a driver may name
        // an item-type by id, and the trail should read as a name.
        audit({ type: "items", itemType: created[0]?.itemType ?? itemTypeName, ids });
        return ids;
      })();
      // Held from before the first await to after the announcement, so a
      // `close()` racing this write can never observe the gap between them.
      inFlight.add(landing);
      try {
        return await landing;
      } finally {
        inFlight.delete(landing);
      }
    },
    async updateItems(updates: ItemUpdateInput[]) {
      if (closed) throw invalid("this service run has ended; its write handle is no longer usable");
      if (!surfaces.items) throw invalid("this service did not declare item writes");
      const landing = (async () => {
        const updated = await updateItemsUnchecked(db, bundleId, updates).catch((err: unknown) => {
          if (err instanceof YapError && (err.code === "conflict" || /must be unique/.test(err.message))) {
            throw new YapError("conflict", "service write-back hit a uniqueness conflict");
          }
          throw err;
        });
        const byType = new Map<string, string[]>();
        for (const item of updated) {
          byType.set(item.itemType, [...(byType.get(item.itemType) ?? []), item.id]);
        }
        for (const [itemType, ids] of byType) audit({ type: "items", itemType, ids, op: "update" });
        return updated;
      })();
      inFlight.add(landing);
      try {
        return await landing;
      } finally {
        inFlight.delete(landing);
      }
    },
    async writeFile(input: FileWriteInput) {
      if (closed) throw invalid("this service run has ended; its write handle is no longer usable");
      if (!surfaces.files) throw invalid("this service did not declare file writes");
      const landing = (async () => {
        const file = await writeFileUnchecked({ db, blob, config }, ownerId, bundleId, input);
        audit({ type: "file", id: file.id, name: file.name, size: file.size });
        return file;
      })();
      inFlight.add(landing);
      try {
        return await landing;
      } finally {
        inFlight.delete(landing);
      }
    },
    async close(): Promise<void> {
      // Future calls are refused first: nothing new can join the drain, so the
      // wait below is bounded by the writes that already started.
      closed = true;
      await Promise.allSettled([...inFlight]);
    },
  };
}
