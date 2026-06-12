/**
 * serve/start/stop/status/logs — the instance lifecycle. `serve` always
 * executes the instance's vendored server so the running version is the
 * directory's, never the global CLI's.
 */
import { openSync, readSync, statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { instanceBaseUrl, loadInstanceEnv } from "../instance/env.js";
import { CliError } from "../instance/errors.js";
import { logPath } from "../instance/layout.js";
import { runningPid, startInstance, stopInstance, tailLog } from "../instance/proc.js";
import { execInServer, vendoredServerVersion } from "../instance/server.js";

/**
 * Foreground serve. Delegates to the vendored server when the directory has
 * one that isn't this very process (`self` keeps a repo checkout, and the
 * vendored copy itself, serving in-process).
 */
export async function cmdServe(dir: string): Promise<void> {
  const r = await execInServer(dir, ["serve"]);
  if (r.status === "ran") process.exit(r.code);
  // In-process serve exists for repo checkouts. The manager-only CLI package
  // (yap-cli) deliberately ships without serve.js and the server's deps.
  let serve: () => Promise<void>;
  try {
    serve = (await import("../serve.js")).serve;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw err;
    throw new CliError("no server installed here — `yap init` first (instances vendor their own server)");
  }
  await serve();
}

export async function cmdStart(dir: string): Promise<void> {
  const pid = startInstance(dir);
  const baseUrl = instanceBaseUrl(loadInstanceEnv(dir));
  for (let waited = 0; waited < 15_000; waited += 300) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        console.log(`started (pid ${pid}) — ${baseUrl}`);
        return;
      }
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  console.error(`started pid ${pid}, but ${baseUrl}/health has not answered after 15s — check \`yap logs\``);
  process.exit(1);
}

export async function cmdStop(dir: string): Promise<void> {
  const pid = await stopInstance(dir);
  console.log(`stopped (pid ${pid})`);
}

export async function cmdStatus(dir: string): Promise<void> {
  const pid = runningPid(dir);
  const baseUrl = instanceBaseUrl(loadInstanceEnv(dir));
  let health = "unreachable";
  try {
    const res = await fetch(`${baseUrl}/health`);
    health = res.ok ? "ok" : `status ${res.status}`;
  } catch {
    // unreachable
  }
  console.log(`instance   ${dir}`);
  console.log(`server     ${vendoredServerVersion(dir) ?? "(not installed)"}`);
  console.log(`process    ${pid ? `running (pid ${pid})` : "not running (via yap start)"}`);
  console.log(`health     ${health} (${baseUrl}/health)`);
  if (!pid && health === "ok") {
    console.log("note: answering but not started by `yap start` — foreground shell or service manager.");
  }
}

export async function cmdLogs(dir: string, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { follow: { type: "boolean", short: "f" }, lines: { type: "string", short: "n" } },
  });
  const lines = values.lines ? Number(values.lines) : 50;
  const existing = tailLog(dir, Number.isFinite(lines) && lines > 0 ? lines : 50);
  if (existing) console.log(existing);

  if (!values.follow) return;
  const path = logPath(dir);
  let offset = (() => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  })();
  for (;;) {
    await sleep(500);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    if (size < offset) offset = 0; // rotated/truncated
    if (size === offset) continue;
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    offset = size;
    process.stdout.write(buf.toString("utf8"));
  }
}
