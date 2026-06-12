/**
 * Where finished backup archives live. The sink only ever sees complete
 * archive files (export writes to a temp path first), so every driver is a
 * dumb name→bytes namespace; retention is shared logic over list/remove.
 */
import { createReadStream, createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { FsBackupSinkConfig, S3BackupSinkConfig } from "../config.js";
import { parseArchiveName } from "./format.js";

export interface SinkEntry {
  name: string;
  /** 0 when the driver cannot report sizes cheaply. */
  bytes: number;
}

export interface BackupSink {
  driver: "fs" | "s3";
  /** Copy a finished archive (local file at srcPath) into the sink. */
  store(name: string, srcPath: string): Promise<void>;
  /** Valid archive names, newest first (names sort by their UTC stamp). */
  list(): Promise<SinkEntry[]>;
  /** Stream an archive's bytes out of the sink. */
  read(name: string): Promise<Readable>;
  remove(name: string): Promise<void>;
  /** Human description for log lines ("./data/backups", "s3://bucket/prefix"). */
  describe(): string;
}

/** Keep the newest `keep` archives, remove the rest. Returns removed names. */
export async function pruneSink(sink: BackupSink, keep: number): Promise<string[]> {
  const entries = await sink.list();
  const excess = entries.slice(Math.max(keep, 0));
  for (const e of excess) await sink.remove(e.name);
  return excess.map((e) => e.name);
}

export async function createBackupSink(config: FsBackupSinkConfig | S3BackupSinkConfig): Promise<BackupSink> {
  if (config.driver === "fs") {
    const root = resolve(config.root);
    return {
      driver: "fs",
      store: async (name, srcPath) => {
        mkdirSync(root, { recursive: true });
        await pipeline(createReadStream(srcPath), createWriteStream(join(root, name)));
      },
      list: async () => {
        let files: string[];
        try {
          files = readdirSync(root);
        } catch {
          return [];
        }
        return files
          .filter((f) => parseArchiveName(f))
          .sort()
          .reverse()
          .map((name) => ({ name, bytes: statSync(join(root, name)).size }));
      },
      read: async (name) => createReadStream(join(root, name)),
      remove: async (name) => rmSync(join(root, name), { force: true }),
      describe: () => config.root,
    };
  }

  const { Disk } = await import("flydrive");
  const { S3Driver } = await import("flydrive/drivers/s3");
  const disk = new Disk(
    new S3Driver({
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: config.forcePathStyle } : {}),
      bucket: config.bucket,
      visibility: "private",
    }),
  );
  const prefix = config.prefix.replace(/\/$/, "");
  const key = (name: string): string => (prefix ? `${prefix}/${name}` : name);
  return {
    driver: "s3",
    store: async (name, srcPath) => {
      await disk.putStream(key(name), createReadStream(srcPath));
    },
    list: async () => {
      const out: SinkEntry[] = [];
      let paginationToken: string | undefined;
      do {
        const page = await disk.listAll(prefix || undefined, { recursive: true, paginationToken });
        for (const item of page.objects) {
          if (item.isFile && parseArchiveName(item.name)) out.push({ name: item.name, bytes: 0 });
        }
        paginationToken = page.paginationToken;
      } while (paginationToken);
      return out.sort((a, b) => (a.name < b.name ? 1 : -1));
    },
    read: async (name) => (await disk.getStream(key(name))) as Readable,
    remove: async (name) => {
      await disk.delete(key(name));
    },
    describe: () => `s3://${config.bucket}${prefix ? `/${prefix}` : ""}`,
  };
}
