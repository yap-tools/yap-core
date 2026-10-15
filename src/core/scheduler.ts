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
import { runService, type RunEnv } from "./runs.js";
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
  /** Disarms everything; a reload after this is a no-op. */
  stop(): void;
  /** Whether `start` has been called (and `stop` has not). */
  readonly started: boolean;
  /** One tick of one schedule, exactly as its job would run it. */
  fire(scheduleId: string): Promise<FireOutcome>;
}

const IN_FLIGHT = new Set(["queued", "running"]);

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
  // Reloads are serialized, and a burst of them collapses into one more pass:
  // each reload reads the whole table, so the last one always sees every edit.
  let reloading: Promise<void> | null = null;
  let reloadAgain = false;

  const setRow = (id: string, values: Partial<ScheduleRow>) =>
    db.client.update(schedules).set(values).where(eq(schedules.id, id));

  function disarm(id: string): void {
    jobs.get(id)?.job.stop();
    jobs.delete(id);
  }

  async function fireOnce(id: string): Promise<FireOutcome> {
    const rows = await db.client.select().from(schedules).where(eq(schedules.id, id));
    const row = rows[0];
    if (!row) {
      disarm(id);
      return { kind: "gone" };
    }
    if (row.enabled !== 1) {
      disarm(id);
      return { kind: "disabled" };
    }

    const now = nowIso();
    if (row.lastRunId) {
      const last = await db.client.select({ status: runs.status }).from(runs).where(eq(runs.id, row.lastRunId));
      if (last[0] && IN_FLIGHT.has(last[0].status)) {
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
        disarm(id);
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
      env.logger?.warn(`schedule ${id} did not start a run: ${String((err as Error | undefined)?.message ?? err)}`);
      return { kind: "error", error };
    }
  }

  function fire(id: string): Promise<FireOutcome> {
    return runOutsideTokenAuth(async () => {
      if (firing.has(id)) {
        await setRow(id, { lastSkippedAt: nowIso() });
        return { kind: "skipped" } as const;
      }
      firing.add(id);
      try {
        return await fireOnce(id);
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
    const job = runOutsideTokenAuth(
      () =>
        new Cron(row.cron, { ...cronOptions(row.timezone), protect: true, unref: true }, async () => {
          try {
            await fire(row.id);
          } catch (err) {
            // A tick never takes the server down.
            env.logger?.error(`schedule ${row.id} tick failed`, err);
          }
        }),
    );
    jobs.set(row.id, { job, key });
  }

  async function reloadOnce(): Promise<void> {
    const rows = await db.client.select().from(schedules).where(eq(schedules.enabled, 1));
    const enabled = new Set(rows.map((r) => r.id));
    for (const id of [...jobs.keys()]) if (!enabled.has(id)) disarm(id);
    for (const row of rows) {
      try {
        arm(row);
      } catch (err) {
        // Validated at write time; one row croner no longer accepts must not
        // keep every other schedule from arming.
        env.logger?.error(`schedule ${row.id} could not be armed`, err);
      }
    }
  }

  async function reload(): Promise<void> {
    if (!started) return;
    if (reloading) {
      reloadAgain = true;
      return reloading;
    }
    reloading = (async () => {
      try {
        do {
          reloadAgain = false;
          await reloadOnce();
        } while (reloadAgain && started);
      } catch (err) {
        env.logger?.error("schedule reload failed", err);
      } finally {
        reloading = null;
      }
    })();
    return reloading;
  }

  return {
    get started() {
      return started;
    },
    async start() {
      started = true;
      await reload();
    },
    stop() {
      started = false;
      for (const id of [...jobs.keys()]) disarm(id);
    },
    reload,
    fire,
  };
}
