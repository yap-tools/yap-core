/**
 * Per-agent run scheduler, reusing the in-process croner the backup scheduler
 * uses. One Cron job per agent that declares a `schedule`; on each tick it
 * fires a scheduled run via the injected callback (which enqueues the run,
 * nudges the worker, and skips agents whose runtime credential is stale).
 *
 * Agent create/update/delete calls reload(), so a schedule change re-registers
 * or removes that agent's job without a restart. A bad cron string is logged
 * and skipped — never fatal.
 */
import { Cron } from "croner";
import { eq } from "drizzle-orm";

import type { Db } from "../db/index.js";
import type { YapLogger } from "../logger.js";

export interface SchedulerDeps {
  db: Db;
  /** Fire one scheduled run for the agent (enqueue + kick + stale handling). */
  fire: (agentId: string) => Promise<void>;
}

export interface AgentScheduler {
  stop(): void;
  /** Re-read one agent's schedule and (re)register or remove its job. */
  reload(agentId: string): Promise<void>;
  remove(agentId: string): void;
}

export async function startAgentScheduler(deps: SchedulerDeps, logger: YapLogger): Promise<AgentScheduler> {
  const jobs = new Map<string, Cron>();

  const remove = (agentId: string): void => {
    jobs.get(agentId)?.stop();
    jobs.delete(agentId);
  };

  const register = (agentId: string, schedule: string): void => {
    remove(agentId);
    try {
      // protect: skip a tick if the previous run is still firing.
      const job = new Cron(schedule, { protect: true }, async () => {
        try {
          await deps.fire(agentId);
        } catch (err) {
          logger.error(`scheduled run for agent ${agentId} failed`, err);
        }
      });
      jobs.set(agentId, job);
    } catch (err) {
      logger.error(`invalid schedule "${schedule}" for agent ${agentId} — not scheduled`, err);
    }
  };

  const reload = async (agentId: string): Promise<void> => {
    const { agents } = deps.db.tables;
    const rows = await deps.db.client.select({ schedule: agents.schedule }).from(agents).where(eq(agents.id, agentId));
    const schedule = rows[0]?.schedule;
    if (schedule) register(agentId, schedule);
    else remove(agentId);
  };

  // Initial load: register every agent that already has a schedule.
  const { agents } = deps.db.tables;
  const all = await deps.db.client.select({ id: agents.id, schedule: agents.schedule }).from(agents);
  for (const a of all) if (a.schedule) register(a.id, a.schedule);

  return {
    reload,
    remove,
    stop: () => {
      for (const job of jobs.values()) job.stop();
      jobs.clear();
    },
  };
}
