/**
 * `yap driver add|remove|list`: delegates into the instance's vendored
 * server, exactly like backup/restore. Installing or listing a driver needs
 * tar-stream and the core/drivers/* loader — dependencies the manager-only
 * CLI (yap-cli) does not ship, but the vendored server (yap-core) always
 * does. Falls back to running in-process for a repo checkout, or when this
 * process already is the vendored server (execInServer's "self" case).
 */
import { CliError } from "../instance/errors.js";
import { execInServer } from "../instance/server.js";

async function inProcess(): Promise<typeof import("./driver-impl.js")> {
  try {
    return await import("./driver-impl.js");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw err;
    throw new CliError("no server installed here — `yap init` first (instances vendor their own server)");
  }
}

export async function cmdDriver(dir: string, argv: string[]): Promise<void> {
  const r = await execInServer(dir, ["driver", ...argv]);
  if (r.status === "ran") {
    if (r.code !== 0) process.exit(r.code);
    return;
  }
  await (await inProcess()).cmdDriver(dir, argv);
}
