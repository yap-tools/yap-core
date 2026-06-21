/**
 * Run execution behind a small interface so the worker and scheduler never
 * touch Docker directly. DockerExecutor shells out to the `docker` CLI (no new
 * runtime dependency); FakeExecutor gives tests a deterministic result.
 *
 * Secrets (the injected Yap key and model token) are passed to the container by
 * NAME only on the command line (`-e KEY`) with the values supplied through the
 * docker client's own environment — so they never appear in argv / `ps`.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

export interface RunSpec {
  /** Container name (derived from the run id) — used to kill on timeout. */
  name: string;
  image: string;
  command: string[];
  /** Env injected into the container (secrets included). */
  env: Record<string, string>;
  /** Files staged on the host, mounted read-only into the container. */
  files: { hostPath: string; containerPath: string }[];
  limits: { cpus: string; memoryMb: number; timeoutMs: number };
}

export interface RunResult {
  exitCode: number;
  output: string;
  logs: string;
  timedOut?: boolean;
  /** The container engine binary was not found — maps to runtime_unavailable. */
  dockerMissing?: boolean;
}

export interface RuntimeExecutor {
  run(spec: RunSpec): Promise<RunResult>;
}

/** Deterministic executor for tests; records the last spec it was given. */
export class FakeExecutor implements RuntimeExecutor {
  lastSpec?: RunSpec;
  constructor(private readonly result: Partial<RunResult> = {}) {}
  async run(spec: RunSpec): Promise<RunResult> {
    this.lastSpec = spec;
    return { exitCode: 0, output: "", logs: "", ...this.result };
  }
}

export type SpawnFn = typeof nodeSpawn;

/** The `docker run` argument vector (secrets are env names only, never values).
 * The run executes model-influenced commands, so drop Linux capabilities and
 * cap pids in addition to cpu/memory. Network is left on — the container must
 * reach Yap and the model provider. */
export function buildDockerArgs(spec: RunSpec): string[] {
  return [
    "run",
    "--rm",
    "--name",
    spec.name,
    "--cap-drop",
    "ALL",
    "--pids-limit",
    "256",
    "--cpus",
    spec.limits.cpus,
    "--memory",
    `${spec.limits.memoryMb}m`,
    ...Object.keys(spec.env).flatMap((k) => ["-e", k]),
    ...spec.files.flatMap((f) => ["-v", `${f.hostPath}:${f.containerPath}:ro`]),
    spec.image,
    ...spec.command,
  ];
}

const MAX_BUFFER_BYTES = 1_000_000;

/** Accumulates a stream up to a byte cap so unbounded container output can't
 * exhaust server memory. */
function boundedCollector(max: number) {
  let buf = "";
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk: string): void {
      if (bytes >= max) {
        truncated = true;
        return;
      }
      const add = Buffer.byteLength(chunk);
      if (bytes + add <= max) {
        buf += chunk;
        bytes += add;
      } else {
        // Slice by bytes, not characters, so the cap is honoured for multibyte.
        buf += Buffer.from(chunk, "utf8").subarray(0, max - bytes).toString("utf8");
        bytes = max;
        truncated = true;
      }
    },
    value(): string {
      return truncated ? `${buf}\n[truncated]` : buf;
    },
  };
}

export class DockerExecutor implements RuntimeExecutor {
  private readonly dockerBin: string;
  private readonly spawnImpl: SpawnFn;

  constructor(opts: { dockerBin: string; spawnImpl?: SpawnFn }) {
    this.dockerBin = opts.dockerBin;
    this.spawnImpl = opts.spawnImpl ?? nodeSpawn;
  }

  async run(spec: RunSpec): Promise<RunResult> {
    const args = buildDockerArgs(spec);
    const child: ChildProcess = this.spawnImpl(this.dockerBin, args, {
      env: { ...process.env, ...spec.env },
    });

    const out = boundedCollector(MAX_BUFFER_BYTES);
    const log = boundedCollector(MAX_BUFFER_BYTES);
    child.stdout?.on("data", (d: Buffer | string) => out.push(d.toString()));
    child.stderr?.on("data", (d: Buffer | string) => log.push(d.toString()));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      // Best-effort: stop the container the killed client may have left
      // running. The kill child's failure is an async 'error' event — swallow
      // it explicitly, or an unhandled event would crash the process.
      try {
        this.spawnImpl(this.dockerBin, ["kill", spec.name]).on("error", () => {});
      } catch {
        // ignore
      }
    }, spec.limits.timeoutMs);

    return await new Promise<RunResult>((resolve) => {
      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === "ENOENT") {
          resolve({ exitCode: 127, output: out.value(), logs: `${log.value()}\n${this.dockerBin} not found`, dockerMissing: true });
          return;
        }
        resolve({ exitCode: 1, output: out.value(), logs: `${log.value()}\n${err.message}` });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({ exitCode: timedOut ? 124 : code ?? 1, output: out.value(), logs: log.value(), timedOut });
      });
    });
  }
}
