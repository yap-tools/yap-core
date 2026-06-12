/**
 * Packs the manager-only CLI as yap-cli.tgz: the `yap` bin with zero runtime
 * dependencies. The CLI tree imports nothing outside dist/cli and
 * dist/instance (the instance layer both packages share) except crypto.js
 * (pure node:crypto) and — lazily, for the repo-checkout fallbacks — serve.js
 * and backup/run.js, which are deliberately absent here. The full server
 * keeps shipping as yap-core.tgz via plain `npm pack`.
 *
 * Usage: npm run pack:cli  (expects dist/ to be built)
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CLI_PACKAGE = "yap-cli";

/** What the CLI package ships from dist/ — the entry, the cli and instance trees, crypto. */
export const CLI_DIST_FILES = ["index.js", "cli", "instance", "crypto.js"];

type PackageJson = Record<string, unknown>;

/** The yap-cli variant of package.json: same identity, no dependencies. */
export function cliPackageJson(base: PackageJson): PackageJson {
  const carried = [
    "version",
    "type",
    "license",
    "author",
    "repository",
    "homepage",
    "bugs",
    "keywords",
    "engines",
    "bin",
  ] as const;
  const pkg: PackageJson = {
    name: CLI_PACKAGE,
    description: "The yap command: creates, runs, and manages Yap instances. Manager only — instances vendor their own server (yap-core).",
  };
  for (const field of carried) {
    if (base[field] !== undefined) pkg[field] = base[field];
  }
  pkg.files = ["dist"];
  return pkg;
}

export function packCli(root: string): string {
  const base = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
  const staging = mkdtempSync(join(tmpdir(), "yap-cli-pack-"));
  try {
    for (const file of CLI_DIST_FILES) {
      cpSync(join(root, "dist", file), join(staging, "dist", file), { recursive: true });
    }
    cpSync(join(root, "LICENSE"), join(staging, "LICENSE"));
    writeFileSync(join(staging, "package.json"), JSON.stringify(cliPackageJson(base), null, 2) + "\n");

    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const artifact = execFileSync(npm, ["pack", "--loglevel=error"], { cwd: staging, encoding: "utf8" })
      .trim()
      .split("\n")
      .pop()!;
    const target = join(root, "yap-cli.tgz");
    renameSync(join(staging, artifact), target);
    return target;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(packCli(resolve(import.meta.dirname, "..")));
}
