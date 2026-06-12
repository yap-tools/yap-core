/**
 * The CLI against a remote instance: `yap --url <u> --key <k> …` (or
 * YAP_URL/YAP_KEY) drives the manage commands from a directory that is not
 * the instance directory — and local state in the cwd never leaks into the
 * request. Spawns the real CLI entry point.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeCredentials } from "../../src/cli/credentials.js";
import { apiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../..");
const TSX = join(ROOT, "node_modules/.bin/tsx");
const ENTRY = join(ROOT, "src/index.ts");

/** Spawn the real CLI; returns stdout/stderr and never throws on exit 1. */
async function yap(
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  // Strip YAP_* from the inherited env so only the test's own values apply.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("YAP_")));
  try {
    const { stdout, stderr } = await run(TSX, [ENTRY, ...args], {
      cwd: opts.cwd,
      env: { ...base, ...opts.env } as NodeJS.ProcessEnv,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("CLI remote targeting", () => {
  let app: TestApp;
  let userKey: string;
  let cwd: string;

  beforeAll(async () => {
    app = await bootTestApp();
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const created = await sysadmin.post("/v1/users", { name: "Remote" });
    expect(created.status).toBe(201);
    userKey = created.body.initialKey.key;

    // A decoy instance directory: if the CLI read local state, requests would
    // go to a dead port or carry a bogus key — either way the test fails.
    cwd = mkdtempSync(join(tmpdir(), "yap-remote-cwd-"));
    writeFileSync(join(cwd, ".env"), "YAP_PORT=1\nYAP_SYSADMIN_KEY=yap_sys_decoy\n");
    writeCredentials(cwd, { accessKey: "yk_decoy" });
  }, 30_000);

  afterAll(async () => {
    await app.stop();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("drives manage commands via --url/--key, ignoring local state", async () => {
    const res = await yap(["--url", app.baseUrl, "--key", userKey, "spaces", "list", "--json"], { cwd });
    expect(res.stderr).toBe("");
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout);
    expect(body.data.some((s: { personal: boolean }) => s.personal)).toBe(true);
  });

  it("drives manage commands via YAP_URL/YAP_KEY env", async () => {
    const res = await yap(["api", "GET", "/v1/spaces"], {
      cwd,
      env: { YAP_URL: app.baseUrl, YAP_KEY: userKey },
    });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).data).toBeInstanceOf(Array);
  });

  it("refuses the sysadmin lane against a remote", async () => {
    const res = await yap(["--url", app.baseUrl, "--key", userKey, "users", "list"], { cwd });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("sysadmin commands are local-only");
  });

  it("refuses lifecycle commands against a remote", async () => {
    const res = await yap(["--url", app.baseUrl, "start"], { cwd });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("can't target a remote");
  });
}, 60_000);
