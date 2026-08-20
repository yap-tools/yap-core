/**
 * `yap driver add|remove|list` plumbing: driver-name derivation from a
 * packed package.json, and the filesystem-only guards (refusing to overwrite
 * an installed driver, naming what's installed when `remove` targets an
 * unknown one). The real `npm pack`/install/import round trip is covered by
 * the integration test, which is slow by nature.
 */
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { pack as tarPack } from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertDriverAvailable,
  cmdDriverRemove,
  deriveDriverName,
  extractTarball,
} from "../../src/cli/driver-impl.js";

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

  it("refuses a name that is not a driver name before touching the filesystem", () => {
    const dir = tempDir();
    // `../data` would resolve out of drivers/ and take the instance's data
    // directory with it — the name rule is checked first, so nothing is removed.
    const data = join(dir, "data");
    mkdirSync(data, { recursive: true });
    mkdirSync(join(dir, "drivers", "echo"), { recursive: true });

    for (const name of ["../data", "../../etc", "/etc", "Echo", "e", ".", "echo/../../data"]) {
      expect(() => cmdDriverRemove(dir, name), name).toThrow(/must match/);
    }
    expect(existsSync(data)).toBe(true);
    expect(existsSync(join(dir, "drivers", "echo"))).toBe(true);
  });
});

/** Builds a gzipped tarball at `outPath` from entries, hostile ones included. */
async function buildTarball(
  entries: Array<{ name: string; type?: "file" | "symlink" | "link"; linkname?: string; content?: string }>,
  outPath: string,
): Promise<void> {
  const packStream = tarPack();
  for (const e of entries) {
    if (e.type === "symlink" || e.type === "link") {
      packStream.entry({ name: e.name, type: e.type, linkname: e.linkname ?? "/etc/passwd" });
    } else {
      packStream.entry({ name: e.name }, e.content ?? "");
    }
  }
  packStream.finalize();
  await pipeline(packStream, createGzip(), createWriteStream(outPath));
}

describe("extractTarball", () => {
  it("extracts a well-formed tarball into destDir", async () => {
    const dir = tempDir();
    const tarballPath = join(dir, "good.tgz");
    await buildTarball(
      [
        { name: "package/package.json", content: '{"name":"yap-driver-echo"}' },
        { name: "package/index.js", content: "module.exports = {};" },
      ],
      tarballPath,
    );
    const destDir = join(dir, "extract");
    mkdirSync(destDir, { recursive: true });
    await extractTarball(tarballPath, destDir);
    expect(existsSync(join(destDir, "package.json"))).toBe(true);
    expect(existsSync(join(destDir, "index.js"))).toBe(true);
  });

  it("rejects a path-traversal entry and writes nothing outside destDir", async () => {
    const dir = tempDir();
    const tarballPath = join(dir, "evil.tgz");
    await buildTarball([{ name: "package/../escape.txt", content: "pwned" }], tarballPath);
    const destDir = join(dir, "extract");
    mkdirSync(destDir, { recursive: true });

    await expect(extractTarball(tarballPath, destDir)).rejects.toThrow(/package\/\.\.\/escape\.txt/);

    // The escape target ("<dir>/escape.txt", one level up from destDir) was
    // never written, nor was anything else written into the parent tmp dir.
    expect(existsSync(join(dir, "escape.txt"))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["evil.tgz", "extract"]);
  });

  it("rejects a symlink entry, naming it", async () => {
    const dir = tempDir();
    const tarballPath = join(dir, "symlink.tgz");
    await buildTarball([{ name: "package/link", type: "symlink", linkname: "/etc/passwd" }], tarballPath);
    const destDir = join(dir, "extract");
    mkdirSync(destDir, { recursive: true });

    await expect(extractTarball(tarballPath, destDir)).rejects.toThrow(/package\/link/);
  });

  it("rejects a hardlink entry, naming it", async () => {
    const dir = tempDir();
    const tarballPath = join(dir, "hardlink.tgz");
    await buildTarball([{ name: "package/link", type: "link", linkname: "package/package.json" }], tarballPath);
    const destDir = join(dir, "extract");
    mkdirSync(destDir, { recursive: true });

    await expect(extractTarball(tarballPath, destDir)).rejects.toThrow(/package\/link/);
  });
});
