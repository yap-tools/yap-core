/**
 * Environment-level configuration. This is the layer that holds the sysadmin
 * key and the master encryption key, selects storage adapters, and carries
 * the operator-overridable operational policy (file limits, link TTLs, hook
 * timeout, SSRF allowlist).
 */

export interface SqliteDbConfig {
  dialect: "sqlite";
  /** File path or ":memory:". */
  path: string;
}

export interface PgDbConfig {
  dialect: "pg";
  url: string;
}

export interface FsBlobConfig {
  driver: "fs";
  root: string;
}

export interface S3BlobConfig {
  driver: "s3";
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Required for some S3-compatible providers (e.g. R2/MinIO). */
  forcePathStyle: boolean;
}

export interface YapConfig {
  port: number;
  host: string;
  /** Public base URL used when minting absolute links. */
  baseUrl: string;
  /** Environment credential for REST-only system administration. */
  sysadminKey: string;
  /** 32-byte master key: hook-secret encryption and link/token signing. */
  masterKey: Buffer;
  db: SqliteDbConfig | PgDbConfig;
  blob: FsBlobConfig | S3BlobConfig;
  uploadTtlSeconds: number;
  downloadTtlSeconds: number;
  widgetTokenTtlSeconds: number;
  oauthAccessTokenTtlSeconds: number;
  oauthRefreshTokenTtlSeconds: number;
  oauthCodeTtlSeconds: number;
  maxFileSizeBytes: number;
  /** "*" allows all MIME types. */
  mimeAllowlist: string[] | "*";
  hookTimeoutMs: number;
  /** Hostnames allowed to resolve to private ranges (SSRF override). */
  hookAllowHosts: string[];
  orphanSweepIntervalMs: number;
  /** Reserved file records older than this are swept. */
  orphanMaxAgeMs: number;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function intEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function listEnv(env: Env, name: string): string[] {
  const raw = env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: Env = process.env): YapConfig {
  const sysadminKey = env.YAP_SYSADMIN_KEY;
  if (!sysadminKey || sysadminKey.length < 16) {
    throw new ConfigError("YAP_SYSADMIN_KEY is required and must be at least 16 characters");
  }

  const masterKeyRaw = env.YAP_MASTER_KEY;
  if (!masterKeyRaw) {
    throw new ConfigError("YAP_MASTER_KEY is required (base64-encoded 32 bytes)");
  }
  let masterKey: Buffer;
  try {
    masterKey = Buffer.from(masterKeyRaw, "base64");
  } catch {
    throw new ConfigError("YAP_MASTER_KEY must be valid base64");
  }
  if (masterKey.length !== 32) {
    throw new ConfigError(`YAP_MASTER_KEY must decode to 32 bytes, got ${masterKey.length}`);
  }

  const port = intEnv(env, "YAP_PORT", 8787);
  const host = env.YAP_HOST || "0.0.0.0";
  const baseUrl = (env.YAP_BASE_URL || `http://localhost:${port}`).replace(/\/$/, "");

  const dbDialect = env.YAP_DB || "sqlite";
  let db: YapConfig["db"];
  if (dbDialect === "sqlite") {
    db = { dialect: "sqlite", path: env.YAP_SQLITE_PATH || "./data/yap.db" };
  } else if (dbDialect === "pg" || dbDialect === "postgres") {
    const url = env.YAP_DATABASE_URL;
    if (!url) throw new ConfigError("YAP_DATABASE_URL is required when YAP_DB=postgres");
    db = { dialect: "pg", url };
  } else {
    throw new ConfigError(`YAP_DB must be "sqlite" or "postgres", got ${JSON.stringify(dbDialect)}`);
  }

  const blobDriver = env.YAP_BLOB || "fs";
  let blob: YapConfig["blob"];
  if (blobDriver === "fs") {
    blob = { driver: "fs", root: env.YAP_BLOB_FS_ROOT || "./data/blobs" };
  } else if (blobDriver === "s3") {
    const bucket = env.YAP_S3_BUCKET;
    const region = env.YAP_S3_REGION || "auto";
    const accessKeyId = env.YAP_S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = env.YAP_S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY;
    if (!bucket || !accessKeyId || !secretAccessKey) {
      throw new ConfigError(
        "YAP_BLOB=s3 requires YAP_S3_BUCKET and credentials (YAP_S3_ACCESS_KEY_ID/YAP_S3_SECRET_ACCESS_KEY or AWS_*)",
      );
    }
    blob = {
      driver: "s3",
      bucket,
      region,
      endpoint: env.YAP_S3_ENDPOINT,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: env.YAP_S3_FORCE_PATH_STYLE === "true",
    };
  } else {
    throw new ConfigError(`YAP_BLOB must be "fs" or "s3", got ${JSON.stringify(blobDriver)}`);
  }

  const mimeRaw = env.YAP_MIME_ALLOWLIST;
  const mimeAllowlist: YapConfig["mimeAllowlist"] =
    !mimeRaw || mimeRaw === "*" ? "*" : listEnv(env, "YAP_MIME_ALLOWLIST");

  return {
    port,
    host,
    baseUrl,
    sysadminKey,
    masterKey,
    db,
    blob,
    uploadTtlSeconds: intEnv(env, "YAP_UPLOAD_TTL_SECONDS", 600),
    downloadTtlSeconds: intEnv(env, "YAP_DOWNLOAD_TTL_SECONDS", 300),
    widgetTokenTtlSeconds: intEnv(env, "YAP_WIDGET_TOKEN_TTL_SECONDS", 600),
    oauthAccessTokenTtlSeconds: intEnv(env, "YAP_OAUTH_ACCESS_TOKEN_TTL_SECONDS", 3600),
    oauthRefreshTokenTtlSeconds: intEnv(env, "YAP_OAUTH_REFRESH_TOKEN_TTL_SECONDS", 30 * 24 * 3600),
    oauthCodeTtlSeconds: intEnv(env, "YAP_OAUTH_CODE_TTL_SECONDS", 60),
    maxFileSizeBytes: intEnv(env, "YAP_MAX_FILE_SIZE_BYTES", 50 * 1024 * 1024),
    mimeAllowlist,
    hookTimeoutMs: intEnv(env, "YAP_HOOK_TIMEOUT_MS", 30_000),
    hookAllowHosts: listEnv(env, "YAP_HOOK_ALLOW_HOSTS"),
    orphanSweepIntervalMs: intEnv(env, "YAP_ORPHAN_SWEEP_INTERVAL_MS", 10 * 60 * 1000),
    orphanMaxAgeMs: intEnv(env, "YAP_ORPHAN_MAX_AGE_MS", 60 * 60 * 1000),
  };
}
