/**
 * The instance layer's delegation seam: execInServer's three outcomes
 * (ran / self / absent), the backup-support probe, and the cmdBackup command
 * delegating through it. Tests cross the same interface callers do — a real
 * temp instance directory whose vendored entry is a stub script that records
 * its invocation and exits with a chosen code.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cmdBackup } from "../../src/cli/backup.js";
import { execInServer, serverSupportsBackup } from "../../src/instance/server.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yap-instance-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Installs a stub vendored entry that records its argv and cwd into
 * record.json at the instance root, then exits with `code`. The stub package
 * has no "type" field, so the entry runs as CommonJS.
 */
function installStubServer(dir: string, code = 0): string {
  const distDir = join(dir, "node_modules", "yap-core", "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(dir, "node_modules", "yap-core", "package.json"), JSON.stringify({ version: "0.0.0-stub" }));
  const entry = join(distDir, "index.js");
  writeFileSync(
    entry,
    `const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
writeFileSync(join(__dirname, "..", "..", "..", "record.json"),
  JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
process.exit(${code});
`,
  );
  return entry;
}

function recorded(dir: string): { args: string[]; cwd: string } {
  return JSON.parse(readFileSync(join(dir, "record.json"), "utf8")) as { args: string[]; cwd: string };
}

describe("execInServer", () => {
  it("reports absent when no vendored server is installed", async () => {
    expect(await execInServer(tempDir(), ["serve"])).toEqual({ status: "absent" });
  });

  it("reports self when the vendored entry is this very process", async () => {
    const dir = tempDir();
    const entry = installStubServer(dir);
    const originalArgv = [...process.argv];
    process.argv[1] = entry;
    try {
      expect(await execInServer(dir, ["serve"])).toEqual({ status: "self" });
    } finally {
      process.argv = originalArgv;
    }
  });

  it("spawns the vendored entry from the instance directory and returns its exit code", async () => {
    const dir = tempDir();
    installStubServer(dir, 0);
    expect(await execInServer(dir, ["backup", "--trigger", "pre-upgrade"])).toEqual({ status: "ran", code: 0 });
    const record = recorded(dir);
    expect(record.args).toEqual(["backup", "--trigger", "pre-upgrade"]);
    // macOS tmpdir is a symlink (/var → /private/var); compare realpaths.
    expect(realpathSync(record.cwd)).toBe(realpathSync(dir));
  });

  it("hands a nonzero exit code back to the caller instead of exiting", async () => {
    const dir = tempDir();
    installStubServer(dir, 3);
    expect(await execInServer(dir, ["restore"])).toEqual({ status: "ran", code: 3 });
  });
});

describe("serverSupportsBackup", () => {
  it("is false with no server, false for a pre-backup server, true once backup/run.js ships", () => {
    const dir = tempDir();
    expect(serverSupportsBackup(dir)).toBe(false);
    const entry = installStubServer(dir);
    expect(serverSupportsBackup(dir)).toBe(false);
    mkdirSync(join(entry, "..", "backup"), { recursive: true });
    writeFileSync(join(entry, "..", "backup", "run.js"), "");
    expect(serverSupportsBackup(dir)).toBe(true);
  });
});

describe("cmdBackup delegation", () => {
  it("runs `backup` in the vendored server with the caller's arguments", async () => {
    const dir = tempDir();
    installStubServer(dir, 0);
    await cmdBackup(dir, ["--out", "snapshot.tgz"]);
    expect(recorded(dir).args).toEqual(["backup", "--out", "snapshot.tgz"]);
  });
});
