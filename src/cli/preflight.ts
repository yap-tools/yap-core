/**
 * `yap preflight`: checks whether a build's pending migrations can go ahead
 * on this instance's data, without changing anything (see db/preflight.ts).
 *
 * It checks the build that runs it, since the pending migrations are that
 * build's. A full server package (the instance's vendored server, a staged
 * upgrade, a repo checkout) runs the check in-process; the manager-only
 * yap-cli package ships no server, so it delegates to the instance's
 * installed server, which is the build the next start will run.
 */
import { existsSync } from "node:fs";

import { CliError } from "../instance/errors.js";
import { execInServer } from "../instance/server.js";

export async function cmdPreflight(dir: string, argv: string[]): Promise<void> {
  // Decide by whether the module is there, not by catching a failed import:
  // a server package whose preflight cannot load (a dependency missing) must
  // fail here, not quietly hand the check to a different build.
  // (.ts when run from source with tsx.)
  const shipsPreflight = ["../db/preflight.js", "../db/preflight.ts"].some((m) => existsSync(new URL(m, import.meta.url)));
  const local = shipsPreflight ? await import("../db/preflight.js") : undefined;
  if (local) {
    const code = await local.runPreflightCommand(argv);
    if (code !== 0) process.exit(code);
    return;
  }
  const r = await execInServer(dir, ["preflight", ...argv]);
  if (r.status === "absent") throw new CliError("no server installed here — `yap init` first");
  if (r.status === "self") throw new CliError("this server package is incomplete (db/preflight.js is missing)");
  if (r.code !== 0) process.exit(r.code);
}
