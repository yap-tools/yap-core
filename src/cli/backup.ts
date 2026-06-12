/**
 * backup/restore delegation: run inside the instance's vendored server where
 * the server deps live; fall back to in-process for repo checkouts. The
 * manager-only yap-cli package ships neither serve.js nor backup/, so both
 * paths fail there with the same guidance as serve.
 */
import { spawn } from "node:child_process";

import { vendoredServerEntry } from "./install.js";
import { CliError, sameFile } from "./util.js";

async function delegated(dir: string, args: string[]): Promise<boolean> {
  const vendored = vendoredServerEntry(dir);
  const self = process.argv[1];
  if (!vendored || (self && sameFile(vendored, self))) return false;
  const child = spawn(process.execPath, [vendored, ...args], { cwd: dir, stdio: "inherit" });
  const code = await new Promise<number>((res) => child.on("exit", (c) => res(c ?? 1)));
  if (code !== 0) process.exit(code);
  return true;
}

async function inProcess(): Promise<typeof import("../backup/run.js")> {
  try {
    return await import("../backup/run.js");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw err;
    throw new CliError("no server installed here — `yap init` first (instances vendor their own server)");
  }
}

export async function cmdBackup(dir: string, argv: string[]): Promise<void> {
  if (await delegated(dir, ["backup", ...argv])) return;
  await (await inProcess()).runBackup(dir, argv);
}

export async function cmdRestore(dir: string, argv: string[]): Promise<void> {
  if (await delegated(dir, ["restore", ...argv])) return;
  await (await inProcess()).runRestore(dir, argv);
}
