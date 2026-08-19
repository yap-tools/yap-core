/**
 * `yap driver add|remove|list` plumbing: driver-name derivation from a
 * packed package.json, and the filesystem-only guards (refusing to overwrite
 * an installed driver, naming what's installed when `remove` targets an
 * unknown one). The real `npm pack`/install/import round trip is covered by
 * the integration test, which is slow by nature.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assertDriverAvailable, cmdDriverRemove, deriveDriverName } from "../../src/cli/driver-impl.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yap-cli-driver-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("deriveDriverName", () => {
  it("strips the yap-driver- prefix from an unscoped package name", () => {
    expect(deriveDriverName({ name: "yap-driver-echo" })).toBe("echo");
  });

  it("strips the scope, then the prefix, from a scoped package name", () => {
    expect(deriveDriverName({ name: "@acme/yap-driver-slack" })).toBe("slack");
  });

  it("keeps a scoped name with no yap-driver- prefix as-is", () => {
    expect(deriveDriverName({ name: "@acme/notifier" })).toBe("notifier");
  });

  it("prefers an explicit yap.name override over the package name", () => {
    expect(deriveDriverName({ name: "some-random-package", yap: { name: "custom" } })).toBe("custom");
  });

  it("ignores a blank yap.name override and falls back to the package name", () => {
    expect(deriveDriverName({ name: "yap-driver-echo", yap: { name: "  " } })).toBe("echo");
  });

  it("falls back to an empty string when there is no usable name at all", () => {
    expect(deriveDriverName({})).toBe("");
  });
});

describe("assertDriverAvailable", () => {
  it("passes when nothing is installed at the target folder", () => {
    const dir = tempDir();
    expect(() => assertDriverAvailable(join(dir, "echo"), "echo")).not.toThrow();
  });

  it("refuses when a driver is already installed there, and suggests remove", () => {
    const dir = tempDir();
    const target = join(dir, "echo");
    mkdirSync(target, { recursive: true });
    expect(() => assertDriverAvailable(target, "echo")).toThrow(
      /already installed.*yap driver remove echo/s,
    );
  });
});

describe("cmdDriverRemove", () => {
  it("deletes an installed driver's folder", () => {
    const dir = tempDir();
    const target = join(dir, "drivers", "echo");
    mkdirSync(target, { recursive: true });
    cmdDriverRemove(dir, "echo");
    expect(existsSync(target)).toBe(false);
  });

  it("refuses an unknown driver name and lists what is installed", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "drivers", "echo"), { recursive: true });
    mkdirSync(join(dir, "drivers", "slack"), { recursive: true });
    expect(() => cmdDriverRemove(dir, "bogus")).toThrow(/no driver named "bogus" installed.*echo, slack/s);
  });

  it("says none are installed when the drivers directory is empty or missing", () => {
    const dir = tempDir();
    expect(() => cmdDriverRemove(dir, "bogus")).toThrow(/no driver named "bogus" installed.*none are installed/s);
  });
});
