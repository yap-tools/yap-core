/**
 * The agent run worker: an in-process background loop that drains the run
 * queue. Runs are processed one at a time (which trivially honours the
 * per-agent serialization the queue enforces and bounds total resource use).
 *
 * Per run: load the agent, resolve its runtime and credential (refreshing and
 * persisting the rotated blob as needed), decrypt the bound Yap key, stage
 * attached files read-only, execute the container, then persist logs, output,
 * and a terminal status. Nothing is retried; every terminal state carries a
 * typed reason where it failed.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BlobStore } from "../blob/index.js";
import type { YapConfig } from "../config.js";
import { decryptAgentKey, getAgentRow } from "../core/agents.js";
import { listFinalizedAgentFiles } from "../core/agentFiles.js";
import { claimNextQueued, completeRun, listInFlightRuns } from "../core/agentRuns.js";
import { resolveAccessToken } from "../core/runtimeCredentials.js";
import type { Db } from "../db/index.js";
import type { YapLogger } from "../logger.js";
import { getRuntime as registryGetRuntime, runtimeAcceptsModel, type Runtime } from "./runtimes/index.js";
import type { RuntimeExecutor, RunSpec } from "./executor.js";

const IDLE_POLL_MS = 2000;

export interface WorkerDeps {
  db: Db;
  blob: BlobStore;
  config: YapConfig;
  executor: RuntimeExecutor;
  getRuntime?: (name: string) => Runtime | null;
}

function truncate(s: string, maxBytes: number): string {
  return s.length > maxBytes ? s.slice(0, maxBytes) : s;
}

async function streamToBuffer(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/**
 * Process at most one queued run. Returns true if a run was claimed (whatever
 * its outcome), false if the queue was empty.
 */
export async function processOneRun(deps: WorkerDeps): Promise<boolean> {
  const { db, blob, config } = deps;
  const lookup = deps.getRuntime ?? registryGetRuntime;
  const run = await claimNextQueued(db);
  if (!run) return false;

  const logsKey = `runs/${run.id}/logs`;
  try {
    const agent = await getAgentRow(db, run.agentId);

    const runtime = lookup(agent.runtime);
    if (!runtime) {
      await completeRun(db, run.id, {
        status: "failed",
        error: "runtime_unavailable",
        output: `unknown runtime "${agent.runtime}"`,
      });
      return true;
    }
    if (!runtimeAcceptsModel(runtime, agent.model)) {
      await completeRun(db, run.id, {
        status: "failed",
        error: "runtime_unavailable",
        output: `runtime "${agent.runtime}" does not support model "${agent.model}"`,
      });
      return true;
    }

    let accessToken: string;
    try {
      ({ accessToken } = await resolveAccessToken({ db, config, getRuntime: lookup }, agent.runtime));
    } catch (err) {
      await completeRun(db, run.id, { status: "failed", error: "stale_credential", output: (err as Error).message });
      return true;
    }

    const yapKey = decryptAgentKey({ db, config }, agent);

    // Stage attached files read-only into a throwaway host directory.
    const stageDir = mkdtempSync(join(tmpdir(), `yap-run-${run.id}-`));
    try {
      const files: RunSpec["files"] = [];
      for (const f of await listFinalizedAgentFiles(db, agent.id)) {
        const buf = await streamToBuffer((await blob.getStream(f.storageKey)) as AsyncIterable<unknown>);
        const hostPath = join(stageDir, f.name);
        writeFileSync(hostPath, buf);
        files.push({ hostPath, containerPath: `/agent/files/${f.name}` });
      }

      const spec: RunSpec = {
        name: `yap-run-${run.id}`,
        image: runtime.descriptor.image,
        command: runtime.descriptor.command,
        env: {
          [runtime.descriptor.yapKeyEnv]: yapKey,
          [runtime.descriptor.modelTokenEnv]: accessToken,
          YAP_BASE_URL: config.baseUrl,
          AGENT_INSTRUCTIONS: agent.instructions,
          AGENT_ARGS: run.args ?? "",
        },
        files,
        limits: {
          cpus: config.agent.runCpus,
          memoryMb: config.agent.runMemoryMb,
          timeoutMs: config.agent.runTimeoutMs,
        },
      };

      const result = await deps.executor.run(spec);
      await blob.put(logsKey, new TextEncoder().encode(result.logs ?? ""));
      const output = truncate(result.output ?? "", config.agent.maxOutputBytes);

      if (result.dockerMissing) {
        await completeRun(db, run.id, { status: "failed", error: "runtime_unavailable", output, logsKey });
      } else if (result.timedOut) {
        await completeRun(db, run.id, { status: "failed", exitCode: result.exitCode, error: "timeout", output, logsKey });
      } else if (result.exitCode === 0) {
        await completeRun(db, run.id, { status: "succeeded", exitCode: 0, output, logsKey });
      } else {
        await completeRun(db, run.id, {
          status: "failed",
          exitCode: result.exitCode,
          error: "container_error",
          output,
          logsKey,
        });
      }
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
    }
  } catch (err) {
    await completeRun(db, run.id, { status: "failed", error: "container_error", output: (err as Error).message });
  }
  return true;
}

export interface AgentWorker {
  /** Nudge the worker to drain the queue now. */
  kick(): void;
  /** Stop claiming new runs. Any in-flight run finishes (or is reconciled to
   * 'canceled' on the next boot). */
  stop(): Promise<void>;
}

export function startAgentWorker(deps: WorkerDeps, logger: YapLogger): AgentWorker {
  let stopped = false;
  let draining: Promise<void> = Promise.resolve();

  // Crash recovery: any run left 'running' belongs to a process that died
  // mid-flight; it can never resume, so cancel it.
  const reconcile = (async () => {
    for (const orphan of await listInFlightRuns(deps.db)) {
      await completeRun(deps.db, orphan.id, { status: "canceled" });
      logger.warn(`agent run ${orphan.id} was interrupted by a restart — marked canceled`);
    }
  })().catch((err) => logger.error("agent worker reconcile failed", err));

  const drain = async (): Promise<void> => {
    await reconcile;
    while (!stopped) {
      let claimed: boolean;
      try {
        claimed = await processOneRun(deps);
      } catch (err) {
        logger.error("agent run processing failed", err);
        claimed = true; // keep draining; the failure was recorded best-effort
      }
      if (!claimed) break;
    }
  };

  const kick = (): void => {
    draining = draining.then(drain).catch((err) => logger.error("agent worker drain failed", err));
  };

  const timer = setInterval(kick, IDLE_POLL_MS);
  timer.unref?.();
  kick();

  return {
    kick,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await draining;
    },
  };
}
