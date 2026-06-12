/**
 * backup/restore: delegate into the instance's vendored server where the
 * server deps live; fall back to in-process for repo checkouts. The
 * manager-only yap-cli package ships neither serve.js nor backup/, so both
 * paths fail there with the same guidance as serve.
 */
import { CliError } from "../instance/errors.js";
import { execInServer } from "../instance/server.js";

async function inProcess(): Promise<typeof import("../backup/run.js")> {
  try {
    return await import("../backup/run.js");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw err;
    throw new CliError("no server installed here — `yap init` first (instances vendor their own server)");
  }
}

export async function cmdBackup(dir: string, argv: string[]): Promise<void> {
  const r = await execInServer(dir, ["backup", ...argv]);
  if (r.status === "ran") {
    if (r.code !== 0) process.exit(r.code);
    return;
  }
  await (await inProcess()).runBackup(dir, argv);
}

export async function cmdRestore(dir: string, argv: string[]): Promise<void> {
  const r = await execInServer(dir, ["restore", ...argv]);
  if (r.status === "ran") {
    if (r.code !== 0) process.exit(r.code);
    return;
  }
  await (await inProcess()).runRestore(dir, argv);
}
