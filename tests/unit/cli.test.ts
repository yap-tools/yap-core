/**
 * CLI plumbing for installed (non-checkout) use: yap-home resolution, the
 * env-file search order, and the `yap init` scaffold.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveEnvFile, yapHome } from "../../src/cli/home.js";
import { initYapHome } from "../../src/cli/init.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yap-cli-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("yapHome", () => {
  it("uses YAP_HOME when set, resolved to an absolute path", () => {
    expect(yapHome({ YAP_HOME: "/tmp/custom-yap" })).toBe("/tmp/custom-yap");
    expect(isAbsolute(yapHome({ YAP_HOME: "relative/yap" }))).toBe(true);
  });

  it("defaults to ~/.yap", () => {
    expect(yapHome({})).toMatch(/[/\\]\.yap$/);
  });
});

describe("resolveEnvFile", () => {
  it("prefers an existing YAP_ENV_FILE over everything", () => {
    const dir = tempDir();
    const explicit = join(dir, "explicit.env");
    writeFileSync(explicit, "");
    writeFileSync(join(dir, ".env"), "");
    expect(resolveEnvFile({ YAP_ENV_FILE: explicit, YAP_HOME: dir }, dir)).toBe(explicit);
  });

  it("falls back to ./.env, then $YAP_HOME/.env, then undefined", () => {
    const cwd = tempDir();
    const home = tempDir();
    expect(resolveEnvFile({ YAP_HOME: home }, cwd)).toBeUndefined();

    writeFileSync(join(home, ".env"), "");
    expect(resolveEnvFile({ YAP_HOME: home }, cwd)).toBe(join(home, ".env"));

    writeFileSync(join(cwd, ".env"), "");
    expect(resolveEnvFile({ YAP_HOME: home }, cwd)).toBe(join(cwd, ".env"));
  });

  it("skips a YAP_ENV_FILE that does not exist instead of crashing", () => {
    const home = tempDir();
    writeFileSync(join(home, ".env"), "");
    const env = { YAP_ENV_FILE: join(home, "missing.env"), YAP_HOME: home };
    expect(resolveEnvFile(env, tempDir())).toBe(join(home, ".env"));
  });
});

describe("initYapHome", () => {
  it("scaffolds a private .env with generated keys and absolute data paths", () => {
    const home = join(tempDir(), "nested", ".yap"); // parent dirs created too
    const result = initYapHome(home);

    expect(result.created).toBe(true);
    expect(result.envPath).toBe(join(home, ".env"));
    expect(result.sysadminKey.startsWith("yap_sys_")).toBe(true);
    expect(result.sysadminKey.length).toBeGreaterThanOrEqual(16);

    const mode = statSync(result.envPath).mode & 0o777;
    expect(mode).toBe(0o600);

    const content = readFileSync(result.envPath, "utf8");
    expect(content).toContain(`YAP_SYSADMIN_KEY=${result.sysadminKey}`);
    const masterKey = content.match(/^YAP_MASTER_KEY=(.+)$/m)?.[1];
    expect(Buffer.from(masterKey!, "base64")).toHaveLength(32);
    expect(content).toContain(`YAP_SQLITE_PATH=${join(home, "data", "yap.db")}`);
    expect(content).toContain(`YAP_BLOB_FS_ROOT=${join(home, "data", "blobs")}`);
  });

  it("refuses to overwrite an existing .env", () => {
    const home = tempDir();
    const first = initYapHome(home);
    const before = readFileSync(first.envPath, "utf8");

    const second = initYapHome(home);
    expect(second.created).toBe(false);
    expect(second.envPath).toBe(first.envPath);
    expect(readFileSync(first.envPath, "utf8")).toBe(before);
  });
});
