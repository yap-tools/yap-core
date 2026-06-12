/**
 * Vendoring the server into an instance directory. Each instance carries its
 * own copy of yap-core at its own version (installed from GitHub at init,
 * changed only by `yap upgrade`), so instances on one machine are fully
 * isolated from each other and from the global CLI's version.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CliError } from "./util.js";

export const SERVER_PACKAGE = "yap-core";
const SERVER_REPO = "github:yap-tools/yap-core";

/** Latest release tag by default (npm resolves semver ranges against git tags). */
export function installSpec(version?: string): string {
  return `${SERVER_PACKAGE}@${SERVER_REPO}#${version ?? "semver:*"}`;
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
