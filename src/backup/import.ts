/**
 * Logical import: validate the manifest against this build's migration
 * journal, bring a fresh database to exactly the archive's schema position,
 * then insert rows parent-first and write blobs back. The caller owns
 * machine-level preparation (moving an existing SQLite file aside, --force
 * semantics for Postgres) — this function only refuses non-empty targets.
 */
import type { BlobStore } from "../blob/index.js";
import type { Db } from "../db/index.js";
import { MANIFEST_PATH, readArchive, readManifest, type BackupManifest } from "./format.js";

/** Parents before children, verified against src/db/schema-sqlite.ts FKs. */
const INSERT_ORDER = [
  "users",
  "access_keys",
  "spaces",
  "grants",
  "bundles",
  "bundle_docs",
  "item_types",
  "properties",
  "items",
  "item_values",
  "files",
  "hooks",
  "user_docs",
  "oauth_clients",
  "oauth_codes",
  "oauth_grants",
  "oauth_tokens",
];

const BYTES_TAG = "$bytes";

function decodeValue(v: unknown): unknown {
  if (v && typeof v === "object" && BYTES_TAG in (v as Record<string, unknown>)) {
    return Buffer.from(String((v as Record<string, unknown>)[BYTES_TAG]), "base64");
  }
  return v;
}

export interface ImportOpts {
  db: Db;
  blob: BlobStore;
  archivePath: string;
  force?: boolean;
}

export async function importArchive(opts: ImportOpts): Promise<BackupManifest> {
  const { db, blob, archivePath } = opts;
  const manifest = await readManifest(archivePath);

  if (manifest.db.migrationIndex >= db.journalLength()) {
    throw new Error(
      `archive needs migration index ${manifest.db.migrationIndex} but this server only knows ` +
        `${db.journalLength()} migrations — upgrade yap-core before restoring`,
    );
  }
  if ((await db.appliedMigrations()) > 0) {
    if (!opts.force) throw new Error("target database is not empty — pass --force to overwrite it");
    await db.dropAllTables();
  }

  await db.migrateTo(manifest.db.migrationIndex);

  const tableRows = new Map<string, Record<string, unknown>[]>();
  const blobs: { key: string; bytes: Buffer }[] = [];
  await readArchive(archivePath, async (name, bytes) => {
    if (name.startsWith("db/") && name.endsWith(".jsonl")) {
      const table = name.slice(3, -6);
      const rows = bytes
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const raw = JSON.parse(line) as Record<string, unknown>;
          return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, decodeValue(v)]));
        });
      tableRows.set(table, rows);
    } else if (name.startsWith("blobs/")) {
      blobs.push({ key: name.slice(6), bytes });
    } else if (name !== MANIFEST_PATH) {
      throw new Error(`unexpected archive entry: ${name}`);
    }
  });

  const known = INSERT_ORDER.filter((t) => tableRows.has(t));
  const unknown = [...tableRows.keys()].filter((t) => !INSERT_ORDER.includes(t)).sort();
  for (const table of [...known, ...unknown]) {
    await db.insertRows(table, tableRows.get(table)!);
  }
  for (const b of blobs) {
    await blob.put(b.key, b.bytes);
  }
  return manifest;
}
