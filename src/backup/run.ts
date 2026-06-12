/**
 * In-process implementations of `yap backup` / `yap restore`, executed inside
 * the vendored server package (or a repo checkout) where the server's
 * dependencies exist. Loads the instance env exactly like serve() does.
 */
import { createWriteStream, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";

import { createBlobStore } from "../blob/index.js";
import { resolveEnvFile } from "../cli/env.js";
import { runningPid } from "../cli/proc.js";
import { CliError } from "../cli/util.js";
import { loadConfig, type YapConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { backupToSink } from "./auto.js";
import { exportBackup } from "./export.js";
import { parseArchiveName, readManifest, type BackupTrigger } from "./format.js";
import { importArchive } from "./import.js";
import { createBackupSink } from "./sink.js";

function loadEnvAndConfig(): YapConfig {
  const envFile = resolveEnvFile();
  if (envFile) process.loadEnvFile(envFile);
  return loadConfig();
}

function yapVersion(): string {
  return (createRequire(import.meta.url)("../../package.json") as { version: string }).version;
}

export async function runBackup(dir: string, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { out: { type: "string" }, trigger: { type: "string" } },
    allowPositionals: true,
  });
  const config = loadEnvAndConfig();

  if (positionals[0] === "list") {
    const sink = await createBackupSink(config.backup.sink);
    const entries = await sink.list();
    if (entries.length === 0) {
      console.log(`no backups in ${sink.describe()}`);
      return;
    }
    for (const e of entries) {
      const parsed = parseArchiveName(e.name)!;
      console.log(`${e.name}  (${parsed.trigger}${e.bytes ? `, ${e.bytes} bytes` : ""})`);
    }
    return;
  }
  if (positionals.length > 0) throw new CliError("usage: yap backup [list] [--out <path>]");

  const trigger = (values.trigger ?? "manual") as BackupTrigger;
  if (!["manual", "pre-migration", "pre-upgrade", "scheduled"].includes(trigger)) {
    throw new CliError(`unknown backup trigger ${JSON.stringify(values.trigger)}`);
  }
  const db = await createDb(config.db);
  try {
    if ((await db.appliedMigrations()) === 0) {
      throw new CliError("this instance's database has no schema yet (never served?) — nothing to back up");
    }
    const blob = await createBlobStore(config);
    if (values.out) {
      const out = isAbsolute(values.out) ? values.out : resolve(dir, values.out);
      const manifest = await exportBackup({ db, blob, trigger, yapVersion: yapVersion(), outPath: out });
      const rows = Object.values(manifest.tables).reduce((a, b) => a + b, 0);
      console.log(`backup written: ${out} (${rows} rows, ${manifest.blobs.count} blobs)`);
      for (const w of manifest.warnings) console.error(`warning: ${w}`);
    } else {
      const sink = await createBackupSink(config.backup.sink);
      const name = await backupToSink({ db, blob, sink, yapVersion: yapVersion() }, trigger);
      console.log(`backup written: ${name} → ${sink.describe()}`);
    }
  } finally {
    await db.close();
  }
}

export async function runRestore(dir: string, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { force: { type: "boolean" }, latest: { type: "boolean" } },
    allowPositionals: true,
  });
  const config = loadEnvAndConfig();

  if (runningPid(dir)) throw new CliError("the server is running — `yap stop` (or stop the service) before restoring");
  // Also refuse when something else (e.g. systemd) is serving this instance.
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) throw new CliError(`something is serving on port ${config.port} — stop it before restoring`);
  } catch (err) {
    if (err instanceof CliError) throw err; // an unreachable port is the good case
  }

  const ref = positionals[0];
  const work = mkdtempSync(join(tmpdir(), "yap-restore-"));
  try {
    // Resolve the archive to a local file: a sink name / --latest, or a path.
    let archivePath: string;
    if (values.latest || (ref && parseArchiveName(ref))) {
      const sink = await createBackupSink(config.backup.sink);
      const entries = await sink.list();
      const name = values.latest ? entries[0]?.name : ref!;
      if (!name || !entries.some((e) => e.name === name)) {
        throw new CliError(
          values.latest ? `no backups in ${sink.describe()}` : `no backup named ${name} in ${sink.describe()}`,
        );
      }
      archivePath = join(work, name);
      await pipeline(await sink.read(name), createWriteStream(archivePath));
    } else if (ref) {
      archivePath = isAbsolute(ref) ? ref : resolve(dir, ref);
      if (!existsSync(archivePath)) throw new CliError(`no such archive: ${archivePath}`);
    } else {
      throw new CliError("usage: yap restore <name|path> | yap restore --latest  [--force]");
    }

    const manifest = await readManifest(archivePath);
    console.log(
      `restoring ${manifest.createdAt} ${manifest.trigger} backup ` +
        `(schema index ${manifest.db.migrationIndex}, from ${manifest.db.dialect})`,
    );

    // Machine-level prep: keep the current data aside until the import succeeds.
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const aside: { from: string; to: string }[] = [];
    if (config.db.dialect === "sqlite" && config.db.path !== ":memory:") {
      const dbPath = resolve(dir, config.db.path);
      for (const suffix of ["", "-wal", "-shm"]) {
        const p = dbPath + suffix;
        if (existsSync(p)) aside.push({ from: p, to: `${p}.pre-restore-${stamp}` });
      }
    } else if (config.db.dialect === "pg" && !values.force) {
      // importArchive verifies emptiness too; surface the requirement early.
      console.error("note: restoring into Postgres replaces the schema; --force is required when the database is not empty");
    }
    if (config.blob.driver === "fs") {
      const root = resolve(dir, config.blob.root);
      if (existsSync(root)) aside.push({ from: root, to: `${root}.pre-restore-${stamp}` });
    } else {
      console.error(
        "warning: S3 blob store — restored blobs are written over the existing bucket contents; stale keys are not removed",
      );
    }
    for (const m of aside) renameSync(m.from, m.to);

    try {
      const db = await createDb(config.db);
      try {
        const blob = await createBlobStore(config);
        await importArchive({ db, blob, archivePath, force: values.force });
      } finally {
        await db.close();
      }
    } catch (err) {
      // Put the moved-aside data back exactly as it was.
      if (config.db.dialect === "sqlite" && config.db.path !== ":memory:") {
        const dbPath = resolve(dir, config.db.path);
        for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
      }
      for (const m of aside) {
        rmSync(m.from, { recursive: true, force: true });
        renameSync(m.to, m.from);
      }
      throw err;
    }
    for (const m of aside) rmSync(m.to, { recursive: true, force: true });
    console.log("restore complete — start the server to migrate forward to the current schema");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
