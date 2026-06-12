import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { exportBackup } from "../../src/backup/export.js";
import { readManifest } from "../../src/backup/format.js";
import { importArchive } from "../../src/backup/import.js";
import { createBlobStore } from "../../src/blob/index.js";
import type { YapConfig } from "../../src/config.js";
import type { Db } from "../../src/db/index.js";
import { describeEachAdapter, type Adapter } from "../helpers/adapters.js";

/** Minimal config for an fs blob store rooted in a temp dir — the fs driver
 * only reads blob.root, masterKey and baseUrl. */
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
  const d = mkdtempSync(join(tmpdir(), "yap-rt-"));
  dirs.push(d);
  return d;
};

/** users + space + bundle + one finalized file row; blob bytes "hello" at k/f1. */
async function seed(db: Db, blobRoot: string): Promise<void> {
  const blob = await createBlobStore(blobConfig(blobRoot));
  await db.insertRows("users", [{ id: "u1", name: "ada", created_at: "2026-01-01T00:00:00Z" }]);
  await db.insertRows("spaces", [
    {
      id: "s1",
      owner_id: "u1",
      name: "sp",
      description: "",
      keywords: "",
      context: "",
      personal: 0,
      created_at: "x",
      updated_at: "x",
    },
  ]);
  await db.insertRows("bundles", [
    { id: "b1", space_id: "s1", name: "bu", description: "", docs: "", created_at: "x", updated_at: "x" },
  ]);
  await db.insertRows("files", [
    {
      id: "f1",
      bundle_id: "b1",
      space_id: "s1",
      owner_id: "u1",
      status: "finalized",
      name: "a.txt",
      mime_type: "text/plain",
      size: 5,
      storage_key: "k/f1",
      upload_consumed: 1,
      created_at: "x",
      finalized_at: "x",
    },
  ]);
  await blob.put("k/f1", new TextEncoder().encode("hello"));
}

describeEachAdapter("backup export", (adapter: Adapter) => {
  it("exports rows and blobs with an accurate manifest", async () => {
    const db = await adapter.makeDb();
    const work = tmp();
    await seed(db, join(work, "blobs"));
    const blob = await createBlobStore(blobConfig(join(work, "blobs")));

    const out = join(work, "out.tar.gz");
    const manifest = await exportBackup({ db, blob, trigger: "manual", yapVersion: "0.0.0", outPath: out });

    expect(manifest.tables.users).toBe(1);
    expect(manifest.tables.files).toBe(1);
    expect(manifest.blobs).toEqual({ count: 1, bytes: 5 });
    expect(manifest.db.migrationIndex).toBe(db.journalLength() - 1);
    expect(manifest.db.dialect).toBe(adapter.dialect);
    expect(manifest.warnings).toEqual([]);
    expect((await readManifest(out)).trigger).toBe("manual");
    await db.close();
  });

  it("records a warning for a finalized file whose blob is missing", async () => {
    const db = await adapter.makeDb();
    const work = tmp();
    await seed(db, join(work, "blobs"));
    const blob = await createBlobStore(blobConfig(join(work, "blobs")));
    await db.insertRows("files", [
      {
        id: "f2",
        bundle_id: "b1",
        space_id: "s1",
        owner_id: "u1",
        status: "finalized",
        name: "",
        mime_type: "",
        size: 0,
        storage_key: "gone",
        upload_consumed: 1,
        created_at: "x",
        finalized_at: "x",
      },
    ]);
    const manifest = await exportBackup({
      db,
      blob,
      trigger: "manual",
      yapVersion: "0.0.0",
      outPath: join(work, "o.tar.gz"),
    });
    expect(manifest.warnings).toHaveLength(1);
    expect(manifest.blobs.count).toBe(1);
    await db.close();
  });

  it("refuses to export a schema-less database", async () => {
    const db = await adapter.makeFreshDb();
    const work = tmp();
    const blob = await createBlobStore(blobConfig(join(work, "blobs")));
    await expect(
      exportBackup({ db, blob, trigger: "manual", yapVersion: "0.0.0", outPath: join(work, "o.tar.gz") }),
    ).rejects.toThrow(/no schema/);
    await db.close();
  });
});

describeEachAdapter("backup import", (adapter: Adapter) => {
  it("round-trips all rows and blobs into a fresh database", async () => {
    const db = await adapter.makeDb();
    const work = tmp();
    await seed(db, join(work, "blobs"));
    const blob = await createBlobStore(blobConfig(join(work, "blobs")));
    const out = join(work, "out.tar.gz");
    await exportBackup({ db, blob, trigger: "manual", yapVersion: "0.0.0", outPath: out });
    await db.close();

    const db2 = await adapter.makeFreshDb();
    const blob2 = await createBlobStore(blobConfig(join(work, "blobs2")));
    const result = await importArchive({ db: db2, blob: blob2, archivePath: out });
    expect(result.tables.users).toBe(1);

    const users = await db2.snapshotRead(async (read) => read("users"));
    expect(users).toEqual([{ id: "u1", name: "ada", created_at: "2026-01-01T00:00:00Z" }]);
    const files = await db2.snapshotRead(async (read) => read("files"));
    expect(files).toHaveLength(1);
    expect(await blob2.stat("k/f1")).toMatchObject({ size: 5 });

    // schema sits at the archive's index; a normal migrate() completes it
    await db2.migrate();
    expect(await db2.appliedMigrations()).toBe(db2.journalLength());
    await db2.close();
  });

  it("refuses a non-empty target without force and replaces it with force", async () => {
    const work = tmp();
    const db = await adapter.makeDb();
    await seed(db, join(work, "blobs"));
    const blob = await createBlobStore(blobConfig(join(work, "blobs")));
    const out = join(work, "out.tar.gz");
    await exportBackup({ db, blob, trigger: "manual", yapVersion: "0.0.0", outPath: out });
    await db.close();

    const target = await adapter.makeDb();
    await target.insertRows("users", [{ id: "old", name: "old", created_at: "x" }]);
    const blob2 = await createBlobStore(blobConfig(join(work, "blobs2")));
    await expect(importArchive({ db: target, blob: blob2, archivePath: out })).rejects.toThrow(/not empty/);

    await importArchive({ db: target, blob: blob2, archivePath: out, force: true });
    const users = await target.snapshotRead(async (read) => read("users"));
    expect(users.map((u) => u.id)).toEqual(["u1"]);
    await target.close();
  });

  it("restores an old-schema export and migrates forward", async () => {
    const work = tmp();
    const db = await adapter.makeFreshDb();
    await db.migrateTo(0);
    await db.insertRows("users", [{ id: "u1", name: "old", created_at: "x" }]);
    const blob = await createBlobStore(blobConfig(join(work, "blobs")));
    const out = join(work, "old.tar.gz");
    const manifest = await exportBackup({ db, blob, trigger: "manual", yapVersion: "0.0.0", outPath: out });
    expect(manifest.db.migrationIndex).toBe(0);
    await db.close();

    const db2 = await adapter.makeFreshDb();
    const blob2 = await createBlobStore(blobConfig(join(work, "blobs2")));
    await importArchive({ db: db2, blob: blob2, archivePath: out });
    expect(await db2.appliedMigrations()).toBe(1);
    await db2.migrate();
    expect(await db2.appliedMigrations()).toBe(db2.journalLength());
    const users = await db2.snapshotRead(async (read) => read("users"));
    expect(users[0]?.id).toBe("u1");
    await db2.close();
  });

  it("rejects an archive newer than this build's journal", async () => {
    const work = tmp();
    const db = await adapter.makeDb();
    await seed(db, join(work, "blobs"));
    const blob = await createBlobStore(blobConfig(join(work, "blobs")));
    const out = join(work, "out.tar.gz");
    const manifest = await exportBackup({ db, blob, trigger: "manual", yapVersion: "0.0.0", outPath: out });
    await db.close();

    const { writeArchiveRaw } = await import("../../src/backup/format.js");
    const future = join(work, "future.tar.gz");
    await writeArchiveRaw(
      future,
      { ...manifest, db: { ...manifest.db, migrationIndex: 9999 }, entries: [] },
      [],
    );
    const db2 = await adapter.makeFreshDb();
    const blob2 = await createBlobStore(blobConfig(join(work, "blobs2")));
    await expect(importArchive({ db: db2, blob: blob2, archivePath: future })).rejects.toThrow(/upgrade yap-core/);
    await db2.close();
  });
});

// Cross-dialect restores: a sqlite archive into pg (and back) — the whole
// point of the normalized format. Runs when a pg test database is available.
const PG_URL = process.env.YAP_TEST_PG_URL;
it.runIf(PG_URL)("cross-dialect: sqlite export restores into pg and back", async () => {
  const { createDb } = await import("../../src/db/index.js");
  const work = tmp();
  const sqliteDb = await createDb({ dialect: "sqlite", path: ":memory:" });
  await sqliteDb.migrate();
  await seed(sqliteDb, join(work, "blobs"));
  const blob = await createBlobStore(blobConfig(join(work, "blobs")));
  const out = join(work, "out.tar.gz");
  await exportBackup({ db: sqliteDb, blob, trigger: "manual", yapVersion: "0.0.0", outPath: out });
  await sqliteDb.close();

  const pgDb = await createDb({ dialect: "pg", url: PG_URL! });
  await pgDb.dropAllTables();
  const blob2 = await createBlobStore(blobConfig(join(work, "blobs2")));
  await importArchive({ db: pgDb, blob: blob2, archivePath: out });
  const users = await pgDb.snapshotRead(async (read) => read("users"));
  expect(users).toEqual([{ id: "u1", name: "ada", created_at: "2026-01-01T00:00:00Z" }]);

  // and back: pg → sqlite
  const back = join(work, "back.tar.gz");
  await exportBackup({ db: pgDb, blob: blob2, trigger: "manual", yapVersion: "0.0.0", outPath: back });
  await pgDb.dropAllTables();
  await pgDb.close();

  const sqlite2 = await createDb({ dialect: "sqlite", path: ":memory:" });
  const blob3 = await createBlobStore(blobConfig(join(work, "blobs3")));
  await importArchive({ db: sqlite2, blob: blob3, archivePath: back });
  const users2 = await sqlite2.snapshotRead(async (read) => read("users"));
  expect(users2.map((u) => u.id)).toEqual(["u1"]);
  await sqlite2.close();
});
