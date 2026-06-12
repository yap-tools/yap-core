/**
 * CLI plumbing for installed use: the env-file search order and the
 * `yap init` instance scaffold (an instance is a directory).
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveEnvFile } from "../../src/cli/env.js";
import { initInstance } from "../../src/cli/init.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yap-cli-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveEnvFile", () => {
  it("prefers an existing YAP_ENV_FILE over the cwd .env", () => {
    const dir = tempDir();
    const explicit = join(dir, "explicit.env");
    writeFileSync(explicit, "");
    writeFileSync(join(dir, ".env"), "");
    expect(resolveEnvFile({ YAP_ENV_FILE: explicit }, dir)).toBe(explicit);
  });

  it("falls back to ./.env, then undefined", () => {
    const cwd = tempDir();
    expect(resolveEnvFile({}, cwd)).toBeUndefined();
    writeFileSync(join(cwd, ".env"), "");
    expect(resolveEnvFile({}, cwd)).toBe(join(cwd, ".env"));
  });

  it("skips a YAP_ENV_FILE that does not exist instead of crashing", () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, ".env"), "");
    expect(resolveEnvFile({ YAP_ENV_FILE: join(cwd, "missing.env") }, cwd)).toBe(join(cwd, ".env"));
  });
});

describe("initInstance", () => {
  it("scaffolds a private .env with generated keys and instance-relative data paths", () => {
    const dir = tempDir();
    const result = initInstance(dir);

    expect(result.created).toBe(true);
    expect(result.envPath).toBe(join(dir, ".env"));
    expect(result.sysadminKey.startsWith("yap_sys_")).toBe(true);
    expect(result.sysadminKey.length).toBeGreaterThanOrEqual(16);

    const mode = statSync(result.envPath).mode & 0o777;
    expect(mode).toBe(0o600);

    const content = readFileSync(result.envPath, "utf8");
    expect(content).toContain(`YAP_SYSADMIN_KEY=${result.sysadminKey}`);
    const masterKey = content.match(/^YAP_MASTER_KEY=(.+)$/m)?.[1];
    expect(Buffer.from(masterKey!, "base64")).toHaveLength(32);
    // Relative to the instance directory, so the directory stays relocatable.
    expect(content).toContain("YAP_SQLITE_PATH=./data/yap.db");
    expect(content).toContain("YAP_BLOB_FS_ROOT=./data/blobs");

    expect(statSync(join(dir, "data")).isDirectory()).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".env");
  });

  it("refuses to overwrite an existing .env", () => {
    const dir = tempDir();
    const first = initInstance(dir);
    const before = readFileSync(first.envPath, "utf8");

    const second = initInstance(dir);
    expect(second.created).toBe(false);
    expect(second.envPath).toBe(first.envPath);
    expect(readFileSync(first.envPath, "utf8")).toBe(before);
  });

  it("leaves an existing .gitignore alone", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".gitignore"), "custom\n");
    initInstance(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("custom\n");
  });
});
