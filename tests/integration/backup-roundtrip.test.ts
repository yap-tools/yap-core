import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { exportBackup } from "../../src/backup/export.js";
import { readManifest } from "../../src/backup/format.js";
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
