/**
 * Agent runs: the append-only history of container executions, plus the queue
 * state machine the worker drives. Runs are serialized per agent — the worker
 * never claims a queued run for an agent that already has one running — which
 * bounds resource use and removes credential-refresh races.
 *
 * Lifecycle: queued → running → succeeded | failed | canceled.
 */
import { and, asc, eq } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { loadAgentForRead, loadAgentForRun } from "./agents.js";
import { notFound } from "./errors.js";
import { nowIso, newId } from "./util.js";

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
export type RunTrigger = "manual" | "scheduled";
export type RunError = "timeout" | "stale_credential" | "runtime_unavailable" | "container_error";

export interface RunInfo {
  id: string;
  agentId: string;
  status: RunStatus;
  trigger: RunTrigger;
  args: unknown;
  exitCode: number | null;
  error: string | null;
  output: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunRow {
  id: string;
  agentId: string;
  status: string;
  trigger: string;
  triggeredBy: string | null;
  args: string | null;
  exitCode: number | null;
  error: string | null;
  output: string | null;
  logsKey: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function toRunInfo(row: RunRow): RunInfo {
  return {
    id: row.id,
    agentId: row.agentId,
    status: row.status as RunStatus,
    trigger: row.trigger as RunTrigger,
    args: row.args ? JSON.parse(row.args) : null,
    exitCode: row.exitCode,
    error: row.error,
    output: row.output,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

async function getRunRow(db: Db, runId: string): Promise<RunRow> {
  const { agentRuns } = db.tables;
  const rows = await db.client.select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (rows.length === 0) throw notFound("run", runId);
  return rows[0]! as RunRow;
}

/** Queue a run. Capability checks belong to the caller (run_agent / scheduler). */
export async function enqueueRun(
  db: Db,
  agentId: string,
  opts: { trigger: RunTrigger; triggeredBy?: string; args?: unknown },
): Promise<{ run_id: string; status: "queued" }> {
  const { agentRuns } = db.tables;
  const id = newId();
  await db.client.insert(agentRuns).values({
    id,
    agentId,
    status: "queued",
    trigger: opts.trigger,
    triggeredBy: opts.triggeredBy ?? null,
    args: opts.args === undefined ? null : JSON.stringify(opts.args),
    exitCode: null,
    error: null,
    output: null,
    logsKey: null,
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
  });
  return { run_id: id, status: "queued" };
}

/**
 * Trigger an on-demand run: requires run_agents on the agent's space, records
 * the effective args, and queues the run. The run then acts with the agent's
 * bound key — a separate authority from the caller's.
 */
export async function triggerRun(
  db: Db,
  userId: string,
  agentId: string,
  args?: unknown,
): Promise<{ run_id: string; status: "queued" }> {
  await loadAgentForRun(db, userId, agentId);
  return enqueueRun(db, agentId, { trigger: "manual", triggeredBy: userId, args });
}

export async function listRuns(db: Db, userId: string, agentId: string): Promise<RunInfo[]> {
  await loadAgentForRead(db, userId, agentId);
  const { agentRuns } = db.tables;
  const rows = await db.client
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.agentId, agentId))
    .orderBy(asc(agentRuns.createdAt), asc(agentRuns.id));
  return (rows as RunRow[]).map(toRunInfo);
}

export async function getRun(db: Db, userId: string, runId: string): Promise<RunInfo> {
  const row = await getRunRow(db, runId);
  await loadAgentForRead(db, userId, row.agentId);
  return toRunInfo(row);
}

/** The blob key for a run's logs, re-checking read access. Null if no logs. */
export async function getRunLogsKey(db: Db, userId: string, runId: string): Promise<string | null> {
  const row = await getRunRow(db, runId);
  await loadAgentForRead(db, userId, row.agentId);
  return row.logsKey;
}

/**
 * Claim the oldest queued run whose agent has no run already in flight, marking
 * it running. Returns null when nothing is claimable. The guarded UPDATE makes
 * the claim atomic even though a single worker means no real contention.
 */
export async function claimNextQueued(db: Db): Promise<RunRow | null> {
  const { agentRuns } = db.tables;
  const running = await db.client
    .select({ agentId: agentRuns.agentId })
    .from(agentRuns)
    .where(eq(agentRuns.status, "running"));
  const busy = new Set(running.map((r) => r.agentId));
  const queued = (await db.client
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.status, "queued"))
    .orderBy(asc(agentRuns.createdAt), asc(agentRuns.id))) as RunRow[];
  const next = queued.find((r) => !busy.has(r.agentId));
  if (!next) return null;
  const claimed = await db.client
    .update(agentRuns)
    .set({ status: "running", startedAt: nowIso() })
    .where(and(eq(agentRuns.id, next.id), eq(agentRuns.status, "queued")))
    .returning({ id: agentRuns.id });
  if (claimed.length === 0) return null;
  return { ...next, status: "running", startedAt: nowIso() };
}

export interface CompleteFields {
  status: Extract<RunStatus, "succeeded" | "failed" | "canceled">;
  exitCode?: number | null;
  error?: RunError | null;
  output?: string | null;
  logsKey?: string | null;
}

/** Record a terminal state. Tolerates a vanished row (agent deleted mid-run). */
export async function completeRun(db: Db, runId: string, fields: CompleteFields): Promise<void> {
  const { agentRuns } = db.tables;
  await db.client
    .update(agentRuns)
    .set({
      status: fields.status,
      exitCode: fields.exitCode ?? null,
      error: fields.error ?? null,
      output: fields.output ?? null,
      logsKey: fields.logsKey ?? null,
      finishedAt: nowIso(),
    })
    .where(eq(agentRuns.id, runId));
}

/** Runs still in flight (running) — used at shutdown to cancel them. */
export async function listInFlightRuns(db: Db): Promise<RunRow[]> {
  const { agentRuns } = db.tables;
  return (await db.client.select().from(agentRuns).where(eq(agentRuns.status, "running"))) as RunRow[];
}
