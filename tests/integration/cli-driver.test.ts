/**
 * `yap driver add|remove|list` end to end: real `npm pack` of a local-path
 * spec (the echo fixture), real extraction, real `npm install`, and a real
 * dynamic import + validation before the CLI calls it installed. Local-path
 * packing needs no network, but still shells out to npm twice, so this suite
 * gets a generous timeout.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../..");
const TSX = join(ROOT, "node_modules/.bin/tsx");
const ENTRY = join(ROOT, "src/index.ts");
const FIXTURE = fileURLToPath(new URL("../fixtures/driver-echo", import.meta.url));

/** Spawn the real CLI; returns stdout/stderr and never throws on exit 1. */
async function yap(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(TSX, [ENTRY, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yap-driver-cli-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("yap driver", () => {
  it("mentions driver add/remove/list in help", async () => {
    const res = await yap(["help"], tempDir());
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("driver add <spec>");
    expect(res.stdout).toContain("driver remove <name>");
    expect(res.stdout).toContain("driver list");
  });

  it(
    "installs the echo fixture by local path, lists it, and removes it",
    async () => {
      const dir = tempDir();

      const add = await yap(["driver", "add", FIXTURE], dir);
      expect(add.stderr).toBe("");
      expect(add.code).toBe(0);
      expect(add.stdout).toContain('Installed driver "echo"');
      expect(add.stdout).toContain("echo");

      const target = join(dir, "drivers", "echo");
      expect(existsSync(join(target, "package.json"))).toBe(true);
      const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
      expect(pkg.name).toBe("yap-driver-echo");
      expect(pkg.yap.driverApi).toBe(1);

      // The installed driver is importable and satisfies the contract.
      const mod = (await import(pathToFileURL(join(target, "index.js")).href)) as { default: { name: string } };
      expect(mod.default.name).toBe("echo");

      const list = await yap(["driver", "list"], dir);
      expect(list.code).toBe(0);
      expect(list.stdout).toContain("echo");
      expect(list.stdout).toMatch(/echo\s+1\s+echo, shout\s+/);

      const remove = await yap(["driver", "remove", "echo"], dir);
      expect(remove.code).toBe(0);
      expect(remove.stdout).toContain('Removed driver "echo"');
      expect(existsSync(target)).toBe(false);

      const listAfter = await yap(["driver", "list"], dir);
      expect(listAfter.stdout.trim()).not.toContain("echo");
    },
    120_000,
  );

  it(
    "refuses to add a driver whose name is already installed",
    async () => {
      const dir = tempDir();
      const first = await yap(["driver", "add", FIXTURE], dir);
      expect(first.code).toBe(0);

      const second = await yap(["driver", "add", FIXTURE], dir);
      expect(second.code).toBe(1);
      expect(second.stderr).toContain("already installed");
      expect(second.stderr).toContain("yap driver remove echo");
    },
    120_000,
  );

  it("refuses to remove a driver that is not installed", async () => {
    const res = await yap(["driver", "remove", "nope"], tempDir());
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('no driver named "nope" installed');
  });

  it("lists (none) when no drivers are installed", async () => {
    const res = await yap(["driver", "list"], tempDir());
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("(none)");
  });
}, 180_000);
