/**
 * The real implementation of `yap driver add|remove|list`: install/remove/
 * inspect service drivers under <instance>/drivers/. A driver is an npm
 * package; `add` resolves it with `npm pack` (so a registry name, a git spec,
 * a tarball URL, or a local path all work the same way), extracts it,
 * npm-installs its own runtime dependencies, and loads it once with the same
 * loader boot uses — proving it actually satisfies the driver contract —
 * before leaving it in place. Any failure after the folder lands cleans the
 * folder back up: a bad install never leaves a half-registered driver for
 * boot to trip over later.
 *
 * Lives apart from driver.ts because it needs tar-stream and core/drivers/* —
 * dependencies the full server (yap-core) ships but the manager-only CLI
 * (yap-cli) deliberately does not. driver.ts is what index.ts imports; this
 * module is reached only through execInServer's vendored-server delegation or
 * an in-process import that has those dependencies available.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract as tarExtract } from "tar-stream";

import { DriverLoadError, loadDriverFolder } from "../core/drivers/load.js";
import { DRIVER_NAME } from "../core/drivers/registry.js";
import { CliError } from "../instance/errors.js";
import { driversDir } from "../instance/layout.js";
import { table } from "./table.js";

const DRIVER_NAME_PREFIX = "yap-driver-";

function npmBin(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Last few lines of a (possibly long) npm stderr, for a readable CliError. */
function tail(text: string, n = 20): string {
  const lines = text.trim().split("\n");
  return lines.slice(-n).join("\n");
}

/**
 * The driver name for a packed package: an explicit `yap.name` override, else
 * the unscoped package name with a leading `yap-driver-` prefix stripped.
 */
export function deriveDriverName(pkg: { name?: unknown; yap?: { name?: unknown } }): string {
  const override = pkg.yap?.name;
  if (typeof override === "string" && override.trim() !== "") return override;
  const raw = typeof pkg.name === "string" ? pkg.name : "";
  const slash = raw.indexOf("/");
  const unscoped = slash >= 0 ? raw.slice(slash + 1) : raw;
  return unscoped.startsWith(DRIVER_NAME_PREFIX) ? unscoped.slice(DRIVER_NAME_PREFIX.length) : unscoped;
}

/** Refuses to overwrite an already-installed driver. */
export function assertDriverAvailable(target: string, name: string): void {
  if (existsSync(target)) {
    throw new CliError(
      `a driver named "${name}" is already installed at ${target} — run \`yap driver remove ${name}\` first`,
    );
  }
}

function runNpmPack(spec: string, destDir: string): string {
  const res = spawnSync(npmBin(), ["pack", spec, "--pack-destination", destDir, "--json"], { encoding: "utf8" });
  if (res.error) throw new CliError(`could not run npm: ${res.error.message}`);
  if (res.status !== 0) {
    throw new CliError(`npm pack ${spec} failed:\n${tail(res.stderr ?? "")}`);
  }
  let parsed: Array<{ filename?: unknown }>;
  try {
    parsed = JSON.parse(res.stdout) as Array<{ filename?: unknown }>;
  } catch (err) {
    throw new CliError(`npm pack ${spec} produced unparseable output: ${reason(err)}`);
  }
  const filename = parsed[0]?.filename;
  if (typeof filename !== "string" || filename.trim() === "") {
    throw new CliError(`npm pack ${spec} produced no tarball`);
  }
  return join(destDir, filename);
}

function runNpmInstall(cwd: string): void {
  const res = spawnSync(npmBin(), ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd, encoding: "utf8" });
  if (res.error) throw new CliError(`could not run npm install: ${res.error.message}`);
  if (res.status !== 0) {
    throw new CliError(`npm install failed for the driver package:\n${tail(res.stderr ?? "")}`);
  }
}

/**
 * Extracts a `npm pack` tarball (root entry `package/`) into `destDir`.
 *
 * `tar-stream` passes `header.name` (and, for link entries, `header.linkname`)
 * through verbatim — a crafted entry such as `package/../../../etc/x` would
 * otherwise resolve outside `destDir` (a "tar-slip" arbitrary-file-write).
 * Every entry's resolved path is therefore checked to stay within `destDir`
 * before anything is written, and link/symlink entries — which a driver
 * package has no legitimate reason to contain — are rejected outright.
 */
export async function extractTarball(tarballPath: string, destDir: string): Promise<void> {
  const realDestDir = resolve(destDir);
  const extract = tarExtract();
  extract.on("entry", (header, stream, next) => {
    // Rejecting an entry destroys the underlying extract stream, which in
    // turn destroys this entry's own per-entry stream — re-emitting the same
    // error on it. Nothing else listens for that (tar-stream's own iterator
    // has the identical workaround), so without this it surfaces as an
    // unhandled 'error' event instead of the pipeline rejection callers await.
    stream.on("error", () => {});
    if (header.type === "symlink" || header.type === "link") {
      stream.resume();
      next(new CliError(`refusing to extract ${JSON.stringify(header.name)}: ${header.type} entries are not allowed in a driver package`));
      return;
    }
    const relPath = header.name.replace(/^package\//, "").replace(/^\/+/, "");
    if (relPath === "") {
      stream.resume();
      next();
      return;
    }
    const target = resolve(realDestDir, relPath);
    if (target !== realDestDir && !target.startsWith(realDestDir + sep)) {
      stream.resume();
      next(new CliError(`refusing to extract ${JSON.stringify(header.name)}: it resolves outside the extraction directory`));
      return;
    }
    if (header.type === "directory") {
      mkdirSync(target, { recursive: true });
      stream.resume();
      next();
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    const out = createWriteStream(target);
    out.on("close", next);
    out.on("error", (err) => extract.destroy(err));
    stream.pipe(out);
  });
  await pipeline(createReadStream(tarballPath), createGunzip(), extract);
}

/** Installed driver folder names (not validated — just what's on disk), name-sorted. */
function installedFolders(dir: string): string[] {
  try {
    return readdirSync(driversDir(dir), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function cmdDriverAdd(dir: string, spec: string): Promise<void> {
  const packTmp = mkdtempSync(join(tmpdir(), "yap-driver-pack-"));
  let extractTmp: string | undefined;
  try {
    const tarballPath = runNpmPack(spec, packTmp);
    extractTmp = mkdtempSync(join(tmpdir(), "yap-driver-extract-"));
    await extractTarball(tarballPath, extractTmp);

    let pkg: { name?: unknown; yap?: { name?: unknown } };
    try {
      pkg = JSON.parse(readFileSync(join(extractTmp, "package.json"), "utf8")) as typeof pkg;
    } catch (err) {
      throw new CliError(`${spec}: package.json could not be read: ${reason(err)}`);
    }

    const name = deriveDriverName(pkg);
    if (!DRIVER_NAME.test(name)) {
      throw new CliError(
        `derived driver name ${JSON.stringify(name)} does not match ${DRIVER_NAME.source} — ` +
          `set "yap": { "name": "..." } in the package's package.json to override it`,
      );
    }

    const target = join(driversDir(dir), name);
    assertDriverAvailable(target, name);

    mkdirSync(driversDir(dir), { recursive: true });
    try {
      cpSync(extractTmp, target, { recursive: true });
    } catch (err) {
      rmSync(target, { recursive: true, force: true });
      throw err;
    }
    rmSync(extractTmp, { recursive: true, force: true });
    extractTmp = undefined;

    try {
      runNpmInstall(target);
      const def = await loadDriverFolder(target);
      console.log(`Installed driver "${def.name}" (driver api ${def.api}) at ${target}`);
      const actions = Object.keys(def.actions);
      console.log(`Actions: ${actions.length > 0 ? actions.join(", ") : "(none)"}`);
    } catch (err) {
      rmSync(target, { recursive: true, force: true });
      throw err instanceof DriverLoadError ? new CliError(err.message) : err;
    }
  } finally {
    rmSync(packTmp, { recursive: true, force: true });
    if (extractTmp) rmSync(extractTmp, { recursive: true, force: true });
  }
}

export function cmdDriverRemove(dir: string, name: string): void {
  const target = join(driversDir(dir), name);
  if (!existsSync(target)) {
    const installed = installedFolders(dir);
    throw new CliError(
      `no driver named "${name}" installed` +
        (installed.length > 0 ? ` — installed: ${installed.join(", ")}` : " — none are installed"),
    );
  }
  rmSync(target, { recursive: true, force: true });
  console.log(`Removed driver "${name}" (${target}).`);
}

export async function cmdDriverList(dir: string): Promise<void> {
  const folders = installedFolders(dir);
  const rows: Array<Record<string, unknown>> = [];
  for (const folder of folders) {
    const folderPath = join(driversDir(dir), folder);
    try {
      const def = await loadDriverFolder(folderPath);
      rows.push({ name: def.name, api: def.api, actions: Object.keys(def.actions).join(", "), folder: folderPath });
    } catch (err) {
      rows.push({ name: folder, api: "-", actions: `ERROR: ${reason(err)}`, folder: folderPath });
    }
  }
  console.log(table(rows, ["name", "api", "actions", "folder"]));
}

export async function cmdDriver(dir: string, argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "add": {
      const spec = rest[0];
      if (!spec) throw new CliError("usage: yap driver add <spec>");
      await cmdDriverAdd(dir, spec);
      return;
    }
    case "remove": {
      const name = rest[0];
      if (!name) throw new CliError("usage: yap driver remove <name>");
      cmdDriverRemove(dir, name);
      return;
    }
    case "list":
      await cmdDriverList(dir);
      return;
    default:
      throw new CliError("usage: yap driver add <spec> | yap driver remove <name> | yap driver list");
  }
}
