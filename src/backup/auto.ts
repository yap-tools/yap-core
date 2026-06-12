/**
 * The automatic paths: export-to-temp-then-sink (shared by every trigger),
 * the pre-migration gate, and the in-process cron scheduler.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cron } from "croner";

import type { BlobStore } from "../blob/index.js";
import type { Db } from "../db/index.js";
import type { YapLogger } from "../logger.js";
import { exportBackup } from "./export.js";
import { archiveName, type BackupTrigger } from "./format.js";
import { pruneSink, type BackupSink } from "./sink.js";

export interface AutoBackupCtx {
  db: Db;
  blob: BlobStore;
  sink: BackupSink;
  yapVersion: string;
  /** Test injection for deterministic archive names. */
  now?: () => Date;
}

export async function backupToSink(ctx: AutoBackupCtx, trigger: BackupTrigger): Promise<string> {
  const name = archiveName((ctx.now ?? (() => new Date()))(), trigger);
  const work = mkdtempSync(join(tmpdir(), "yap-backup-"));
  try {
    const path = join(work, name);
    await exportBackup({ db: ctx.db, blob: ctx.blob, trigger, yapVersion: ctx.yapVersion, outPath: path });
    await ctx.sink.store(name, path);
    return name;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Backs up iff the db has a schema (something to lose) and migrations are pending. */
export async function maybePreMigrationBackup(ctx: AutoBackupCtx): Promise<string | undefined> {
  const applied = await ctx.db.appliedMigrations();
  if (applied === 0 || applied >= ctx.db.journalLength()) return undefined;
  return backupToSink(ctx, "pre-migration");
}

/** Scheduled backups never take the server down; failures are logged loudly. */
export function startBackupScheduler(
  ctx: AutoBackupCtx,
  schedule: string,
  keep: number | undefined,
  logger: YapLogger,
): () => void {
  // protect: skip a tick while the previous run is still going.
  const job = new Cron(schedule, { protect: true }, async () => {
    try {
      const name = await backupToSink(ctx, "scheduled");
      logger.info(`scheduled backup written: ${name} → ${ctx.sink.describe()}`);
      if (keep !== undefined) {
        const pruned = await pruneSink(ctx.sink, keep);
        if (pruned.length) logger.info(`pruned ${pruned.length} old backup(s): ${pruned.join(", ")}`);
      }
    } catch (err) {
      logger.error("scheduled backup failed", err);
    }
  });
  return () => job.stop();
}
