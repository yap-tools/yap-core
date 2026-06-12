import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBackupSink, pruneSink } from "../../src/backup/sink.js";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("fs backup sink", () => {
  it("stores, lists (newest first), reads, removes and prunes", async () => {
    dir = mkdtempSync(join(tmpdir(), "yap-sink-"));
    const sink = await createBackupSink({ driver: "fs", root: join(dir, "backups") });
    const names = [
      "yap-backup-20260610T000000Z-scheduled.tar.gz",
      "yap-backup-20260611T000000Z-pre-upgrade.tar.gz",
      "yap-backup-20260612T000000Z-manual.tar.gz",
    ];
    for (const n of names) {
      const src = join(dir, "tmp-src");
      writeFileSync(src, n);
      await sink.store(n, src);
    }
    writeFileSync(join(dir, "backups", "unrelated.txt"), "x");

    expect((await sink.list()).map((e) => e.name)).toEqual([...names].reverse());

    const stream = await sink.read(names[2]);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(names[2]);

    const pruned = await pruneSink(sink, 2);
    expect(pruned).toEqual([names[0]]);
    expect((await sink.list()).map((e) => e.name)).toEqual([names[2], names[1]]);
  });

  it("lists empty when the directory does not exist yet", async () => {
    dir = mkdtempSync(join(tmpdir(), "yap-sink-"));
    const sink = await createBackupSink({ driver: "fs", root: join(dir, "missing") });
    expect(await sink.list()).toEqual([]);
  });
});
