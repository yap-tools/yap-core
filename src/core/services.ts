/**
 * Services: the bundle-owned, named capabilities agents can run. A service is
 * a driver plus the configuration that driver needs, and the two halves have
 * very different visibility — which is the whole security model, inherited
 * from hooks.ts:
 *
 * - Visible to any reader of the bundle: id, name, description, driver, and
 *   the *callable* parameters of each action. That is what an agent needs to
 *   compose a call and nothing more.
 * - Never returned by any surface: the config. It is AES-256-GCM-encrypted at
 *   rest with the master key and decrypted only in memory inside a run.
 * - Pins are configuration, not parameters: a pinned value is stripped from
 *   every listing (an agent cannot even learn a pin's name is fixed by probing
 *   the listing) and merged in by the runner after the caller's half has been
 *   validated.
 *
 * Authoring is privileged (`edit_services`) and, in practice, REST-only —
 * agents run services but never define them. That asymmetry is what lets the
 * bundle writer below skip the `edit_items` check: an operator authoring a
 * service over privileged REST *is* the grant, so a driver that declared
 * `writes.items` writes with the service's authority rather than the caller's.
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
 * - `validateConfig` is the driver's own offline check; `validateConfigOnline`
 *   is the network-touching one (the http driver's SSRF pre-check lives
 *   there). Both run at create, and again whenever the config changes. The
 *   detailed guard message is kept intact here on purpose: authoring is an
 *   operator-facing surface, and the operator is precisely who needs to know
 *   which address was refused.
 */
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import type { YapConfig } from "../config.js";
import { encryptSecret } from "../crypto.js";
import type { Db } from "../db/index.js";
import { getBundleContext, requireBundleCapability, requireBundleReadAccess } from "./bundles.js";
import { createEgress } from "./drivers/egress.js";
import type { DriverRegistry } from "./drivers/registry.js";
import type { BundleWriter, DriverDefinition } from "./drivers/types.js";
import { invalid, notFound, YapError } from "./errors.js";
import { createItemsUnchecked } from "./items.js";
import type { Resolver } from "./ssrf.js";
import { newId, nowIso } from "./util.js";

/** The same rule the driver registry applies to a driver's own param specs. */
const PARAM_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

/** A service that names no driver gets the built-in one (what every hook was). */
const DEFAULT_DRIVER = "http";

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
 * specs the driver's actions declare themselves. A pin outside that set names
 * nothing and would be injected into a call no action understands.
 */
function declaredNames(def: DriverDefinition, params: ServiceParamSpec[]): string[] {
  const names = new Set(params.map((p) => p.name));
  for (const action of Object.values(def.actions)) {
    for (const spec of action.params ?? []) names.add(spec.name);
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
async function validateDriverConfig(env: ServiceEnv, def: DriverDefinition, config: unknown): Promise<void> {
  const wrap = (err: unknown): never => {
    if (err instanceof YapError) throw err;
    throw invalid(`invalid config for driver "${def.name}": ${String((err as Error | undefined)?.message ?? err)}`);
  };
  try {
    def.validateConfig(config);
  } catch (err) {
    wrap(err);
  }
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

// ---- Listing ----------------------------------------------------------------

/**
 * The effective, agent-visible action view. An action that declares its own
 * specs owns them; one declaring `null` (the http driver, whose parameters are
 * whatever its template uses) takes the service record's. Pinned names are
 * removed from both — they are configuration, and naming one in a call is an
 * error the runner raises.
 *
 * A service whose driver is not installed lists with no actions rather than
 * failing the whole listing: the row is real, an operator needs to see it, and
 * the runner explains the missing driver clearly at fire time.
 */
function effectiveActions(
  def: DriverDefinition | undefined,
  params: ServiceParamSpec[],
  pins: Record<string, unknown>,
): ServiceActionInfo[] {
  if (!def) return [];
  return Object.entries(def.actions).map(([name, action]) => ({
    name,
    description: action.description,
    params: ((action.params ?? params) as ServiceParamSpec[]).filter((spec) => !(spec.name in pins)),
  }));
}

function toInfo(registry: DriverRegistry, row: ServiceRow): ServiceInfo {
  const params = JSON.parse(row.params) as ServiceParamSpec[];
  const pins = JSON.parse(row.pins) as Record<string, unknown>;
  const def = registry.has(row.driver) ? registry.get(row.driver) : undefined;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    driver: row.driver,
    actions: effectiveActions(def, params, pins),
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
    })
    .from(services)
    .where(eq(services.bundleId, bundleId))
    .orderBy(asc(services.createdAt), asc(services.id));
  return rows.map((row) => toInfo(env.registry, row));
}

export async function listServices(env: ServiceEnv, userId: string, bundleId: string): Promise<ServiceInfo[]> {
  const ctx = await getBundleContext(env.db, bundleId);
  await requireBundleReadAccess(env.db, userId, ctx);
  return listServicesUnchecked(env, bundleId);
}

// ---- Authoring --------------------------------------------------------------

async function getServiceRow(db: Db, serviceId: string) {
  const { services } = db.tables;
  const rows = await db.client.select().from(services).where(eq(services.id, serviceId));
  if (rows.length === 0) throw notFound("service", serviceId);
  return rows[0]!;
}

/** Resolves a service id to its owning bundle (transport helper for /v1/services/:id). */
export async function getServiceBundleId(db: Db, serviceId: string): Promise<string> {
  return (await getServiceRow(db, serviceId)).bundleId;
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
    pins?: Record<string, string>;
    config: unknown;
  },
): Promise<ServiceInfo> {
  const { db } = env;
  const ctx = await getBundleContext(db, bundleId);
  await requireBundleCapability(db, userId, "edit_services", ctx);

  const name = input.name?.trim();
  if (!name) throw invalid("service name is required");
  const driver = input.driver?.trim() || DEFAULT_DRIVER;
  const def = requireDriver(env.registry, driver);
  const params = input.params ?? [];
  validateParamSpecs(params);
  const pins = (input.pins ?? {}) as Record<string, unknown>;
  validatePins(pins, declaredNames(def, params));
  await validateDriverConfig(env, def, input.config);
  await assertNameFree(db, bundleId, name);

  const { services } = db.tables;
  const now = nowIso();
  const id = newId();
  const description = input.description ?? "";
  await db.client.insert(services).values({
    id,
    bundleId,
    name,
    description,
    driver,
    params: JSON.stringify(params),
    pins: JSON.stringify(pins),
    configEncrypted: encryptSecret(JSON.stringify(input.config), env.config.masterKey),
    createdAt: now,
    updatedAt: now,
  });
  return { id, name, description, driver, actions: effectiveActions(def, params, pins) };
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
    pins?: Record<string, string> | null;
    config?: unknown;
  },
): Promise<ServiceInfo> {
  const { db } = env;
  const row = await getServiceRow(db, serviceId);
  const ctx = await getBundleContext(db, row.bundleId);
  await requireBundleCapability(db, userId, "edit_services", ctx);

  // A driver can be uninstalled after its services were authored. Renaming or
  // re-describing such a service still works; anything the driver would have
  // to vouch for does not.
  const def = env.registry.has(row.driver) ? env.registry.get(row.driver) : undefined;
  const needsDriver = patch.params !== undefined || patch.pins !== undefined || patch.config !== undefined;
  if (needsDriver && !def) {
    throw invalid(
      `service "${row.name}" needs the "${row.driver}" driver, which is not installed on this server; ` +
        `only its name and description can be changed`,
    );
  }

  const name = patch.name !== undefined ? patch.name.trim() : undefined;
  if (name !== undefined && !name) throw invalid("service name cannot be empty");
  if (patch.params !== undefined) validateParamSpecs(patch.params);

  const params = patch.params ?? (JSON.parse(row.params) as ServiceParamSpec[]);
  const stored = JSON.parse(row.pins) as Record<string, unknown>;
  const pins: Record<string, unknown> = patch.pins === null ? {} : (patch.pins ?? stored);
  // Re-checked whenever either side moves: narrowing params can orphan a pin
  // that was legal when it was set.
  if (patch.params !== undefined || patch.pins !== undefined) validatePins(pins, declaredNames(def!, params));
  if (patch.config !== undefined) await validateDriverConfig(env, def!, patch.config);
  if (name !== undefined) await assertNameFree(db, row.bundleId, name, serviceId);

  const { services } = db.tables;
  await db.client
    .update(services)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.params !== undefined ? { params: JSON.stringify(params) } : {}),
      ...(patch.pins !== undefined ? { pins: JSON.stringify(pins) } : {}),
      ...(patch.config !== undefined
        ? { configEncrypted: encryptSecret(JSON.stringify(patch.config), env.config.masterKey) }
        : {}),
      updatedAt: nowIso(),
    })
    .where(eq(services.id, serviceId));
  return toInfo(env.registry, await getServiceRow(db, serviceId));
}

export async function deleteService(env: ServiceEnv, userId: string, serviceId: string): Promise<void> {
  const { db } = env;
  const row = await getServiceRow(db, serviceId);
  const ctx = await getBundleContext(db, row.bundleId);
  await requireBundleCapability(db, userId, "edit_services", ctx);
  const { services } = db.tables;
  await db.client.delete(services).where(eq(services.id, serviceId));
}

// ---- The bundle writer ------------------------------------------------------

/**
 * The writer as its owner sees it: a `BundleWriter` plus the `close()` the
 * runner calls when the run ends. Closing matters because a driver that
 * ignores its abort signal is still running after its row is written — the
 * same reason the egress handle is disposed — and writes landing after that
 * point would be invisible in the run's audit trail.
 */
export interface ScopedBundleWriter extends BundleWriter {
  close(): void;
}

/**
 * The bundle-scoped write handle handed to a driver that declared writes.
 *
 * Two properties make it safe to hand to driver code:
 *
 * - Scope: the bundle is bound at construction (the run's bundle) and there is
 *   no parameter to point it anywhere else, so a driver cannot reach another
 *   bundle's item-types — an unknown type name is simply not found.
 * - Audit: every successful write is announced through `audit`, which the runs
 *   layer persists on the run row. A write with no trail is not a shape this
 *   handle can produce.
 *
 * Validation is not relaxed for drivers: `createItemsUnchecked` runs every
 * check the gated path runs. Only the `edit_items` capability check is absent,
 * because a run has no acting user to check it against — the operator who
 * authored the service over privileged REST is the grant.
 */
export function createBundleWriter(
  db: Db,
  bundleId: string,
  audit: (entry: unknown) => void,
): ScopedBundleWriter {
  let closed = false;
  return {
    async createItems(itemTypeName: string, values: Array<Record<string, unknown>>): Promise<string[]> {
      if (closed) throw invalid("this service run has ended; its write handle is no longer usable");
      const created = await createItemsUnchecked(db, bundleId, { itemType: itemTypeName, items: values });
      const ids = created.map((item) => item.id);
      // The resolved type name, not the caller's reference: a driver may name
      // an item-type by id, and the trail should read as a name.
      audit({ type: "items", itemType: created[0]?.itemType ?? itemTypeName, ids });
      return ids;
    },
    close(): void {
      closed = true;
    },
  };
}
