import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { backupToSink, maybePreMigrationBackup } from "../../src/backup/auto.js";
import { createBackupSink, pruneSink } from "../../src/backup/sink.js";
import { createBlobStore } from "../../src/blob/index.js";
import type { YapConfig } from "../../src/config.js";
import { describeEachAdapter } from "../helpers/adapters.js";

function blobConfig(root: string): YapConfig {
  return {
    blob: { driver: "fs", root },
    masterKey: Buffer.alloc(32),
    baseUrl: "http://localhost:0",
  } as YapConfig;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "yap-auto-"));
  dirs.push(d);
  return d;
};

describeEachAdapter("automatic backups", (adapter) => {
  it("pre-migration: backs up when migrations are pending on a non-fresh db", async () => {
    const work = tmp();
    const db = await adapter.makeFreshDb();
    await db.migrateTo(0);
    await db.insertRows("users", [{ id: "u1", name: "a", created_at: "x" }]);
    const blob = await createBlobStore(blobConfig(join(work, "blobs")));
    const sink = await createBackupSink({ driver: "fs", root: join(work, "backups") });

    const name = await maybePreMigrationBackup({ db, blob, sink, yapVersion: "0.0.0" });
    expect(name).toMatch(/-pre-migration\.tar\.gz$/);
    expect(await sink.list()).toHaveLength(1);
    await db.close();
  });

  it("pre-migration: skips a fresh db and a fully migrated db", async () => {
    const work = tmp();
    const blob = await createBlobStore(blobConfig(join(work, "blobs")));
    const sink = await createBackupSink({ driver: "fs", root: join(work, "backups") });

    const fresh = await adapter.makeFreshDb();
    expect(await maybePreMigrationBackup({ db: fresh, blob, sink, yapVersion: "0.0.0" })).toBeUndefined();
    await fresh.close();

    const migrated = await adapter.makeDb();
    expect(await maybePreMigrationBackup({ db: migrated, blob, sink, yapVersion: "0.0.0" })).toBeUndefined();
    await migrated.close();
    expect(await sink.list()).toHaveLength(0);
  });

  it("backupToSink + pruneSink enforce retention newest-first", async () => {
    const work = tmp();
    const db = await adapter.makeDb();
    const blob = await createBlobStore(blobConfig(join(work, "blobs")));
    const sink = await createBackupSink({ driver: "fs", root: join(work, "backups") });

    const stamps = ["2026-06-10T00:00:00Z", "2026-06-11T00:00:00Z", "2026-06-12T00:00:00Z"];
    for (const s of stamps) {
      await backupToSink({ db, blob, sink, yapVersion: "0.0.0", now: () => new Date(s) }, "scheduled");
    }
    expect(await sink.list()).toHaveLength(3);

    const pruned = await pruneSink(sink, 2);
    expect(pruned).toEqual(["yap-backup-20260610T000000Z-scheduled.tar.gz"]);
    expect((await sink.list()).map((e) => e.name)).toEqual([
      "yap-backup-20260612T000000Z-scheduled.tar.gz",
      "yap-backup-20260611T000000Z-scheduled.tar.gz",
    ]);
    await db.close();
  });
});
