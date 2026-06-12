/**
 * The packed manager-only CLI, end to end: yap-cli.tgz installs with zero
 * dependencies, the installed bin runs, refuses to serve where no server is
 * vendored, and drives a remote instance — proving the manager needs nothing
 * but Node.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { packCli } from "../../scripts/pack-cli.js";
import { apiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../..");

describe("packed CLI (yap-cli.tgz)", () => {
  let app: TestApp;
  let userKey: string;
  let work: string;
  let entry: string;

  async function yap(
    args: string[],
    cwd: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("YAP_")));
    try {
      const { stdout, stderr } = await run(process.execPath, [entry, ...args], {
        cwd,
        env: env as NodeJS.ProcessEnv,
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  beforeAll(async () => {
    await run("npm", ["run", "build", "--silent"], { cwd: ROOT });
    const tarball = packCli(ROOT);

    work = mkdtempSync(join(tmpdir(), "yap-cli-install-"));
    await run("npm", ["install", "--no-fund", "--no-audit", "--loglevel=error", tarball], { cwd: work });
    entry = join(work, "node_modules", "yap-cli", "dist", "index.js");

    app = await bootTestApp();
    const created = await apiClient(app.baseUrl, TEST_SYSADMIN_KEY).post("/v1/users", { name: "Packed" });
    expect(created.status).toBe(201);
    userKey = created.body.initialKey.key;
  }, 120_000);

  afterAll(async () => {
    await app?.stop();
    rmSync(work, { recursive: true, force: true });
    rmSync(join(ROOT, "yap-cli.tgz"), { force: true });
  });

  it("installs with zero dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(work, "node_modules", "yap-cli", "package.json"), "utf8"));
    expect(pkg.dependencies).toBeUndefined();
    // npm installed exactly the one package — no transitive tree.
    const lock = JSON.parse(readFileSync(join(work, "package-lock.json"), "utf8"));
    const installed = Object.keys(lock.packages).filter((p) => p.startsWith("node_modules/"));
    expect(installed).toEqual(["node_modules/yap-cli"]);
  });

  it("runs: version prints the package version", async () => {
    const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
    const res = await yap(["version"], work);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe(version);
  });

  it("refuses to serve where no server is vendored, with a clear error", async () => {
    const bare = join(work, "bare");
    mkdirSync(bare);
    const res = await yap(["serve"], bare);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no server installed here");
    expect(res.stderr).toContain("yap init");
  });

  it("drives a remote instance with no server dependencies installed", async () => {
    const res = await yap(["--url", app.baseUrl, "--key", userKey, "spaces", "list", "--json"], work);
    expect(res.stderr).toBe("");
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).data.length).toBeGreaterThan(0);
  });
}, 180_000);
