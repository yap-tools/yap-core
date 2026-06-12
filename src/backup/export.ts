/**
 * Logical export: every data table as JSONL (raw DB column names, read inside
 * one snapshot so a live server exports consistently) plus every finalized
 * file's blob bytes. Rows are read with SELECT *, never through the TS
 * schema, so this works at whatever schema version the database is at —
 * including one older than this build (the pre-migration backup case).
 *
 * Tables and blobs are buffered in memory while packing; with the default
 * 50 MB max file size this is the accepted v1 tradeoff.
 */
import type { Readable } from "node:stream";

import type { BlobStore } from "../blob/index.js";
import { journalTag, type Db } from "../db/index.js";
import { writeArchive, type BackupManifest, type BackupTrigger } from "./format.js";

const BYTES_TAG = "$bytes";

/** All schema columns are text/integer by project convention; the base64 tag
 * is a guard for any future binary column. */
function encodeValue(v: unknown): unknown {
  if (v instanceof Uint8Array) return { [BYTES_TAG]: Buffer.from(v).toString("base64") };
  return v;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export interface ExportOpts {
  db: Db;
  blob: BlobStore;
  trigger: BackupTrigger;
  yapVersion: string;
  outPath: string;
}

export async function exportBackup(opts: ExportOpts): Promise<BackupManifest> {
  const { db, blob } = opts;
  const applied = await db.appliedMigrations();
  if (applied === 0) throw new Error("database has no schema yet — nothing to back up");
  const migrationIndex = applied - 1;

  const tableRows = await db.snapshotRead(async (read) => {
    const out = new Map<string, Record<string, unknown>[]>();
    for (const name of await db.listDataTables()) out.set(name, await read(name));
    return out;
  });

  const entries: { name: string; bytes: Buffer }[] = [];
  const tables: Record<string, number> = {};
  for (const [name, rows] of tableRows) {
    tables[name] = rows.length;
    const jsonl = rows
      .map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, encodeValue(v)]))))
      .join("\n");
    entries.push({ name: `db/${name}.jsonl`, bytes: Buffer.from(jsonl + (rows.length ? "\n" : "")) });
  }

  const warnings: string[] = [];
  let blobCount = 0;
  let blobBytes = 0;
  for (const row of tableRows.get("files") ?? []) {
    if (row.status !== "finalized") continue;
    const key = String(row.storage_key);
    const stat = await blob.stat(key);
    if (!stat) {
      warnings.push(`blob missing for file ${String(row.id)} (key ${key})`);
      continue;
    }
    const bytes = await streamToBuffer(await blob.getStream(key));
    entries.push({ name: `blobs/${key}`, bytes });
    blobCount += 1;
    blobBytes += bytes.length;
  }

  return writeArchive(
    opts.outPath,
    {
      format: 1,
      createdAt: new Date().toISOString(),
      yapVersion: opts.yapVersion,
      trigger: opts.trigger,
      db: { dialect: db.dialect, migrationIndex, migrationTag: journalTag(db.dialect, migrationIndex) },
      blobDriver: blob.driver,
      tables,
      blobs: { count: blobCount, bytes: blobBytes },
      warnings,
    },
    entries,
  );
}
