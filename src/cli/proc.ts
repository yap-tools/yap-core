/**
 * Detached lifecycle for an instance: `yap start` spawns the instance's
 * server with its output in .yap/logs/ and its pid in .yap/yap.pid. This is
 * convenience, not supervision — it survives the terminal, not a reboot or a
 * crash; `yap service install` hands those to the OS.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { vendoredServerEntry } from "./install.js";
import { CliError } from "./util.js";

export function pidPath(dir: string): string {
  return join(dir, ".yap", "yap.pid");
}

export function logPath(dir: string): string {
  return join(dir, ".yap", "logs", "yap.log");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The recorded pid if that process is still alive; stale pidfiles are cleaned. */
export function runningPid(dir: string): number | undefined {
  const path = pidPath(dir);
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, "utf8").trim());
  if (Number.isInteger(pid) && pid > 0 && alive(pid)) return pid;
  rmSync(path, { force: true });
  return undefined;
}

/** The server entry `start`/`serve` should execute for this instance. */
export function serverEntry(dir: string): string {
  const vendored = vendoredServerEntry(dir);
  if (vendored) return vendored;
  throw new CliError(
    "no server installed in this directory — run `yap init` (or `yap init --no-install` plus a manual install) first",
  );
}

export function startInstance(dir: string): number {
  const existing = runningPid(dir);
  if (existing) throw new CliError(`already running (pid ${existing}) — \`yap stop\` first`);

  const entry = serverEntry(dir);
  mkdirSync(join(dir, ".yap", "logs"), { recursive: true });
  const log = openSync(logPath(dir), "a");
  const child = spawn(process.execPath, [entry, "serve"], {
    cwd: dir,
    detached: true,
    stdio: ["ignore", log, log],
  });
  if (child.pid === undefined) throw new CliError("failed to spawn the server process");
  writeFileSync(pidPath(dir), `${child.pid}\n`);
  child.unref();
  return child.pid;
}

export async function stopInstance(dir: string): Promise<number> {
  const pid = runningPid(dir);
  if (!pid) throw new CliError("not running (no live pid in .yap/yap.pid)");
  process.kill(pid, "SIGTERM");
  for (let waited = 0; waited < 10_000; waited += 200) {
    if (!alive(pid)) {
      rmSync(pidPath(dir), { force: true });
      return pid;
    }
    await sleep(200);
  }
  process.kill(pid, "SIGKILL");
  rmSync(pidPath(dir), { force: true });
  throw new CliError(`pid ${pid} ignored SIGTERM for 10s — sent SIGKILL`);
}

export function tailLog(dir: string, lines: number): string {
  const path = logPath(dir);
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf8");
  return content.split("\n").slice(-(lines + 1)).join("\n");
}
