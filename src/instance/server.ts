/**
 * The vendored server: each instance carries its own copy of yap-core at its
 * own version (installed from GitHub at init, changed only by `yap upgrade`),
 * so instances on one machine are fully isolated from each other and from the
 * global CLI's version. This module owns locating it, installing it, and
 * delegation — running a server-side command by spawning the vendored entry.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { CliError } from "./errors.js";

export const SERVER_PACKAGE = "yap-core";
const RELEASES = "https://github.com/yap-tools/yap-core/releases";

/**
 * Prebuilt release tarball, latest by default. Releases ship the packed
 * package under the constant asset name yap-core.tgz, so no GitHub API call
 * (or TypeScript toolchain on the operator's machine) is ever needed.
 */
export function installSpec(version?: string): string {
  return version ? `${RELEASES}/download/${version}/yap-core.tgz` : `${RELEASES}/latest/download/yap-core.tgz`;
}

export async function installServer(dir: string, version?: string): Promise<void> {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "--no-fund", "--no-audit", "--loglevel=error", installSpec(version)];
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(npm, args, { cwd: dir, stdio: "inherit" });
    child.on("error", (err) => reject(new CliError(`could not run npm: ${err.message}`)));
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new CliError(`npm install failed (exit ${code}) — rerun \`yap init\` to retry the server install`));
    });
  });
}

/** The vendored server's entry point, when one is installed. */
export function vendoredServerEntry(dir: string): string | undefined {
  const entry = join(dir, "node_modules", SERVER_PACKAGE, "dist", "index.js");
  return existsSync(entry) ? entry : undefined;
}

export function vendoredServerVersion(dir: string): string | undefined {
  const pkgPath = join(dir, "node_modules", SERVER_PACKAGE, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version;
}

/** The server entry `start`/`serve` should execute for this instance. */
export function serverEntry(dir: string): string {
  const vendored = vendoredServerEntry(dir);
  if (vendored) return vendored;
  throw new CliError(
    "no server installed in this directory — run `yap init` (or `yap init --no-install` plus a manual install) first",
  );
}

/** Whether the installed server ships backup/restore (added in 0.5.0). */
export function serverSupportsBackup(dir: string): boolean {
  const vendored = vendoredServerEntry(dir);
  return vendored !== undefined && existsSync(join(dirname(vendored), "backup", "run.js"));
}

export type DelegateResult =
  | { status: "ran"; code: number }
  | { status: "self" }
  | { status: "absent" };

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Delegation, written once: run a command in the instance's vendored server,
 * stdio inherited. Never exits and never throws on the expected outcomes —
 * `ran` carries the child's exit code, `self` means the vendored entry is
 * this very process (a repo checkout or the vendored copy itself; run
 * in-process instead), `absent` means no server is installed here. What to do
 * about `self` and `absent` is the caller's policy.
 */
export async function execInServer(dir: string, args: string[]): Promise<DelegateResult> {
  const vendored = vendoredServerEntry(dir);
  if (!vendored) return { status: "absent" };
  const self = process.argv[1];
  if (self && sameFile(vendored, self)) return { status: "self" };
  const child = spawn(process.execPath, [vendored, ...args], { cwd: dir, stdio: "inherit" });
  const code = await new Promise<number>((res) => child.on("exit", (c) => res(c ?? 1)));
  return { status: "ran", code };
}
