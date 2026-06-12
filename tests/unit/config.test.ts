import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../../src/config.js";

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
    expect(config.hookTimeoutMs).toBe(30_000);
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
});
