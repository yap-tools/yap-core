/**
 * Backup archive format: a gzipped tar holding db/<table>.jsonl row dumps,
 * blobs/<key> file bytes, and a trailing manifest.json (written last so its
 * per-entry checksums and counts are complete). Readers therefore make two
 * passes over the (local) archive file: one for the manifest, one for data.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import { extract as tarExtract, pack as tarPack } from "tar-stream";

export type BackupTrigger = "manual" | "pre-migration" | "pre-upgrade" | "scheduled";

export interface ArchiveEntryMeta {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  format: 1;
  createdAt: string;
  yapVersion: string;
  trigger: BackupTrigger;
  db: { dialect: "sqlite" | "pg"; migrationIndex: number; migrationTag: string };
  blobDriver: "fs" | "s3";
  tables: Record<string, number>;
  blobs: { count: number; bytes: number };
  warnings: string[];
  entries?: ArchiveEntryMeta[];
}

export const MANIFEST_PATH = "manifest.json";

export function archiveName(at: Date, trigger: BackupTrigger): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `yap-backup-${stamp}-${trigger}.tar.gz`;
}

export function parseArchiveName(name: string): { stamp: string; trigger: BackupTrigger } | undefined {
  const m = /^yap-backup-(\d{8}T\d{6}Z)-(manual|pre-migration|pre-upgrade|scheduled)\.tar\.gz$/.exec(name);
  return m ? { stamp: m[1], trigger: m[2] as BackupTrigger } : undefined;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Write a manifest verbatim (no checksum computation). Exists so tests can
 * construct archives whose manifests deliberately disagree with the data. */
export async function writeArchiveRaw(
  path: string,
  manifest: BackupManifest,
  entries: { name: string; bytes: Buffer }[],
): Promise<void> {
  const pack = tarPack();
  const done = pipeline(pack, createGzip(), createWriteStream(path));
  for (const e of entries) pack.entry({ name: e.name }, e.bytes);
  pack.entry({ name: MANIFEST_PATH }, Buffer.from(JSON.stringify(manifest, null, 2)));
  pack.finalize();
  await done;
}

/** Entries first, manifest (with per-entry checksums) last. */
export async function writeArchive(
  path: string,
  manifest: Omit<BackupManifest, "entries">,
  entries: { name: string; bytes: Buffer }[],
): Promise<BackupManifest> {
  const full: BackupManifest = {
    ...manifest,
    entries: entries.map((e) => ({ path: e.name, bytes: e.bytes.length, sha256: sha256(e.bytes) })),
  };
  await writeArchiveRaw(path, full, entries);
  return full;
}

async function scan(path: string, onEntry: (name: string, bytes: Buffer) => Promise<void> | void): Promise<void> {
  const extract = tarExtract();
  extract.on("entry", (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      Promise.resolve(onEntry(header.name, Buffer.concat(chunks))).then(
        () => next(),
        (err: Error) => extract.destroy(err),
      );
    });
    stream.on("error", (err) => extract.destroy(err));
  });
  await pipeline(createReadStream(path), createGunzip(), extract);
}

export async function readManifest(path: string): Promise<BackupManifest> {
  let manifest: BackupManifest | undefined;
  await scan(path, (name, bytes) => {
    if (name === MANIFEST_PATH) manifest = JSON.parse(bytes.toString("utf8")) as BackupManifest;
  });
  if (!manifest) throw new Error(`not a yap backup archive (no ${MANIFEST_PATH}): ${path}`);
  if (manifest.format !== 1) throw new Error(`unsupported backup format ${String(manifest.format)}`);
  return manifest;
}

/** Second pass: yields each data entry, verified against the manifest checksum. */
export async function readArchive(
  path: string,
  onEntry: (name: string, bytes: Buffer) => Promise<void>,
): Promise<BackupManifest> {
  const manifest = await readManifest(path);
  const expected = new Map((manifest.entries ?? []).map((e) => [e.path, e.sha256]));
  await scan(path, async (name, bytes) => {
    if (name === MANIFEST_PATH) return;
    const want = expected.get(name);
    if (want && sha256(bytes) !== want) throw new Error(`backup entry ${name} failed checksum verification`);
    await onEntry(name, bytes);
  });
  return manifest;
}
