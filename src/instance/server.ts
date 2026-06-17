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

/**
 * Best-effort, cosmetic: the commit a git-sourced server was built from, short
 * form, read from the lockfile npm writes. Undefined when unknown — never gate
 * behavior on it.
 */
export function installedGitCommit(dir: string): string | undefined {
  try {
    const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as {
      packages?: Record<string, { resolved?: string }>;
    };
    const resolved = lock.packages?.[`node_modules/${SERVER_PACKAGE}`]?.resolved;
    const sha = resolved?.match(/#([0-9a-f]{40})$/)?.[1];
    return sha?.slice(0, 7);
  } catch {
    return undefined;
  }
}

export async function installServer(dir: string, source: Source): Promise<void> {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "--no-fund", "--no-audit", "--loglevel=error"];
  // A git ref is a moving target; bypass npm's cached branch resolution so an
  // upgrade always builds the current tip rather than a stale clone.
  if (source.kind === "git") args.push("--prefer-online");
  args.push(installSpec(source));
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(npm, args, { cwd: dir, stdio: "inherit" });
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
  writeSource(dir, source);
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
