/**
 * Schedules: a cron expression that starts a run of one service action, on
 * its own, as the user who created it.
 *
 * A schedule is its own object in the bundle rather than a field on the
 * service, so one service can carry several schedules with different params (a
 * planner pass per codebase, say) and the service's configuration is never
 * touched. This module is the record — authoring, reading, validation; the
 * process-side half that actually fires them is `scheduler.ts`.
 *
 * The rules a schedule is held to:
 *
 * - **It runs as its owner**, the user who created it, and nobody else: Core
 *   has no system identity to run it as, and does not grow one for this. The
 *   owner never changes, so only the owner may change what a schedule runs or
 *   when (or turn it back on). Anyone else who holds `run_services` there can
 *   still switch it off or delete it: stopping someone's standing order is
 *   safe, rewriting it to run as them is not.
 * - **Scheduling needs `run_services` on the bundle, and nothing more**, over
 *   REST and MCP alike: scheduling a service is running it later, so it takes
 *   the same capability as running it now. Not `edit_services` — a schedule
 *   leaves the service's configuration untouched — and no particular OAuth
 *   role: a schedule can only ever run as its owner, and every fire re-checks
 *   the owner's `run_services`, so it never outlasts the authority behind it.
 * - **Reading needs `run_services`** too, the same gate as the run records: a
 *   schedule carries the params its runs will get and points at its last run.
 * - **Its action and params are validated at write time by the very
 *   computation a run uses** (`prepareRun`): an unknown action, a pinned or
 *   undeclared name, a missing required value are all refused here rather than
 *   failing every tick. The stored params are the caller half only — pins stay
 *   configuration and are merged in by the runner, exactly as for any run.
 * - **Cron is croner's standard 5-field form** (minute precision, no seconds
 *   field); the timezone is an IANA name and defaults to UTC.
 *
 * `nextFireAt` is computed on read from the cron, the timezone and the enabled
 * flag. It is when the schedule is next due, not a promise that *this* process
 * will fire it: a process with `YAP_SCHEDULER=off` still answers the question
 * honestly for the one that has it on.
 */
import { and, asc, eq } from "drizzle-orm";
import { Cron } from "croner";

import type { YapConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { getBundleContext, requireBundleCapability } from "./bundles.js";
import type { DriverRegistry } from "./drivers/registry.js";
import { forbidden, invalid, notFound } from "./errors.js";
import { prepareRun, requireRunServicesOn, resolveServiceRow } from "./runs.js";
import { newId, nowIso } from "./util.js";

export interface ScheduleInfo {
  id: string;
  bundleId: string;
  serviceId: string;
  action: string;
  /** The caller half only; pinned values never appear here. */
  params: Record<string, string>;
  cron: string;
  timezone: string;
  enabled: boolean;
  /** The user the schedule runs as: whoever created it. */
  ownerId: string;
  /** When it last started a run (or tried to). */
  lastFiredAt: string | null;
  /** When it is next due; null while disabled. */
  nextFireAt: string | null;
  lastRunId: string | null;
  /** Why the last fire did not start a run, or why it disabled itself. */
  lastError: string | null;
  /** The last tick skipped because the previous run was still going. */
  lastSkippedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What the scheduler exposes to authoring: re-read one schedule and arm or
 *  disarm it to match. Never throws. */
export interface ScheduleReloader {
  reload(scheduleId: string): Promise<void>;
}

export interface ScheduleEnv {
  db: Db;
  config: YapConfig;
  registry: DriverRegistry;
  /** Absent in bare in-process callers; authoring works the same either way. */
  scheduler?: ScheduleReloader;
}

export type ScheduleRow = typeof import("../db/schema-sqlite.js").schedules.$inferSelect;

/** Croner job options every schedule is armed and previewed with. */
export function cronOptions(timezone: string): { timezone: string; mode: "5-part" } {
  return { timezone, mode: "5-part" };
}

/** When a schedule is next due, or null when it is disabled (or never again). */
export function nextFireOf(row: Pick<ScheduleRow, "cron" | "timezone" | "enabled">, from?: Date): string | null {
  if (row.enabled !== 1) return null;
  try {
    return new Cron(row.cron, cronOptions(row.timezone)).nextRun(from)?.toISOString() ?? null;
  } catch {
    // Validated at write time; a row that no longer parses (a croner upgrade
    // tightening its grammar) has no next fire rather than breaking a listing.
    return null;
  }
}

export function toScheduleInfo(row: ScheduleRow): ScheduleInfo {
  return {
    id: row.id,
    bundleId: row.bundleId,
    serviceId: row.serviceId,
    action: row.action,
    params: JSON.parse(row.params) as Record<string, string>,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled === 1,
    ownerId: row.ownerId,
    lastFiredAt: row.lastFiredAt,
    nextFireAt: nextFireOf(row),
    lastRunId: row.lastRunId,
    lastError: row.lastError,
    lastSkippedAt: row.lastSkippedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---- Validation -------------------------------------------------------------

/**
 * Shape checks for authoring input. REST has already parsed its body against
 * a schema; MCP passes call params through as the agent sent them, so the
 * core says what is wrong rather than coercing (a string "false" must not
 * mean enabled).
 */
function checkInputTypes(input: Record<string, unknown>): void {
  for (const key of ["service", "action", "cron", "timezone"]) {
    if (input[key] !== undefined && typeof input[key] !== "string") throw invalid(`${key} must be a string`);
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw invalid("enabled must be true or false");
  const params = input.params;
  if (params !== undefined && (params === null || typeof params !== "object" || Array.isArray(params))) {
    throw invalid('params must be an object of declared parameter values, e.g. {message: "…"}');
  }
}

/** The canonical IANA name, or a refusal. `Intl` is the authority croner uses. */
function validateTimezone(raw: string | undefined): string {
  const timezone = raw?.trim() || "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw invalid(`unknown timezone "${timezone}" — use an IANA name such as "Europe/Copenhagen" or "UTC"`);
  }
}

function validateCron(raw: string | undefined, timezone: string): string {
  const cron = raw?.trim().replace(/\s+/g, " ");
  if (!cron) throw invalid("cron is required");
  try {
    new Cron(cron, cronOptions(timezone));
  } catch (err) {
    // croner's messages name the offending field and nothing else.
    throw invalid(`invalid cron "${cron}": ${(err as Error).message} (use the 5-field form, e.g. "0 7 * * 1-5")`);
  }
  return cron;
}

/**
 * Resolves the service (by id or name, within the bundle) and checks the
 * action and params the way a run will. Returns the stored halves: the service
 * id, the resolved action name, and the caller-supplied params as strings.
 */
async function validateTarget(
  env: ScheduleEnv,
  bundleId: string,
  serviceRef: string,
  action: string | undefined,
  params: Record<string, unknown>,
): Promise<{ serviceId: string; action: string; params: Record<string, string> }> {
  const service = await resolveServiceRow(env.db, bundleId, serviceRef);
  const prepared = prepareRun(env.registry, service, action, params);
  return { serviceId: service.id, action: prepared.action, params: prepared.params };
}

// ---- Reading ----------------------------------------------------------------

async function getRow(db: Db, scheduleId: string): Promise<ScheduleRow> {
  const { schedules } = db.tables;
  const rows = await db.client.select().from(schedules).where(eq(schedules.id, scheduleId));
  if (rows.length === 0) throw notFound("schedule", scheduleId);
  return rows[0]!;
}

/** Listing without a gate — load_bundle has already checked `run_services`. */
export async function listSchedulesUnchecked(db: Db, bundleId: string, serviceId?: string): Promise<ScheduleInfo[]> {
  const { schedules } = db.tables;
  const conditions = [eq(schedules.bundleId, bundleId)];
  if (serviceId !== undefined) conditions.push(eq(schedules.serviceId, serviceId));
  const rows = await db.client
    .select()
    .from(schedules)
    .where(and(...conditions))
    .orderBy(asc(schedules.createdAt), asc(schedules.id));
  return rows.map(toScheduleInfo);
}

export async function listSchedules(
  env: ScheduleEnv,
  userId: string,
  bundleId: string,
  opts: { service?: string } = {},
): Promise<ScheduleInfo[]> {
  const ctx = await getBundleContext(env.db, bundleId);
  await requireBundleCapability(env.db, userId, "run_services", ctx);
  // A blank filter is "no filter", as in listRuns.
  const service =
    opts.service !== undefined && opts.service.trim() !== ""
      ? await resolveServiceRow(env.db, bundleId, opts.service)
      : undefined;
  return listSchedulesUnchecked(env.db, bundleId, service?.id);
}

/**
 * Reads one schedule. Existence hiding follows getRun: a schedule in a bundle
 * the caller cannot see is a 404 naming the schedule, never the bundle, while
 * a caller with a foothold there but no `run_services` gets the informative
 * 403.
 */
export async function getSchedule(env: ScheduleEnv, userId: string, scheduleId: string): Promise<ScheduleInfo> {
  const row = await getRow(env.db, scheduleId);
  await requireRunServicesOn(env.db, userId, row.bundleId, () => notFound("schedule", scheduleId));
  return toScheduleInfo(row);
}

// ---- Authoring --------------------------------------------------------------
// Gated exactly like reading: `run_services` on the bundle, with the same
// existence hiding when reached by a schedule's own id.

export async function createSchedule(
  env: ScheduleEnv,
  userId: string,
  bundleId: string,
  input: {
    /** The service's id or name, within this bundle. */
    service: string;
    action?: string;
    params?: Record<string, unknown>;
    cron: string;
    timezone?: string;
    enabled?: boolean;
  },
): Promise<ScheduleInfo> {
  await requireBundleCapability(env.db, userId, "run_services", await getBundleContext(env.db, bundleId));
  checkInputTypes(input);
  const timezone = validateTimezone(input.timezone);
  const cron = validateCron(input.cron, timezone);
  const target = await validateTarget(env, bundleId, input.service, input.action, input.params ?? {});

  const now = nowIso();
  const row: ScheduleRow = {
    id: newId(),
    bundleId,
    serviceId: target.serviceId,
    action: target.action,
    params: JSON.stringify(target.params),
    cron,
    timezone,
    enabled: input.enabled === false ? 0 : 1,
    ownerId: userId,
    lastFiredAt: null,
    lastRunId: null,
    lastError: null,
    lastSkippedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await env.db.client.insert(env.db.tables.schedules).values(row);
  await env.scheduler?.reload(row.id);
  return toScheduleInfo(row);
}

/**
 * Updates a schedule in place. The service it targets is fixed — a schedule
 * for another service is another schedule — but its action, params, cron,
 * timezone and enabled flag can all change. Action and params are re-checked
 * against the service as it is *now* whenever either moves, since the service
 * may have changed under them since the schedule was written.
 *
 * Re-enabling clears `lastError`: the schedule gets a clean slate, and a
 * disable reason left over from a capability loss no longer applies. Only the
 * patched columns are written, so a tick that lands between the read and the
 * write keeps what it recorded.
 */
export async function updateSchedule(
  env: ScheduleEnv,
  userId: string,
  scheduleId: string,
  patch: {
    action?: string;
    params?: Record<string, unknown>;
    cron?: string;
    timezone?: string;
    enabled?: boolean;
  },
): Promise<ScheduleInfo> {
  const row = await getRow(env.db, scheduleId);
  await requireRunServicesOn(env.db, userId, row.bundleId, () => notFound("schedule", scheduleId));
  checkInputTypes(patch);
  const onlyDisables =
    patch.enabled !== true &&
    patch.action === undefined &&
    patch.params === undefined &&
    patch.cron === undefined &&
    patch.timezone === undefined;
  if (row.ownerId !== userId && !onlyDisables) {
    throw forbidden(
      "only the schedule's owner can change it or turn it back on — it runs as them; " +
        "others may disable or delete it",
    );
  }

  const changes: Partial<ScheduleRow> = { updatedAt: nowIso() };
  if (patch.cron !== undefined || patch.timezone !== undefined) {
    changes.timezone = patch.timezone !== undefined ? validateTimezone(patch.timezone) : row.timezone;
    changes.cron = validateCron(patch.cron ?? row.cron, changes.timezone);
  }
  if (patch.action !== undefined || patch.params !== undefined) {
    const target = await validateTarget(
      env,
      row.bundleId,
      row.serviceId,
      patch.action ?? row.action,
      patch.params ?? (JSON.parse(row.params) as Record<string, unknown>),
    );
    changes.action = target.action;
    changes.params = JSON.stringify(target.params);
  }
  if (patch.enabled !== undefined) {
    changes.enabled = patch.enabled ? 1 : 0;
    if (patch.enabled && row.enabled === 0) changes.lastError = null;
  }

  const { schedules } = env.db.tables;
  await env.db.client.update(schedules).set(changes).where(eq(schedules.id, scheduleId));
  await env.scheduler?.reload(scheduleId);
  return toScheduleInfo({ ...row, ...changes });
}

export async function deleteSchedule(env: ScheduleEnv, userId: string, scheduleId: string): Promise<void> {
  const row = await getRow(env.db, scheduleId);
  await requireRunServicesOn(env.db, userId, row.bundleId, () => notFound("schedule", scheduleId));
  const { schedules } = env.db.tables;
  await env.db.client.delete(schedules).where(eq(schedules.id, scheduleId));
  await env.scheduler?.reload(scheduleId);
}
