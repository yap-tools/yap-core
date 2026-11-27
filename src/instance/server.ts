/**
 * The vendored server: each instance carries its own copy of yap-core at its
 * own version (installed from GitHub at init, changed only by `yap upgrade`),
 * so instances on one machine are fully isolated from each other and from the
 * global CLI's version. This module owns locating it, installing it, and
 * delegation — running a server-side command by spawning the vendored entry.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CliError } from "./errors.js";
import { sourcePath, stateDir } from "./layout.js";

export const SERVER_PACKAGE = "yap-core";
const RELEASES = "https://github.com/yap-tools/yap-core/releases";
const REPO_GIT = "git+https://github.com/yap-tools/yap-core.git";

/**
 * Where an instance's server comes from: a prebuilt GitHub release (the
 * default — `latest` when version is undefined, else a pinned tag), or a git
 * ref (a branch like `main`, or a commit) built from source. The git path
 * works because yap-core declares `prepare: npm run build`, so `npm install`
 * of the git URL clones the ref, builds dist/, and vendors it in the same
 * node_modules/yap-core layout a release produces.
 */
export type Source = { kind: "release"; version?: string } | { kind: "git"; ref: string };

/**
 * Classify a CLI version argument. The project tags releases `vMAJOR.MINOR.PATCH`
 * (see RELEASING.md), so `latest` and any `v`-prefixed value name a release;
 * anything else (a branch, a commit) is a git ref built from source.
 */
export function classifyVersion(value?: string): Source {
  if (!value || value === "latest") return { kind: "release" };
  if (/^v\d/.test(value)) return { kind: "release", version: value };
  return { kind: "git", ref: value };
}

/**
 * The npm install argument for a source. Releases ship the packed package
 * under the constant asset name yap-core.tgz, so no GitHub API call (or
 * TypeScript toolchain) is needed; a git ref installs the repo at that ref.
 */
export function installSpec(source: Source): string {
  if (source.kind === "git") return `${REPO_GIT}#${source.ref}`;
  return source.version
    ? `${RELEASES}/download/${source.version}/yap-core.tgz`
    : `${RELEASES}/latest/download/yap-core.tgz`;
}

/** A short human label for a source, for install/upgrade output. */
export function sourceLabel(source: Source): string {
  if (source.kind === "git") return `from ${source.ref}`;
  return source.version ?? "latest release";
}

/**
 * The instance's saved server source. Written only when it tracks a git ref;
 * a release install removes the file, so its absence means the release channel
 * — which keeps every existing instance behaving exactly as before.
 */
export function readSource(dir: string): Source {
  const path = sourcePath(dir);
  if (!existsSync(path)) return { kind: "release" };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { ref?: string };
  return parsed.ref ? { kind: "git", ref: parsed.ref } : { kind: "release" };
}

export function writeSource(dir: string, source: Source): void {
  const path = sourcePath(dir);
  if (source.kind === "git") {
    mkdirSync(stateDir(dir), { recursive: true });
    writeFileSync(path, JSON.stringify({ ref: source.ref }, null, 2) + "\n");
  } else {
    rmSync(path, { force: true });
  }
}

/** The full commit a git-sourced yap-core under `prefix` was built from, per npm's lockfile. */
function lockedGitCommit(prefix: string): string | undefined {
  try {
    const lock = JSON.parse(readFileSync(join(prefix, "package-lock.json"), "utf8")) as {
      packages?: Record<string, { resolved?: string }>;
    };
    const resolved = lock.packages?.[`node_modules/${SERVER_PACKAGE}`]?.resolved;
    return resolved?.match(/#([0-9a-f]{40})$/)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Best-effort, cosmetic: the commit a git-sourced server was built from, short
 * form, read from the lockfile npm writes. Undefined when unknown — never gate
 * behavior on it.
 */
export function installedGitCommit(dir: string): string | undefined {
  return lockedGitCommit(dir)?.slice(0, 7);
}

/**
 * The install spec that reproduces what was installed under `prefix`: the
 * commit a git ref resolved to, or the release tag of the version it
 * downloaded (tags equal package versions, see RELEASING.md). `yap upgrade`
 * installs this after checking the staged copy, so a branch that moved or a
 * release published in between cannot slip in unchecked. Undefined when it
 * cannot tell; the caller then falls back to the source's own spec.
 */
export function pinnedSpec(prefix: string, source: Source): string | undefined {
  if (source.kind === "git") {
    const sha = lockedGitCommit(prefix);
    return sha ? installSpec({ kind: "git", ref: sha }) : undefined;
  }
  const version = serverVersionIn(prefix);
  return version ? installSpec({ kind: "release", version: `v${version}` }) : undefined;
}

export interface InstallOptions {
  /**
   * Install into this directory instead of the instance: a staging copy for
   * `yap upgrade` to check before it touches the instance's own server. The
   * instance's node_modules and saved source are left alone.
   */
  prefix?: string;
  /** npm spec to install instead of the source's own (see pinnedSpec); the source is still what gets saved. */
  spec?: string;
}

export async function installServer(dir: string, source: Source, opts: InstallOptions = {}): Promise<void> {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "--no-fund", "--no-audit", "--loglevel=error"];
  // A git ref is a moving target; bypass npm's cached branch resolution so an
  // upgrade always builds the current tip rather than a stale clone.
  // A pinned spec (an exact commit) cannot move, so it may come from the cache.
  if (source.kind === "git" && !opts.spec) args.push("--prefer-online");
  if (opts.prefix) {
    mkdirSync(opts.prefix, { recursive: true });
    // The lockfile is what pinnedSpec reads the resolved commit from.
    args.push("--prefix", opts.prefix, "--package-lock=true");
  }
  args.push(opts.spec ?? installSpec(source));
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(npm, args, { cwd: opts.prefix ?? dir, stdio: "inherit" });
    child.on("error", (err) => reject(new CliError(`could not run npm: ${err.message}`)));
    child.on("exit", (code) => {
      if (code === 0) return resolvePromise();
      reject(
        new CliError(
          source.kind === "git"
            ? `could not build yap-core from ${source.ref} (npm exit ${code}) — is git installed and does the ref exist?`
            : `npm install failed (exit ${code}) — rerun \`yap init\` to retry the server install`,
        ),
      );
    });
  });
  // Persist the source only after a successful install: a git ref so a bare
  // `yap upgrade` re-pulls it, or clear it to return to the release channel.
  if (!opts.prefix) writeSource(dir, source);
}

/** The server entry inside a directory npm installed yap-core into. */
export function serverEntryIn(prefix: string): string {
  return join(prefix, "node_modules", SERVER_PACKAGE, "dist", "index.js");
}

/** The version of the yap-core package installed under a directory, if any. */
export function serverVersionIn(prefix: string): string | undefined {
  const pkgPath = join(prefix, "node_modules", SERVER_PACKAGE, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version;
}

/** Whether the build behind a server entry ships a module (a path under its dist/). */
function entryShips(entry: string, module: string): boolean {
  return existsSync(join(dirname(entry), module));
}

/** Whether a server entry ships `yap preflight`; builds from before it do not. */
export function entrySupportsPreflight(entry: string): boolean {
  return entryShips(entry, "db/preflight.js");
}

/** The vendored server's entry point, when one is installed. */
export function vendoredServerEntry(dir: string): string | undefined {
  const entry = serverEntryIn(dir);
  return existsSync(entry) ? entry : undefined;
}

export const vendoredServerVersion = serverVersionIn;

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
  return vendored !== undefined && entryShips(vendored, "backup/run.js");
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
  return { status: "ran", code: await execEntry(vendored, dir, args) };
}

/**
 * Runs a server entry (any installed yap-core's dist/index.js) as a child
 * process from the instance directory, stdio inherited, and returns its exit
 * code. `env` is added to this process's environment.
 */
export async function execEntry(
  entry: string,
  dir: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<number> {
  const child = spawn(process.execPath, [entry, ...args], { cwd: dir, stdio: "inherit", env: { ...process.env, ...env } });
  return new Promise<number>((res, rej) => {
    child.on("error", rej);
    child.on("exit", (c) => res(c ?? 1));
  });
}
