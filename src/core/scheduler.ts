/**
 * The service scheduler: the in-process half of schedules (see schedules.ts for
 * the record). One croner job per enabled schedule; each tick goes through
 * `runService` like any other caller, as the schedule's owner, with source
 * `schedule`.
 *
 * What one tick does (`fire`), in order:
 *
 * 1. Re-read the row. Gone (its service, bundle or owner was deleted and the
 *    row cascaded away) or disabled: stop this job and do nothing.
 * 2. Overlap. If the run this schedule last started is still `queued` or
 *    `running`, the tick is skipped and `last_skipped_at` records it — no run,
 *    and no failed run either. croner's `protect` only covers the moment it
 *    takes to *start* a run (runService returns once the row exists), so this
 *    check against the run row is the real guard; a pruned or missing last run
 *    counts as finished. An in-memory set covers the gap between two ticks of
 *    the same schedule landing at once (a job replaced mid-tick).
 * 3. Capability. `run_services` is re-checked for the owner on every fire. If
 *    it is gone — denied (403) or every foothold in the bundle lost (404) —
 *    the schedule disables itself, records why, and no run starts.
 * 4. Start the run. Any other refusal (the service's params changed under the
 *    schedule, its driver was uninstalled) is recorded in `last_error` and the
 *    schedule stays on: the next tick may well succeed.
 *
 * The scheduler writes only the columns it owns (`last_*`, and `enabled` on a
 * capability loss), so an edit landing mid-tick is never overwritten.
 *
 * Every fire runs outside any request's token scope (`runOutsideTokenAuth`):
 * jobs are armed while a schedule edit is being handled, and a timer inherits
 * the async context it was created in, so without it the owner would be judged
 * against the editor's token.
 *
 * Missed ticks are not caught up: a job armed at boot or on reload simply
 * waits for its next time. And one scheduler per database is the operator's
 * job (`YAP_SCHEDULER`), not enforced here — two processes with it on would
 * each fire every schedule, which is the same assumption the backup scheduler
 * and boot-time run recovery already make.
 */
import { eq } from "drizzle-orm";
import { Cron } from "croner";

import type { YapLogger } from "../logger.js";
import { runOutsideTokenAuth } from "./authScope.js";
import { getBundleContext, requireBundleCapability } from "./bundles.js";
import { YapError } from "./errors.js";
import { IN_FLIGHT, runService, type RunEnv } from "./runs.js";
import { cronOptions, type ScheduleReloader, type ScheduleRow } from "./schedules.js";
import { nowIso } from "./util.js";

export type FireOutcome =
  | { kind: "gone" }
  | { kind: "disabled" }
  | { kind: "skipped" }
  | { kind: "capability_lost"; reason: string }
  | { kind: "error"; error: string }
  | { kind: "started"; runId: string };

export interface Scheduler extends ScheduleReloader {
  /** Loads every enabled schedule and arms it. */
  start(): Promise<void>;
  /** Disarms everything; reloads after this are no-ops until the next start. */
  stop(): void;
  /** Whether `start` has been called (and `stop` has not). */
  readonly started: boolean;
  /** One tick of one schedule, exactly as its job would run it. */
  fire(scheduleId: string): Promise<FireOutcome>;
}

interface Armed {
  job: Cron;
  /** What the job was armed with; a change to either means a new job. */
  key: string;
}

export function createScheduler(env: RunEnv & { logger?: YapLogger }): Scheduler {
  const { db } = env;
  const { schedules, runs } = db.tables;
  const jobs = new Map<string, Armed>();
  const firing = new Set<string>();
  let started = false;
  // Reloads run one at a time, in the order they were asked for: each re-reads
  // the row it is about, so the last one for a schedule always wins.
  let queue: Promise<void> = Promise.resolve();

  const setRow = (id: string, values: Partial<ScheduleRow>) =>
    db.client.update(schedules).set(values).where(eq(schedules.id, id));

  /** Stops the schedule's job — only `job` if given, so a stale tick cannot
   *  stop the job a newer reload armed in its place. */
  function disarm(id: string, job?: Cron): void {
    const armed = jobs.get(id);
    if (!armed || (job && armed.job !== job)) return;
    armed.job.stop();
    jobs.delete(id);
  }

  async function fireOnce(id: string, job?: Cron): Promise<FireOutcome> {
    const rows = await db.client.select().from(schedules).where(eq(schedules.id, id));
    const row = rows[0];
    if (!row) {
      disarm(id, job);
      return { kind: "gone" };
    }
    if (row.enabled !== 1) {
      disarm(id, job);
      return { kind: "disabled" };
    }

    const now = nowIso();
    if (row.lastRunId) {
      const last = await db.client.select({ status: runs.status }).from(runs).where(eq(runs.id, row.lastRunId));
      if (last[0] && IN_FLIGHT.includes(last[0].status as (typeof IN_FLIGHT)[number])) {
        await setRow(id, { lastSkippedAt: now });
        return { kind: "skipped" };
      }
    }

    try {
      const ctx = await getBundleContext(db, row.bundleId);
      await requireBundleCapability(db, row.ownerId, "run_services", ctx);
    } catch (err) {
      if (err instanceof YapError && (err.code === "forbidden" || err.code === "not_found")) {
        const reason = `disabled ${now}: the owner no longer holds run_services on this bundle`;
        await setRow(id, { enabled: 0, lastError: reason });
        disarm(id, job);
        env.logger?.warn(`schedule ${id} ${reason}`);
        return { kind: "capability_lost", reason };
      }
      throw err;
    }

    try {
      const run = await runService(env, row.ownerId, row.bundleId, {
        // By id, so renaming the service can neither break nor redirect it.
        service: row.serviceId,
        action: row.action,
        params: JSON.parse(row.params) as Record<string, unknown>,
        source: "schedule",
        scheduleId: id,
      });
      await setRow(id, { lastFiredAt: now, lastRunId: run.id, lastError: null });
      return { kind: "started", runId: run.id };
    } catch (err) {
      // A YapError's message is agent-safe by contract; anything else may not
      // be, so the row gets a flat line and the detail goes to the server log.
      const error = err instanceof YapError ? err.message : "run could not be started";
      await setRow(id, { lastFiredAt: now, lastError: error });
      env.logger?.warn(`schedule ${id} did not start a run`, err);
      return { kind: "error", error };
    }
  }

  function fire(id: string, job?: Cron): Promise<FireOutcome> {
    return runOutsideTokenAuth(async () => {
      if (firing.has(id)) {
        await setRow(id, { lastSkippedAt: nowIso() });
        return { kind: "skipped" } as const;
      }
      firing.add(id);
      try {
        return await fireOnce(id, job);
      } finally {
        firing.delete(id);
      }
    });
  }

  function arm(row: ScheduleRow): void {
    const key = `${row.cron}\n${row.timezone}`;
    const armed = jobs.get(row.id);
    // Unchanged timing keeps its job: replacing it would recompute the next run
    // from "now" and could drop a tick that was due during the reload.
    if (armed?.key === key) return;
    armed?.job.stop();
    const job: Cron = new Cron(row.cron, { ...cronOptions(row.timezone), protect: true, unref: true }, async () => {
      try {
        await fire(row.id, job);
      } catch (err) {
        // A tick never takes the server down.
        env.logger?.error(`schedule ${row.id} tick failed`, err);
      }
    });
    jobs.set(row.id, { job, key });
  }

  /** Brings the jobs in line with the table: one row, or (at start) all of them. */
  async function sync(id?: string): Promise<void> {
    const rows = await db.client
      .select()
      .from(schedules)
      .where(id === undefined ? eq(schedules.enabled, 1) : eq(schedules.id, id));
    // A stop that landed while the read was in flight wins: nothing is re-armed.
    if (!started) return;
    if (id !== undefined && rows[0]?.enabled !== 1) disarm(id);
    for (const row of rows) {
      if (row.enabled !== 1) continue;
      try {
        arm(row);
      } catch (err) {
        // Validated at write time; one row croner no longer accepts must not
        // keep every other schedule from arming.
        env.logger?.error(`schedule ${row.id} could not be armed`, err);
      }
    }
  }

  function enqueue(id?: string): Promise<void> {
    queue = queue.then(async () => {
      if (!started) return;
      try {
        await sync(id);
      } catch (err) {
        env.logger?.error(`schedule reload failed${id ? ` for ${id}` : ""}`, err);
      }
    });
    return queue;
  }

  return {
    get started() {
      return started;
    },
    async start() {
      started = true;
      await enqueue();
    },
    stop() {
      started = false;
      for (const id of [...jobs.keys()]) disarm(id);
    },
    reload: (scheduleId: string) => enqueue(scheduleId),
    fire: (scheduleId: string) => fire(scheduleId),
  };
}
