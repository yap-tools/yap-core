import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runBackup, runRestore } from "../../src/backup/run.js";
import { createBlobStore } from "../../src/blob/index.js";
import type { YapConfig } from "../../src/config.js";
import { createDb } from "../../src/db/index.js";
import { CliError } from "../../src/instance/errors.js";

/** A scaffolded sqlite/fs instance directory with its own .env. */
function makeInstance(): string {
  const dir = mkdtempSync(join(tmpdir(), "yap-cli-inst-"));
  writeFileSync(
    join(dir, ".env"),
    [
      `YAP_SYSADMIN_KEY=sysadmin-key-0123456789`,
      `YAP_MASTER_KEY=${randomBytes(32).toString("base64")}`,
      `YAP_PORT=39871`,
      `YAP_SQLITE_PATH=${join(dir, "data", "yap.db")}`,
      `YAP_BLOB_FS_ROOT=${join(dir, "data", "blobs")}`,
      `YAP_BACKUP_FS_ROOT=${join(dir, "data", "backups")}`,
      "",
    ].join("\n"),
  );
  return dir;
}

async function seedInstance(dir: string): Promise<void> {
  const db = await createDb({ dialect: "sqlite", path: join(dir, "data", "yap.db") });
  await db.migrate();
  await db.insertRows("users", [{ id: "u1", name: "ada", created_at: "2026-01-01T00:00:00Z" }]);
  await db.close();
  const blob = await createBlobStore({
    blob: { driver: "fs", root: join(dir, "data", "blobs") },
    masterKey: Buffer.alloc(32),
    baseUrl: "http://localhost:0",
  } as YapConfig);
  await blob.put("k1", new TextEncoder().encode("hi"));
}

describe("backup/restore CLI runners (sqlite/fs instance)", () => {
  let dir: string;
  let envBefore: NodeJS.ProcessEnv;

  beforeEach(async () => {
    envBefore = { ...process.env };
    for (const k of Object.keys(process.env)) if (k.startsWith("YAP_")) delete process.env[k];
    dir = makeInstance();
    process.env.YAP_ENV_FILE = join(dir, ".env");
    await seedInstance(dir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    // Mutate in place: replacing the process.env object would detach it from
    // the real environment that process.loadEnvFile writes into.
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, envBefore);
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("backs up to the sink, lists it, and restores --latest", async () => {
    await runBackup(dir, []);
    const archives = readdirSync(join(dir, "data", "backups"));
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatch(/^yap-backup-.*-manual\.tar\.gz$/);

    await runBackup(dir, ["list"]);
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(archives[0]);

    await runRestore(dir, ["--latest"]);
    // data intact, aside copies cleaned up
    const db = await createDb({ dialect: "sqlite", path: join(dir, "data", "yap.db") });
    const users = await db.snapshotRead(async (read) => read("users"));
    expect(users.map((u) => u.id)).toEqual(["u1"]);
    expect(await db.appliedMigrations()).toBe(db.journalLength());
    await db.close();
    expect(readdirSync(join(dir, "data")).filter((f) => f.includes("pre-restore"))).toEqual([]);
  });

  it("writes to an explicit --out path instead of the sink", async () => {
    await runBackup(dir, ["--out", join(dir, "explicit.tar.gz")]);
    expect(existsSync(join(dir, "explicit.tar.gz"))).toBe(true);
    expect(existsSync(join(dir, "data", "backups"))).toBe(false);
  });

  it("restores from an explicit archive path", async () => {
    await runBackup(dir, ["--out", join(dir, "explicit.tar.gz")]);
    await runRestore(dir, [join(dir, "explicit.tar.gz")]);
    const db = await createDb({ dialect: "sqlite", path: join(dir, "data", "yap.db") });
    const users = await db.snapshotRead(async (read) => read("users"));
    expect(users).toHaveLength(1);
    await db.close();
  });

  it("rejects unknown archive names and missing paths", async () => {
    await expect(runRestore(dir, ["yap-backup-20990101T000000Z-manual.tar.gz"])).rejects.toThrow(CliError);
    await expect(runRestore(dir, [join(dir, "nope.tar.gz")])).rejects.toThrow(CliError);
    await expect(runRestore(dir, [])).rejects.toThrow(/usage/);
  });

  it("puts the original data back when a restore fails", async () => {
    await runBackup(dir, ["--out", join(dir, "good.tar.gz")]);
    // corrupt a copy so the import throws midway through
    const { readManifest, writeArchiveRaw } = await import("../../src/backup/format.js");
    const manifest = await readManifest(join(dir, "good.tar.gz"));
    await writeArchiveRaw(join(dir, "bad.tar.gz"), { ...manifest, entries: [] }, [
      { name: "db/users.jsonl", bytes: Buffer.from("{not json}\n") },
    ]);
    await expect(runRestore(dir, [join(dir, "bad.tar.gz")])).rejects.toThrow();

    const db = await createDb({ dialect: "sqlite", path: join(dir, "data", "yap.db") });
    const users = await db.snapshotRead(async (read) => read("users"));
    expect(users.map((u) => u.id)).toEqual(["u1"]);
    await db.close();
    expect(readdirSync(join(dir, "data")).filter((f) => f.includes("pre-restore"))).toEqual([]);
  });
});
