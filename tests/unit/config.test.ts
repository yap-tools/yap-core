import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ConfigError, MAX_TIMER_MS, loadConfig } from "../../src/config.js";

const base = {
  YAP_SYSADMIN_KEY: "sysadmin-key-0123456789",
  YAP_MASTER_KEY: randomBytes(32).toString("base64"),
};

describe("loadConfig", () => {
  it("requires a sysadmin key", () => {
    expect(() => loadConfig({ ...base, YAP_SYSADMIN_KEY: undefined })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, YAP_SYSADMIN_KEY: "short" })).toThrow(ConfigError);
  });

  it("requires a 32-byte base64 master key", () => {
    expect(() => loadConfig({ ...base, YAP_MASTER_KEY: undefined })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, YAP_MASTER_KEY: randomBytes(16).toString("base64") })).toThrow(
      ConfigError,
    );
  });

  it("applies single-machine defaults: sqlite + local disk", () => {
    const config = loadConfig(base);
    expect(config.db).toEqual({ dialect: "sqlite", path: "./data/yap.db" });
    expect(config.blob).toEqual({ driver: "fs", root: "./data/blobs" });
    expect(config.port).toBe(8787);
    expect(config.baseUrl).toBe("http://localhost:8787");
    expect(config.mimeAllowlist).toBe("*");
    expect(config.downloadTtlSeconds).toBe(14400);
    expect(config.hookTimeoutMs).toBe(30_000);
    // Instance-relative, like the sqlite and blob paths.
    expect(config.driversDir).toBe("./drivers");
  });

  it("takes the drivers directory from the environment", () => {
    expect(loadConfig({ ...base, YAP_DRIVERS_DIR: "/srv/yap/drivers" }).driversDir).toBe("/srv/yap/drivers");
  });

  it("selects postgres and requires its url", () => {
    expect(() => loadConfig({ ...base, YAP_DB: "postgres" })).toThrow(ConfigError);
    const config = loadConfig({ ...base, YAP_DB: "postgres", YAP_DATABASE_URL: "postgres://x/y" });
    expect(config.db).toEqual({ dialect: "pg", url: "postgres://x/y" });
  });

  it("selects s3 and requires bucket + credentials", () => {
    expect(() => loadConfig({ ...base, YAP_BLOB: "s3" })).toThrow(ConfigError);
    const config = loadConfig({
      ...base,
      YAP_BLOB: "s3",
      YAP_S3_BUCKET: "b",
      YAP_S3_ACCESS_KEY_ID: "ak",
      YAP_S3_SECRET_ACCESS_KEY: "sk",
    });
    expect(config.blob).toMatchObject({ driver: "s3", bucket: "b" });
  });

  it("parses operator overrides", () => {
    const config = loadConfig({
      ...base,
      YAP_MAX_FILE_SIZE_BYTES: "1024",
      YAP_MIME_ALLOWLIST: "image/png, image/jpeg",
      YAP_HOOK_ALLOW_HOSTS: "internal.example, 10.0.0.5",
      YAP_DOWNLOAD_TTL_SECONDS: "60",
    });
    expect(config.maxFileSizeBytes).toBe(1024);
    expect(config.mimeAllowlist).toEqual(["image/png", "image/jpeg"]);
    expect(config.hookAllowHosts).toEqual(["internal.example", "10.0.0.5"]);
    expect(config.downloadTtlSeconds).toBe(60);
  });

  it("rejects malformed numbers", () => {
    expect(() => loadConfig({ ...base, YAP_PORT: "nope" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, YAP_PORT: "-1" })).toThrow(ConfigError);
  });

  it("truncates fractional millisecond settings to whole integers", () => {
    // The driver registry requires integer action budgets, so the config layer
    // is where a fractional override is squared away.
    expect(loadConfig({ ...base, YAP_HOOK_TIMEOUT_MS: "1500.7" }).hookTimeoutMs).toBe(1500);
    expect(() => loadConfig({ ...base, YAP_HOOK_TIMEOUT_MS: "0.5" })).toThrow(ConfigError);
  });
});

describe("run config", () => {
  it("defaults: 25s wait cap, no timeout cap, 7-day retention", () => {
    const config = loadConfig(base);
    expect(config.runWaitCapMs).toBe(25_000);
    expect(config.runTimeoutCapMs).toBeUndefined();
    expect(config.runRetentionDays).toBe(7);
  });

  it("parses operator overrides", () => {
    const config = loadConfig({
      ...base,
      YAP_RUN_WAIT_CAP_MS: "5000",
      YAP_RUN_TIMEOUT_CAP_MS: "60000",
      YAP_RUN_RETENTION_DAYS: "30",
    });
    expect(config.runWaitCapMs).toBe(5_000);
    expect(config.runTimeoutCapMs).toBe(60_000);
    expect(config.runRetentionDays).toBe(30);
  });

  it("rejects malformed run settings", () => {
    expect(() => loadConfig({ ...base, YAP_RUN_WAIT_CAP_MS: "nope" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, YAP_RUN_TIMEOUT_CAP_MS: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, YAP_RUN_RETENTION_DAYS: "-3" })).toThrow(ConfigError);
  });

  it("refuses a timer setting above the longest delay a timer can hold", () => {
    // Above MAX_TIMER_MS setTimeout wraps to ~1ms, so a huge budget would fire
    // at once — the opposite of what the operator asked for. The exact ceiling
    // is still accepted; one millisecond past it is not.
    for (const name of ["YAP_HOOK_TIMEOUT_MS", "YAP_RUN_WAIT_CAP_MS", "YAP_RUN_TIMEOUT_CAP_MS"]) {
      expect(loadConfig({ ...base, [name]: String(MAX_TIMER_MS) }), name).toBeTruthy();
      expect(() => loadConfig({ ...base, [name]: String(MAX_TIMER_MS + 1) }), name).toThrow(
        /must be at most 2147483647/,
      );
    }
  });
});

describe("backup config", () => {
  it("defaults: fs sink under ./data/backups, beforeMigrate on, no schedule", () => {
    const config = loadConfig(base);
    expect(config.backup.sink).toEqual({ driver: "fs", root: "./data/backups" });
    expect(config.backup.beforeMigrate).toBe(true);
    expect(config.backup.schedule).toBeUndefined();
    expect(config.backup.keep).toBeUndefined();
  });

  it("parses schedule, keep, and opt-out", () => {
    const config = loadConfig({
      ...base,
      YAP_BACKUP_BEFORE_MIGRATE: "false",
      YAP_BACKUP_SCHEDULE: "0 3 * * *",
      YAP_BACKUP_KEEP: "7",
    });
    expect(config.backup.beforeMigrate).toBe(false);
    expect(config.backup.schedule).toBe("0 3 * * *");
    expect(config.backup.keep).toBe(7);
  });

  it("s3 sink requires a bucket, creds fall back to blob/AWS vars", () => {
    expect(() => loadConfig({ ...base, YAP_BACKUP_SINK: "s3" })).toThrow(ConfigError);
    const config = loadConfig({
      ...base,
      YAP_BACKUP_SINK: "s3",
      YAP_BACKUP_S3_BUCKET: "backups",
      AWS_ACCESS_KEY_ID: "ak",
      AWS_SECRET_ACCESS_KEY: "sk",
    });
    expect(config.backup.sink).toMatchObject({ driver: "s3", bucket: "backups", prefix: "" });
  });

  it("rejects an unknown sink driver", () => {
    expect(() => loadConfig({ ...base, YAP_BACKUP_SINK: "ftp" })).toThrow(ConfigError);
  });
});
