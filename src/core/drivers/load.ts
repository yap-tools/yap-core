/**
 * Loading the drivers an operator installed. The instance's drivers/
 * directory is the install surface: one folder per driver, each a normal
 * package (a `package.json` plus its entry module), which is what makes
 * `npm install` into that folder, a git clone, or a hand-written file all
 * work the same way.
 *
 * Two deliberate choices:
 *
 * - `package.json` must declare `yap.driverApi`. It is the handshake that
 *   makes a contract bump visible: when DRIVER_API moves, every installed
 *   driver says out loud which contract it was written against instead of
 *   failing later, mid-run, in a way that reads as a Yap bug.
 * - Any failure fails the boot. The operator put the folder there on
 *   purpose; skipping a broken one would leave its services reporting an
 *   uninstalled driver with the real reason recorded nowhere. A missing
 *   drivers/ directory is not a failure — it is the ordinary case of an
 *   instance running only the built-ins.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { YapLogger } from "../../logger.js";
import { validateDriverDefinition } from "./registry.js";
import type { DriverRegistry } from "./registry.js";
import { DRIVER_API } from "./types.js";

/** A driver the operator installed could not be loaded. Always names the folder. */
export class DriverLoadError extends Error {
  constructor(
    message: string,
    readonly dir: string,
  ) {
    super(message);
    this.name = "DriverLoadError";
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describe(value: unknown): string {
  return value === undefined ? "nothing" : JSON.stringify(value);
}

/**
 * Registers every driver installed under `driversDir` into `registry`.
 * A missing directory is a silent no-op; anything else that goes wrong throws
 * a {@link DriverLoadError} naming the offending folder.
 */
export async function loadExternalDrivers(
  driversDir: string,
  registry: DriverRegistry,
  logger: YapLogger,
): Promise<void> {
  const root = resolve(driversDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new DriverLoadError(`cannot read the drivers directory ${root}: ${reason(err)}`, root);
  }

  // Name order, so boot output and the "installed drivers" list an operator
  // reads back are stable across machines.
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile()) continue;
    const dir = join(root, entry.name);
    const fail: (message: string) => never = (message) => {
      throw new DriverLoadError(`driver in ${dir}: ${message}`, dir);
    };

    let manifest: string;
    try {
      manifest = await readFile(join(dir, "package.json"), "utf8");
    } catch (err) {
      // No package.json — not a driver folder at all. Anything else (an
      // unreadable file, a broken symlink) is a real failure.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      fail(`its package.json could not be read: ${reason(err)}`);
    }

    let pkg: { main?: unknown; yap?: { driverApi?: unknown } };
    try {
      pkg = JSON.parse(manifest) as typeof pkg;
    } catch (err) {
      fail(`its package.json is not valid JSON: ${reason(err)}`);
    }

    const declared = pkg.yap?.driverApi;
    if (declared !== DRIVER_API) {
      fail(
        `its package.json declares yap.driverApi ${describe(declared)}; this build supports driver api ` +
          `${DRIVER_API}. Install a version of the driver written for driver api ${DRIVER_API}, or remove ` +
          `the folder.`,
      );
    }

    const main = typeof pkg.main === "string" && pkg.main.trim() !== "" ? pkg.main : "index.js";
    const entryPath = resolve(dir, main);
    let module: { default?: unknown };
    try {
      module = (await import(pathToFileURL(entryPath).href)) as { default?: unknown };
    } catch (err) {
      fail(`its entry module ${entryPath} could not be imported: ${reason(err)}`);
    }

    try {
      const def = validateDriverDefinition(module.default);
      registry.register(def);
      logger.info(`driver "${def.name}" loaded from ${dir} (${Object.keys(def.actions).length} actions)`);
    } catch (err) {
      fail(reason(err));
    }
  }
}
