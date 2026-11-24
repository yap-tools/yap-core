/**
 * Environment-level configuration. This is the layer that holds the sysadmin
 * key and the master encryption key, selects storage adapters, and carries
 * the operator-overridable operational policy (file limits, link TTLs, the
 * http driver's timeout, SSRF allowlist, run wait/timeout caps and
 * retention).
 */

/**
 * Default ceiling on how long a caller may ask to wait for a run. Named
 * because the MCP `run_service` description quotes it to agents, and a static
 * tool table has no config to read it from — an operator who raises
 * YAP_RUN_WAIT_CAP_MS only makes the advertised figure conservative.
 */
export const DEFAULT_RUN_WAIT_CAP_MS = 25_000;

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

export interface FsBackupSinkConfig {
  driver: "fs";
  root: string;
}

export interface S3BackupSinkConfig {
  driver: "s3";
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Key prefix inside the bucket ("" = bucket root). */
  prefix: string;
}

export interface BackupConfig {
  sink: FsBackupSinkConfig | S3BackupSinkConfig;
  /** Snapshot automatically before pending schema migrations at startup. */
  beforeMigrate: boolean;
  /** Cron expression for scheduled backups; unset disables the scheduler. */
  schedule?: string;
  /** Retention: prune the sink to the newest n archives after scheduled runs. */
  keep?: number;
}

/**
 * One OpenID Connect provider a person can log in with on the pages Core
 * serves itself (see core/oidc.ts). Core is a plain OIDC client of it: the
 * operator registers Core there with the callback
 * `<YAP_BASE_URL>/oidc/<name>/callback` and puts the client id and secret here.
 */
export interface OidcProviderConfig {
  /** Lowercase name from YAP_OIDC_PROVIDERS; it names the env vars and the callback path. */
  name: string;
  /** The provider's issuer URL, exactly as its discovery document states it. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Shown on the button: "Continue with {label}". */
  label: string;
  /** How long a grant made after this provider's login lives, counted from its creation. */
  grantMaxDays: number;
}

export interface OidcConfig {
  /** Empty: key login only, exactly as before providers existed. */
  providers: OidcProviderConfig[];
  /** Whether a first provider login with no Yap account may create one (allowlist permitting). */
  signup: boolean;
  /** Who sign-up admits: exact lowercase addresses and `@domain` entries. */
  allow: string[];
}

/** The roles an OAuth grant can carry, lowest first. */
export type OAuthRole = "read-only" | "member" | "admin";

export interface YapConfig {
  port: number;
  host: string;
  /** Public base URL used when minting absolute links. */
  baseUrl: string;
  /** Environment credential for REST-only system administration. */
  sysadminKey: string;
  /** 32-byte master key: service-config encryption and link/token signing. */
  masterKey: Buffer;
  db: SqliteDbConfig | PgDbConfig;
  blob: FsBlobConfig | S3BlobConfig;
  backup: BackupConfig;
  uploadTtlSeconds: number;
  downloadTtlSeconds: number;
  widgetTokenTtlSeconds: number;
  /** How long a secret request (the one-off form for a service's secrets) stays open, and a service approve page too. */
  secretRequestTtlSeconds: number;
  oauthAccessTokenTtlSeconds: number;
  oauthRefreshTokenTtlSeconds: number;
  oauthCodeTtlSeconds: number;
  /** The highest role the consent screen offers, whatever the login method; unset = admin. */
  oauthMaxRole?: OAuthRole;
  /** Login providers for the pages Core serves itself. */
  oidc: OidcConfig;
  /**
   * Whether access keys log people in and authenticate API calls. On unless
   * YAP_KEY_LOGIN=false. Off, the pages offer only the login providers, no
   * user key can be made, and a user key is refused on /v1 and /mcp; OAuth
   * tokens from a provider login and the sysadmin key keep working (see
   * core/keyLogin.ts).
   */
  keyLogin: boolean;
  maxFileSizeBytes: number;
  /** "*" allows all MIME types. */
  mimeAllowlist: string[] | "*";
  /** Instance-wide kill switch for sideloading (the server fetching a
   *  caller-supplied URL into a bundle). On unless explicitly turned off. */
  sideloadEnabled: boolean;
  /** One wall-clock budget for a whole sideload: DNS, every redirect hop and
   *  the body. */
  sideloadTimeoutMs: number;
  hookTimeoutMs: number;
  /** Hostnames allowed to resolve to private ranges (SSRF override). Applies
   *  to all driver egress, not just the http driver's — the env var keeps its
   *  pre-services name (`YAP_HOOK_ALLOW_HOSTS`) for operator compatibility. */
  egressAllowHosts: string[];
  /** Ceiling the adapters clamp a caller's `wait_ms` to when starting a run.
   *  Defaults to {@link DEFAULT_RUN_WAIT_CAP_MS}, the figure the `run_service`
   *  tool description quotes to agents. */
  runWaitCapMs: number;
  /** Operator ceiling on a driver action's own timeout; unset = no cap. */
  runTimeoutCapMs?: number;
  /** Terminal runs older than this are pruned by the retention sweep. */
  runRetentionDays: number;
  orphanSweepIntervalMs: number;
  /** Reserved file records older than this are swept. */
  orphanMaxAgeMs: number;
  /** Directory the operator installs drivers into; resolved against the
   *  working directory, like the sqlite and blob paths. Missing = no external
   *  drivers. */
  driversDir: string;
  /** Whether this process fires service schedules. One process per database
   *  should: every process with it on fires every schedule. Off still lets
   *  schedules be authored and listed. */
  schedulerEnabled: boolean;
}

export class ConfigError extends Error {}

/**
 * The longest delay a Node timer can hold: `setTimeout` stores it as a 32-bit
 * signed integer, and anything larger silently wraps to ~1ms — a "generous"
 * budget that fires at once. Every setting below that becomes a timer delay is
 * refused above this rather than clamped, because a wait an operator asked for
 * and did not get is a surprise either way, and the message can only explain
 * the ceiling at the point the value is read.
 */
export const MAX_TIMER_MS = 2_147_483_647;

type Env = Record<string, string | undefined>;

/**
 * A positive integer setting. Fractions are truncated rather than rejected —
 * consumers downstream (the driver registry's action budgets, timers, byte
 * limits) all want whole numbers — but a value that truncates to zero is not a
 * positive integer at all, so it is refused.
 */
function intEnv(env: Env, name: string, fallback: number, max?: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  if (max !== undefined && n > max) {
    throw new ConfigError(`${name} must be at most ${max}, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Same rules as intEnv, but "unset" is a meaningful value (no ceiling). */
function optionalIntEnv(env: Env, name: string, max?: number): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  return intEnv(env, name, 0, max);
}

function listEnv(env: Env, name: string): string[] {
  const raw = env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const OIDC_NAME = /^[a-z][a-z0-9_]{0,31}$/;
/** A grant lifetime longer than ten years is a typo, not a policy. */
const MAX_GRANT_DAYS = 3650;

/** https, or http on a loopback host (a provider running beside a test or dev instance). */
function isSecureOrLoopback(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

/**
 * YAP_OIDC_PROVIDERS=google,okta, then per name YAP_OIDC_<NAME>_ISSUER,
 * _CLIENT_ID, _CLIENT_SECRET, optional _LABEL and _GRANT_MAX_DAYS. Every
 * mistake fails startup: a login method that half works is worse than none.
 */
function loadOidc(env: Env, baseUrlSet: boolean): OidcConfig {
  const names = listEnv(env, "YAP_OIDC_PROVIDERS").map((n) => n.toLowerCase());
  const grantMaxDays = intEnv(env, "YAP_OIDC_GRANT_MAX_DAYS", 30, MAX_GRANT_DAYS);
  if (names.length > 0 && !baseUrlSet) {
    throw new ConfigError(
      "YAP_OIDC_PROVIDERS needs YAP_BASE_URL: the provider callback URL is built from it, never from the request",
    );
  }
  const providers: OidcProviderConfig[] = [];
  for (const name of names) {
    if (!OIDC_NAME.test(name)) {
      throw new ConfigError(`YAP_OIDC_PROVIDERS: ${JSON.stringify(name)} is not a valid name (a-z, 0-9, _; starting with a letter)`);
    }
    if (providers.some((p) => p.name === name)) throw new ConfigError(`YAP_OIDC_PROVIDERS names ${name} twice`);
    const prefix = `YAP_OIDC_${name.toUpperCase()}_`;
    // Kept exactly as given: it must equal the issuer the provider states in
    // its discovery document and its ID tokens (some end with a slash).
    const issuer = env[`${prefix}ISSUER`] ?? "";
    const clientId = env[`${prefix}CLIENT_ID`] ?? "";
    const clientSecret = env[`${prefix}CLIENT_SECRET`] ?? "";
    if (!issuer || !clientId || !clientSecret) {
      throw new ConfigError(`provider ${name} needs ${prefix}ISSUER, ${prefix}CLIENT_ID and ${prefix}CLIENT_SECRET`);
    }
    if (!isSecureOrLoopback(issuer)) {
      throw new ConfigError(`${prefix}ISSUER must be an https URL (http only on a loopback host), got ${JSON.stringify(issuer)}`);
    }
    providers.push({
      name,
      issuer,
      clientId,
      clientSecret,
      label: env[`${prefix}LABEL`] || name.charAt(0).toUpperCase() + name.slice(1),
      grantMaxDays: intEnv(env, `${prefix}GRANT_MAX_DAYS`, grantMaxDays, MAX_GRANT_DAYS),
    });
  }
  const signupRaw = env.YAP_OIDC_SIGNUP || "false";
  if (signupRaw !== "true" && signupRaw !== "false") {
    throw new ConfigError(`YAP_OIDC_SIGNUP must be "true" or "false", got ${JSON.stringify(signupRaw)}`);
  }
  const allow = listEnv(env, "YAP_OIDC_ALLOW").map((entry) => entry.toLowerCase());
  for (const entry of allow) {
    const at = entry.indexOf("@");
    if (at < 0 || entry.indexOf("@", at + 1) >= 0 || at === entry.length - 1) {
      throw new ConfigError(`YAP_OIDC_ALLOW: ${JSON.stringify(entry)} is neither an address nor an @domain`);
    }
  }
  return { providers, signup: signupRaw === "true", allow };
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

  const backupSinkDriver = env.YAP_BACKUP_SINK || "fs";
  let backupSink: BackupConfig["sink"];
  if (backupSinkDriver === "fs") {
    backupSink = { driver: "fs", root: env.YAP_BACKUP_FS_ROOT || "./data/backups" };
  } else if (backupSinkDriver === "s3") {
    const bucket = env.YAP_BACKUP_S3_BUCKET;
    const accessKeyId = env.YAP_BACKUP_S3_ACCESS_KEY_ID || env.YAP_S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID;
    const secretAccessKey =
      env.YAP_BACKUP_S3_SECRET_ACCESS_KEY || env.YAP_S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY;
    if (!bucket || !accessKeyId || !secretAccessKey) {
      throw new ConfigError(
        "YAP_BACKUP_SINK=s3 requires YAP_BACKUP_S3_BUCKET and credentials (YAP_BACKUP_S3_* or YAP_S3_*/AWS_*)",
      );
    }
    backupSink = {
      driver: "s3",
      bucket,
      region: env.YAP_BACKUP_S3_REGION || env.YAP_S3_REGION || "auto",
      endpoint: env.YAP_BACKUP_S3_ENDPOINT || env.YAP_S3_ENDPOINT,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: (env.YAP_BACKUP_S3_FORCE_PATH_STYLE ?? env.YAP_S3_FORCE_PATH_STYLE) === "true",
      prefix: env.YAP_BACKUP_S3_PREFIX || "",
    };
  } else {
    throw new ConfigError(`YAP_BACKUP_SINK must be "fs" or "s3", got ${JSON.stringify(backupSinkDriver)}`);
  }

  const backup: BackupConfig = {
    sink: backupSink,
    beforeMigrate: env.YAP_BACKUP_BEFORE_MIGRATE !== "false",
    schedule: env.YAP_BACKUP_SCHEDULE || undefined,
    keep: env.YAP_BACKUP_KEEP ? intEnv(env, "YAP_BACKUP_KEEP", 0) : undefined,
  };

  const schedulerRaw = env.YAP_SCHEDULER || "on";
  if (schedulerRaw !== "on" && schedulerRaw !== "off") {
    throw new ConfigError(`YAP_SCHEDULER must be "on" or "off", got ${JSON.stringify(schedulerRaw)}`);
  }

  const maxRoleRaw = env.YAP_OAUTH_MAX_ROLE || undefined;
  if (maxRoleRaw !== undefined && maxRoleRaw !== "admin" && maxRoleRaw !== "member" && maxRoleRaw !== "read-only") {
    throw new ConfigError(`YAP_OAUTH_MAX_ROLE must be "admin", "member" or "read-only", got ${JSON.stringify(maxRoleRaw)}`);
  }
  const oidc = loadOidc(env, Boolean(env.YAP_BASE_URL));
  const keyLogin = env.YAP_KEY_LOGIN !== "false";
  if (!keyLogin && oidc.providers.length === 0) {
    throw new ConfigError(
      "YAP_KEY_LOGIN=false needs a login provider (YAP_OIDC_PROVIDERS): without one nobody could log in",
    );
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
    backup,
    uploadTtlSeconds: intEnv(env, "YAP_UPLOAD_TTL_SECONDS", 600),
    downloadTtlSeconds: intEnv(env, "YAP_DOWNLOAD_TTL_SECONDS", 14400),
    widgetTokenTtlSeconds: intEnv(env, "YAP_WIDGET_TOKEN_TTL_SECONDS", 600),
    secretRequestTtlSeconds: intEnv(env, "YAP_SECRET_REQUEST_TTL_SECONDS", 600),
    oauthAccessTokenTtlSeconds: intEnv(env, "YAP_OAUTH_ACCESS_TOKEN_TTL_SECONDS", 3600),
    oauthRefreshTokenTtlSeconds: intEnv(env, "YAP_OAUTH_REFRESH_TOKEN_TTL_SECONDS", 30 * 24 * 3600),
    oauthCodeTtlSeconds: intEnv(env, "YAP_OAUTH_CODE_TTL_SECONDS", 60),
    oauthMaxRole: maxRoleRaw,
    oidc,
    keyLogin,
    maxFileSizeBytes: intEnv(env, "YAP_MAX_FILE_SIZE_BYTES", 50 * 1024 * 1024),
    mimeAllowlist,
    sideloadEnabled: env.YAP_SIDELOAD_ENABLED !== "false",
    sideloadTimeoutMs: intEnv(env, "YAP_SIDELOAD_TIMEOUT_MS", 60_000, MAX_TIMER_MS),
    // The settings that become timer delays are bounded by MAX_TIMER_MS: above
    // it a value wraps and fires immediately instead of waiting. hookTimeoutMs
    // is bounded 500ms tighter because the legacy fire paths wait
    // hookTimeoutMs + 500; at exactly MAX_TIMER_MS that addition itself
    // overflows Node's 32-bit timer and clamps to 1ms.
    hookTimeoutMs: intEnv(env, "YAP_HOOK_TIMEOUT_MS", 30_000, MAX_TIMER_MS - 500),
    egressAllowHosts: listEnv(env, "YAP_HOOK_ALLOW_HOSTS"),
    runWaitCapMs: intEnv(env, "YAP_RUN_WAIT_CAP_MS", DEFAULT_RUN_WAIT_CAP_MS, MAX_TIMER_MS),
    runTimeoutCapMs: optionalIntEnv(env, "YAP_RUN_TIMEOUT_CAP_MS", MAX_TIMER_MS),
    runRetentionDays: intEnv(env, "YAP_RUN_RETENTION_DAYS", 7),
    orphanSweepIntervalMs: intEnv(env, "YAP_ORPHAN_SWEEP_INTERVAL_MS", 10 * 60 * 1000, MAX_TIMER_MS),
    orphanMaxAgeMs: intEnv(env, "YAP_ORPHAN_MAX_AGE_MS", 60 * 60 * 1000),
    driversDir: env.YAP_DRIVERS_DIR || "./drivers",
    schedulerEnabled: schedulerRaw === "on",
  };
}
