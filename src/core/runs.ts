/**
 * Runs: the always-async executor that turns a service call into a durable,
 * inspectable row.
 *
 * Every invocation goes the same way, whether the caller waits or not: a run
 * row is inserted `queued`, execution starts on a floating promise, and the
 * caller's optional `waitMs` merely decides how long it blocks before reading
 * the row back. That single path is what makes a long service call safe — a
 * caller that gives up (or an adapter that clamps the wait to its ceiling)
 * loses nothing but the wait; the run keeps going and the outcome lands on the
 * row for `getRun`/`listRuns` to pick up. Clamping `waitMs` is deliberately
 * *not* done here: adapters clamp what an agent asks for, while internal
 * callers (the legacy hook fire path) pass a wait longer than the action's own
 * budget so they always get back a terminal run.
 *
 * Three secrecy rules hold the security model from hooks.ts in place:
 *
 * - The service config is decrypted only inside execution, only in memory, and
 *   never reaches a returned record.
 * - A caller may supply only *unpinned* declared parameters; pinned values are
 *   merged in after the caller's half has been validated, so a pin can never
 *   be overridden or discovered by probing.
 * - A driver failure that is not already agent-safe (i.e. not a `YapError`,
 *   which the driver contract requires to be sanitized) is collapsed into a
 *   flat "run failed" — the underlying message can name a hidden host.
 *
 * Timeouts are the runner's business, not the driver's, and the runner *owns*
 * the budget rather than merely asking for it: one AbortController per run,
 * fired at `min(action.timeoutMs, config.runTimeoutCapMs)`, reaches the driver
 * as `ctx.signal`, and the driver's promise is raced against that deadline. A
 * driver that ignores its signal therefore still loses the race and still
 * lands a `failed` row; only its own in-flight work outlives the run. The
 * egress handle is likewise created and disposed here — one per run, released
 * in a `finally` at race end.
 *
 * The outcome is serialized inside the attempt, not while writing the row: a
 * result JSON cannot represent (circular, BigInt) is the driver's bug and
 * becomes an ordinary failure, never a run stranded in `running`.
 */
import { and, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";

import type { YapConfig } from "../config.js";
import { decryptSecret } from "../crypto.js";
import type { Db } from "../db/index.js";
import { getBundleContext, requireBundleCapability } from "./bundles.js";
import { createEgress, type Egress } from "./drivers/egress.js";
import type { DriverRegistry } from "./drivers/registry.js";
import type { DriverDefinition, DriverParamSpec } from "./drivers/types.js";
import { invalid, notFound, YapError } from "./errors.js";
import { clampLimit, decodeCursor, toPage } from "./pagination.js";
import { createBundleWriter, type ScopedBundleWriter } from "./services.js";
import type { Resolver } from "./ssrf.js";
import { newId, nowIso } from "./util.js";

export type RunStatus = "queued" | "running" | "succeeded" | "failed";

const TERMINAL: RunStatus[] = ["succeeded", "failed"];
const INTERRUPTED: RunStatus[] = ["queued", "running"];

/** How many driver log lines one run keeps. See `execute` — nothing is persisted. */
const LOG_RING_SIZE = 200;

export interface RunRecord {
  id: string;
  /** Null once the service has been deleted — the run outlives it. */
  serviceId: string | null;
  /** Denormalized at creation so a deleted service still has a label. */
  serviceName: string;
  bundleId: string;
  action: string;
  status: RunStatus;
  params: Record<string, string>;
  result: unknown | null;
  error: string | null;
  writes: unknown[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunEnv {
  db: Db;
  config: YapConfig;
  registry: DriverRegistry;
  resolver?: Resolver;
  fetchImpl?: typeof fetch;
}

interface ServiceRow {
  id: string;
  bundleId: string;
  name: string;
  driver: string;
  params: string;
  pins: string;
  configEncrypted: string;
}

interface RunRow {
  id: string;
  bundleId: string;
  serviceId: string | null;
  serviceName: string;
  action: string;
  status: string;
  params: string;
  result: string | null;
  error: string | null;
  writes: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function toRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    serviceId: row.serviceId,
    serviceName: row.serviceName,
    bundleId: row.bundleId,
    action: row.action,
    status: row.status as RunStatus,
    params: JSON.parse(row.params) as Record<string, string>,
    result: row.result === null ? null : (JSON.parse(row.result) as unknown),
    error: row.error,
    writes: JSON.parse(row.writes) as unknown[],
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

async function readRun(db: Db, runId: string): Promise<RunRecord> {
  const { runs } = db.tables;
  const rows = await db.client.select().from(runs).where(eq(runs.id, runId));
  const row = rows[0];
  if (!row) throw notFound("run", runId);
  return toRecord(row);
}

/**
 * Resolves a service reference within one bundle: id first, then name (the
 * same order hooks used, so ids and names stay interchangeable everywhere).
 * An empty reference is the flattening mistake — declared values put where the
 * service name belongs — so it gets a shape-explaining error rather than a
 * bare not_found that reads as a wiring problem.
 */
async function resolveService(db: Db, bundleId: string, ref: string | undefined): Promise<ServiceRow> {
  const wanted = ref?.trim();
  if (!wanted) {
    throw invalid(
      'no service specified — set run_service\'s "service" parameter to the service\'s name or id (both are in load_bundle) and put the declared values in the nested params object, e.g. {service: "notify", params: {message: "…"}}',
    );
  }
  const { services } = db.tables;
  const byId = await db.client
    .select()
    .from(services)
    .where(and(eq(services.bundleId, bundleId), eq(services.id, wanted)));
  const found =
    byId.length > 0
      ? byId
      : await db.client
          .select()
          .from(services)
          .where(and(eq(services.bundleId, bundleId), eq(services.name, wanted)));
  const service = found[0];
  if (!service) throw notFound("service", wanted);
  return service;
}

function driverFor(registry: DriverRegistry, service: ServiceRow): DriverDefinition {
  if (!registry.has(service.driver)) {
    throw invalid(
      `service "${service.name}" needs the "${service.driver}" driver, which is not installed on this server`,
    );
  }
  return registry.get(service.driver);
}

/** Picks the action to run: an explicit name, or the only one there is. */
function resolveAction(def: DriverDefinition, serviceName: string, requested?: string): string {
  const names = Object.keys(def.actions);
  if (names.length === 0) throw invalid(`service "${serviceName}" has no runnable actions`);
  const wanted = requested?.trim();
  if (wanted) {
    if (!names.includes(wanted)) {
      throw invalid(`unknown action "${wanted}" for service "${serviceName}" (available: ${names.join(", ")})`);
    }
    return wanted;
  }
  if (names.length === 1) return names[0]!;
  throw invalid(`service "${serviceName}" needs an action — one of: ${names.join(", ")}`);
}

/**
 * The effective parameter specs for one call: an action that declares its own
 * specs owns them; an action that declares `null` (the http driver, whose
 * parameters are whatever the service's template uses) takes the service
 * record's.
 */
function effectiveSpecs(def: DriverDefinition, service: ServiceRow, action: string): DriverParamSpec[] {
  const declared = def.actions[action]!.params;
  if (declared) return declared;
  return JSON.parse(service.params) as DriverParamSpec[];
}

/**
 * Parameter allowlisting — the safety hinge, inherited from fireHook. Supplied
 * values must match the *callable* specs exactly: pinned names are not among
 * them, so naming one is an explicit error rather than a silent override, and
 * the pinned values are merged only once the caller's half has been validated.
 */
function buildParams(
  def: DriverDefinition,
  service: ServiceRow,
  action: string,
  supplied: Record<string, unknown>,
): Record<string, string> {
  const pins = JSON.parse(service.pins) as Record<string, unknown>;
  const specs = effectiveSpecs(def, service, action);
  const callable = specs.filter((spec) => !Object.hasOwn(pins, spec.name));

  const values: Record<string, string> = {};
  for (const key of Object.keys(supplied)) {
    if (Object.hasOwn(pins, key)) throw invalid(`parameter "${key}" is fixed by this service configuration`);
    if (!callable.some((spec) => spec.name === key)) {
      throw invalid(`unknown parameter "${key}" (declared: ${callable.map((s) => s.name).join(", ") || "none"})`);
    }
    const value = supplied[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "object") throw invalid(`parameter "${key}" must be a scalar`);
    values[key] = String(value);
  }
  for (const spec of callable) {
    if (spec.required && values[spec.name] === undefined) {
      throw invalid(`required parameter "${spec.name}" is missing`);
    }
  }
  for (const [name, pinned] of Object.entries(pins)) values[name] = String(pinned);
  return values;
}

interface Job {
  runId: string;
  bundleId: string;
  def: DriverDefinition;
  action: string;
  values: Record<string, string>;
  configEncrypted: string;
}

/**
 * What `attempt` hands back. The success payload is already JSON *text*:
 * serializing inside the attempt is what keeps a non-serializable driver
 * result from throwing during the row write, where it would be swallowed and
 * leave the run `running` forever.
 *
 * `writes` rides along with both endings on purpose: a run that failed halfway
 * may still have written, and that half has to reach the audit column.
 */
type Ending = { status: "succeeded"; result: string } | { status: "failed"; error: string };
type Outcome = Ending & { writes: unknown[] };

const timedOutMessage = (budgetMs: number): string => `run timed out after ${budgetMs}ms`;

/** Turns whatever the driver threw into one agent-safe line. */
function failureMessage(err: unknown, timedOut: boolean, budgetMs: number, log: (m: string) => void): string {
  // Only the runner's own deadline may claim a timeout. A driver that throws
  // its own AbortError while the budget is still live — an internal race of its
  // own, a caller-side abort it invented — is an ordinary failure; saying
  // "timed out" there would misreport it (and quote a budget that never fired).
  if (timedOut) return timedOutMessage(budgetMs);
  // The driver contract requires a YapError's message to be agent-safe (the
  // http driver, for instance, collapses SSRF and transport errors itself).
  if (err instanceof YapError) return err.message;
  // Anything else can carry internals — a hidden host, a stack, a stray
  // secret — so it goes to the log ring and never to the row.
  log(`unexpected driver failure: ${String((err as Error | undefined)?.message ?? err)}`);
  return "run failed";
}

/** Runs the driver under the run's budget. Never throws; returns the outcome. */
async function attempt(env: RunEnv, job: Job): Promise<Outcome> {
  const { db, config } = env;
  const { runs } = db.tables;
  const budgetMs = Math.min(job.def.actions[job.action]!.timeoutMs, config.runTimeoutCapMs ?? Number.POSITIVE_INFINITY);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, budgetMs);

  // v1 keeps driver log lines in memory for the duration of the run only:
  // nothing is persisted, so a driver cannot use `log` to write an unbounded
  // (or secret-bearing) trail into the database. The ring exists so a failure
  // detail has somewhere to go instead of the agent-visible error column.
  const logs: string[] = [];
  const log = (message: string): void => {
    logs.push(message);
    if (logs.length > LOG_RING_SIZE) logs.shift();
  };

  // The audit trail this run leaves behind. The writer appends to it as the
  // driver writes; it lands on the row whichever way the run ends.
  const writes: unknown[] = [];

  let egress: Egress | null = null;
  let writer: ScopedBundleWriter | null = null;
  try {
    await db.client.update(runs).set({ status: "running", startedAt: nowIso() }).where(eq(runs.id, job.runId));
    // The decrypted config exists only here, only in memory.
    const serviceConfig: unknown = JSON.parse(decryptSecret(job.configEncrypted, config.masterKey));
    egress = job.def.egress ? createEgress(config, env.resolver, env.fetchImpl) : null;
    // Undeclared write surfaces are simply not reachable: no handle, no door.
    // The writer is scoped to *this run's* bundle at construction, so a driver
    // has no way to point it at another one.
    writer = job.def.writes?.items ? createBundleWriter(db, job.bundleId, (entry) => writes.push(entry)) : null;
    const running = job.def.run({
      config: serviceConfig,
      action: job.action,
      params: job.values,
      egress,
      writer,
      signal: controller.signal,
      log,
    });
    // Losing the race orphans this promise while the driver is still working,
    // so neuter it up front: a late settlement is discarded (the row is already
    // written), and a late *rejection* can never surface as an unhandled one.
    void running.then(() => {}).catch(() => {});
    // `ctx.signal` is a request; this race is the enforcement. Awaiting the
    // driver alone would let one that never checks its signal hold the run open
    // forever — row stuck `running`, egress never disposed.
    const result = await Promise.race([running, abortedBy(controller.signal)]);
    // The driver may also have *won* the race by resolving after the deadline
    // already fired. The run is over either way: a late success is a timeout.
    if (timedOut) return { status: "failed", error: timedOutMessage(budgetMs), writes };
    return { ...serialize(result, log), writes };
  } catch (err) {
    return { status: "failed", error: failureMessage(err, timedOut, budgetMs, log), writes };
  } finally {
    clearTimeout(timer);
    // Same reason the egress handle is disposed: a signal-deaf driver is still
    // running, and a write it lands now would never reach the audit column.
    writer?.close();
    if (egress) {
      try {
        // Safe even while a signal-ignoring driver still holds the handle:
        // dispose poisons it, so the rogue call fails rather than escaping the
        // guard. Whatever socket work such a driver has already started is its
        // own leak — the driver contract is to honour `ctx.signal`.
        await egress.dispose();
      } catch {
        // Pool teardown is best-effort; it must not change the run's outcome.
      }
    }
  }
}

/**
 * A promise that rejects when `signal` aborts and never settles otherwise —
 * the deadline's side of the race in `attempt`.
 */
function abortedBy(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(Object.assign(new Error("run budget elapsed"), { name: "AbortError" }));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

/**
 * JSON-encodes a driver result. A value JSON cannot represent (circular,
 * BigInt) is the driver's bug: it fails the run with a message that quotes
 * nothing of the value, rather than throwing where it would strand the row.
 */
function serialize(result: unknown, log: (m: string) => void): Ending {
  try {
    // `?? "null"` covers the values JSON drops outright (a function, a bare
    // undefined): the run succeeded, it just has no result to show.
    return { status: "succeeded", result: JSON.stringify(result ?? null) ?? "null" };
  } catch (err) {
    log(`result serialization failed: ${String((err as Error | undefined)?.message ?? err)}`);
    return { status: "failed", error: "run result could not be serialized" };
  }
}

/** The floating half of a run: never rejects, always lands on the row. */
async function execute(env: RunEnv, job: Job): Promise<void> {
  const outcome = await attempt(env, job);
  const { runs } = env.db.tables;
  try {
    await env.db.client
      .update(runs)
      .set({
        status: outcome.status,
        ...(outcome.status === "succeeded" ? { result: outcome.result } : { error: outcome.error }),
        writes: JSON.stringify(outcome.writes),
        finishedAt: nowIso(),
      })
      .where(eq(runs.id, job.runId));
  } catch {
    // Only a genuine write failure can land here now — the outcome was already
    // serialized inside `attempt`. The row is the only channel there is; if the
    // write fails the run stays `running` and boot recovery will retire it.
  }
}

/** Resolves when `promise` settles or `ms` elapses, whichever comes first. */
async function raceWithTimer(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([promise, waited]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Starts a run. Returns as soon as `waitMs` elapses or the run finishes,
 * whichever is first — so the returned record may still be `queued`/`running`
 * and the caller polls `getRun`. `waitMs` is used raw: adapters clamp it to
 * `config.runWaitCapMs`, internal callers deliberately exceed the cap.
 */
export async function runService(
  env: RunEnv,
  userId: string,
  bundleId: string,
  input: { service: string; action?: string; params?: Record<string, unknown>; waitMs?: number },
): Promise<RunRecord> {
  const { db } = env;
  const bundleCtx = await getBundleContext(db, bundleId);
  await requireBundleCapability(db, userId, "run_services", bundleCtx);

  const service = await resolveService(db, bundleId, input.service);
  const def = driverFor(env.registry, service);
  const action = resolveAction(def, service.name, input.action);
  const values = buildParams(def, service, action, input.params ?? {});

  const runId = newId();
  const { runs } = db.tables;
  await db.client.insert(runs).values({
    id: runId,
    bundleId,
    serviceId: service.id,
    serviceName: service.name,
    action,
    status: "queued",
    // What the driver actually receives, pins included: the audit trail should
    // show the call as delivered, not just the caller's half of it.
    params: JSON.stringify(values),
    writes: "[]",
    createdAt: nowIso(),
  });

  // Floating on purpose: the wait window must be honoured even for a run that
  // outlives it. `execute` swallows every outcome into the row, so this
  // promise can never reject unhandled.
  const execution = execute(env, {
    runId,
    bundleId,
    def,
    action,
    values,
    configEncrypted: service.configEncrypted,
  }).catch(
    () => {
      // `execute` funnels everything into the row and does not reject; this is
      // the belt-and-braces that keeps an unawaited run from ever surfacing as
      // an unhandled rejection.
    },
  );
  if (input.waitMs !== undefined && input.waitMs > 0) await raceWithTimer(execution, input.waitMs);
  return await readRun(db, runId);
}

/**
 * Reads one run. Existence hiding here is about the *run*: an id that does not
 * exist and a run living in a bundle the caller cannot see must be
 * indistinguishable, and neither may name the bundle — the bundle-level
 * not_found would hand an outsider a bundle id it was never allowed to learn.
 * A genuine 403 still passes through unchanged: per the bundle-existence
 * convention, a caller who already has a foothold in the bundle gets the
 * informative "missing capability run_services" rather than a 404.
 */
export async function getRun(env: RunEnv, userId: string, runId: string): Promise<RunRecord> {
  const { db } = env;
  const record = await readRun(db, runId);
  try {
    const bundleCtx = await getBundleContext(db, record.bundleId);
    await requireBundleCapability(db, userId, "run_services", bundleCtx);
  } catch (err) {
    if (err instanceof YapError && err.code === "not_found") throw notFound("run", runId);
    throw err;
  }
  return record;
}

export async function listRuns(
  env: RunEnv,
  userId: string,
  bundleId: string,
  /** `limit` arrives as a raw query string from REST and as a number from
   *  in-process callers; `clampLimit` accepts either. */
  opts: { service?: string; cursor?: string; limit?: number | string },
): Promise<{ data: RunRecord[]; nextCursor: string | null }> {
  const { db } = env;
  const bundleCtx = await getBundleContext(db, bundleId);
  await requireBundleCapability(db, userId, "run_services", bundleCtx);

  const conditions = [eq(db.tables.runs.bundleId, bundleId)];
  // A blank filter is "no filter" — an empty `?service=` should not read as
  // the flattening mistake resolveService warns about.
  if (opts.service !== undefined && opts.service.trim() !== "") {
    const service = await resolveService(db, bundleId, opts.service);
    conditions.push(eq(db.tables.runs.serviceId, service.id));
  }

  const limit = clampLimit(opts.limit);
  const offset = decodeCursor(opts.cursor);
  const { runs } = db.tables;
  const rows = await db.client
    .select()
    .from(runs)
    .where(and(...conditions))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(limit + 1)
    .offset(offset);

  const page = toPage(rows, offset, limit);
  return { data: page.data.map(toRecord), nextCursor: page.nextCursor };
}

/**
 * Boot housekeeping: a run that was in flight when the process died has no one
 * left to finish it, so it is retired rather than left to look live forever.
 *
 * This assumes a single yap process owns the database — running it while
 * another instance is live would kill that instance's in-flight runs, since
 * "in flight" and "abandoned" look identical from the row.
 */
export async function recoverInterruptedRuns(db: Db): Promise<number> {
  const { runs } = db.tables;
  const stranded = await db.client.select({ id: runs.id }).from(runs).where(inArray(runs.status, INTERRUPTED));
  if (stranded.length === 0) return 0;
  await db.client
    .update(runs)
    .set({ status: "failed", error: "interrupted by server restart", finishedAt: nowIso() })
    .where(
      inArray(
        runs.id,
        stranded.map((row) => row.id),
      ),
    );
  return stranded.length;
}

/** Retention sweep: finished runs older than the window are deleted. */
export async function pruneRuns(db: Db, retentionDays: number, nowMs?: number): Promise<number> {
  const { runs } = db.tables;
  const cutoff = new Date((nowMs ?? Date.now()) - retentionDays * 86_400_000).toISOString();
  const where = and(inArray(runs.status, TERMINAL), isNotNull(runs.finishedAt), lt(runs.finishedAt, cutoff));
  const doomed = await db.client.select({ id: runs.id }).from(runs).where(where);
  if (doomed.length === 0) return 0;
  await db.client.delete(runs).where(
    inArray(
      runs.id,
      doomed.map((row) => row.id),
    ),
  );
  return doomed.length;
}
