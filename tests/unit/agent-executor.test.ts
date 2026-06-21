/**
 * The Docker executor's argument construction and process handling, exercised
 * through an injected fake spawn — no real daemon. The real container run
 * against a live image is, by design, not verifiable here.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { buildDockerArgs, DockerExecutor, FakeExecutor, type RunSpec, type SpawnFn } from "../../src/agent/executor.js";

function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    name: "yap-run-1",
    image: "yap/mock-runtime:latest",
    command: ["/bin/run-agent"],
    env: { YAP_ACCESS_KEY: "secret-key", MODEL_TOKEN: "secret-token" },
    files: [{ hostPath: "/tmp/staged/data.txt", containerPath: "/agent/files/data.txt" }],
    limits: { cpus: "1", memoryMb: 512, timeoutMs: 1000 },
    ...overrides,
  };
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe("buildDockerArgs", () => {
  it("builds a hardened run invocation with secrets passed by name only", () => {
    const args = buildDockerArgs(spec());
    expect(args.slice(0, 4)).toEqual(["run", "--rm", "--name", "yap-run-1"]);
    expect(args).toContain("--cpus");
    expect(args).toContain("--memory");
    expect(args[args.indexOf("--memory") + 1]).toBe("512m");
    // Env vars appear as `-e NAME` (no value) — the value travels in the
    // docker client's environment, never argv.
    expect(args).toContain("YAP_ACCESS_KEY");
    expect(args.join(" ")).not.toContain("secret-key");
    // Read-only mount.
    expect(args).toContain("/tmp/staged/data.txt:/agent/files/data.txt:ro");
    // Image then command at the tail.
    expect(args.slice(-2)).toEqual(["yap/mock-runtime:latest", "/bin/run-agent"]);
  });
});

describe("DockerExecutor", () => {
  it("captures stdout as output, stderr as logs, and the exit code", async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as SpawnFn;
    const exec = new DockerExecutor({ dockerBin: "docker", spawnImpl });

    const p = exec.run(spec());
    child.stdout.emit("data", "the result");
    child.stderr.emit("data", "a log line");
    child.emit("close", 0);
    const res = await p;

    expect(res).toMatchObject({ exitCode: 0, output: "the result", logs: "a log line" });
    // Secrets travel via the spawned process's env, not argv.
    const mockFn = spawnImpl as unknown as ReturnType<typeof vi.fn>;
    const opts = mockFn.mock.calls[0]![2] as { env: Record<string, string> };
    expect(opts.env.YAP_ACCESS_KEY).toBe("secret-key");
  });

  it("propagates a non-zero exit code", async () => {
    const child = fakeChild();
    const exec = new DockerExecutor({ dockerBin: "docker", spawnImpl: (() => child) as unknown as SpawnFn });
    const p = exec.run(spec());
    child.emit("close", 3);
    expect(await p).toMatchObject({ exitCode: 3 });
  });

  it("flags a missing docker binary", async () => {
    const child = fakeChild();
    const exec = new DockerExecutor({ dockerBin: "docker", spawnImpl: (() => child) as unknown as SpawnFn });
    const p = exec.run(spec());
    const err: NodeJS.ErrnoException = new Error("spawn docker ENOENT");
    err.code = "ENOENT";
    child.emit("error", err);
    expect(await p).toMatchObject({ dockerMissing: true });
  });

  it("kills the container and reports a timeout", async () => {
    const child = fakeChild();
    const kills: string[][] = [];
    const spawnImpl = vi.fn((_bin: string, args: string[]) => {
      kills.push(args);
      return child;
    }) as unknown as SpawnFn;
    const exec = new DockerExecutor({ dockerBin: "docker", spawnImpl });

    const p = exec.run(spec({ limits: { cpus: "1", memoryMb: 256, timeoutMs: 10 } }));
    await new Promise((r) => setTimeout(r, 30));
    child.emit("close", null);
    const res = await p;

    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(124);
    expect(child.kill).toHaveBeenCalled();
    expect(kills.some((a) => a[0] === "kill")).toBe(true); // best-effort docker kill
  });
});

describe("FakeExecutor", () => {
  it("returns the configured result and records the spec", async () => {
    const exec = new FakeExecutor({ exitCode: 0, output: "ok" });
    const s = spec();
    const res = await exec.run(s);
    expect(res.output).toBe("ok");
    expect(exec.lastSpec).toBe(s);
  });
});
