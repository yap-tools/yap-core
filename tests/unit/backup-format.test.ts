import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  archiveName,
  parseArchiveName,
  readArchive,
  readManifest,
  writeArchive,
  type BackupManifest,
} from "../../src/backup/format.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "yap-fmt-"));
  dirs.push(d);
  return d;
};

const baseManifest: Omit<BackupManifest, "entries"> = {
  format: 1,
  createdAt: "2026-06-12T14:00:00Z",
  yapVersion: "0.0.0",
  trigger: "manual",
  db: { dialect: "sqlite", migrationIndex: 3, migrationTag: "0003_x" },
  blobDriver: "fs",
  tables: { users: 1 },
  blobs: { count: 1, bytes: 3 },
  warnings: [],
};

describe("archive naming", () => {
  it("formats and parses round-trip", () => {
    const name = archiveName(new Date("2026-06-12T14:00:00Z"), "pre-upgrade");
    expect(name).toBe("yap-backup-20260612T140000Z-pre-upgrade.tar.gz");
    expect(parseArchiveName(name)).toEqual({ stamp: "20260612T140000Z", trigger: "pre-upgrade" });
    expect(parseArchiveName("random.tgz")).toBeUndefined();
  });
});

describe("archive io", () => {
  it("writes entries + manifest and reads them back, verifying checksums", async () => {
    const path = join(tmp(), "a.tar.gz");
    await writeArchive(path, baseManifest, [
      { name: "db/users.jsonl", bytes: Buffer.from('{"id":"u1"}\n') },
      { name: "blobs/k1", bytes: Buffer.from("abc") },
    ]);

    expect((await readManifest(path)).db.migrationIndex).toBe(3);

    const seen: string[] = [];
    const manifest = await readArchive(path, async (name, bytes) => {
      seen.push(`${name}:${bytes.length}`);
    });
    expect(seen).toContain("db/users.jsonl:12");
    expect(seen).toContain("blobs/k1:3");
    expect(manifest.entries).toHaveLength(2);
  });

  it("rejects a tampered entry by checksum", async () => {
    const path = join(tmp(), "a.tar.gz");
    await writeArchive(path, baseManifest, [{ name: "blobs/k1", bytes: Buffer.from("abc") }]);
    // Rewrite the archive with the same manifest but altered entry bytes, so
    // gzip/tar stay valid and only the recorded checksum disagrees.
    const manifest = await readManifest(path);
    const tampered = join(tmp(), "b.tar.gz");
    const { writeArchiveRaw } = await import("../../src/backup/format.js");
    await writeArchiveRaw(tampered, manifest, [{ name: "blobs/k1", bytes: Buffer.from("abX") }]);
    await expect(readArchive(tampered, async () => {})).rejects.toThrow(/checksum/);
  });

  it("rejects a truncated archive", async () => {
    const path = join(tmp(), "a.tar.gz");
    await writeArchive(path, baseManifest, [{ name: "blobs/k1", bytes: Buffer.from("abc") }]);
    truncateSync(path, statSync(path).size - 10);
    await expect(readManifest(path)).rejects.toThrow();
  });

  it("rejects a non-archive file", async () => {
    const path = join(tmp(), "x.tar.gz");
    writeFileSync(path, readFileSync("/dev/null"));
    await expect(readManifest(path)).rejects.toThrow();
  });
});
