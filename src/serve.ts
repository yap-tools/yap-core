import { createRequire } from "node:module";

import { maybePreMigrationBackup, startBackupScheduler } from "./backup/auto.js";
import { createBackupSink } from "./backup/sink.js";
import { createBlobStore } from "./blob/index.js";
import { resolveEnvFile } from "./cli/env.js";
import { ConfigError, loadConfig, type YapConfig } from "./config.js";
import { sweepOrphans } from "./core/files.js";
import { createDb } from "./db/index.js";
import { createLogger } from "./logger.js";
import { buildServer } from "./server.js";

// Resolves from src/ (tsx) and dist/ (built) alike — both sit one level below
// the package root.
const yapVersion = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export async function serve(): Promise<void> {
  // Load an env file before reading config, if one exists: explicit
  // YAP_ENV_FILE, else the instance directory's ./.env (from `yap init` or a
  // checkout). Uses Node's built-in parser — no dependency. Real environment
  // variables already set take precedence over .env entries, so injected
  // secrets in a deployment always win over a file on disk.
  const envFile = resolveEnvFile();
  if (envFile) process.loadEnvFile(envFile);

  const logger = createLogger();
  let config: YapConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`yap: ${err.message}`);
      console.error("Run `yap init` in this directory to scaffold an instance, or set the variable in the environment.");
      process.exit(1);
    }
    throw err;
  }
  const db = await createDb(config.db);
  const blob = await createBlobStore(config);

  if (config.backup.beforeMigrate) {
    const sink = await createBackupSink(config.backup.sink);
    try {
      const name = await maybePreMigrationBackup({ db, blob, sink, yapVersion });
      if (name) logger.info(`pre-migration backup written: ${name} → ${sink.describe()}`);
    } catch (err) {
      // The safety promise: never migrate data that could not be backed up.
      logger.error(
        "pre-migration backup failed — refusing to migrate; set YAP_BACKUP_BEFORE_MIGRATE=false to override",
        err,
      );
      await db.close();
      process.exit(1);
    }
  }
  await db.migrate();

  // Minted upload/download/widget links are absolute and built from baseUrl.
  // If the server binds publicly but baseUrl still defaults to localhost, those
  // links point a remote client at its own machine — warn loudly.
  const boundPublic = config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1";
  if (!process.env.YAP_BASE_URL && boundPublic) {
    logger.warn(
      `YAP_BASE_URL is unset while binding to ${config.host}; minted file/widget links will use ${config.baseUrl} ` +
        `and will not work for remote clients. Set YAP_BASE_URL to this server's externally reachable origin.`,
    );
  }

  // baseUrl doubles as the OAuth issuer identity. OAuth 2.1 requires TLS except
  // on loopback, so a plain-http issuer on a reachable host means remote OAuth
  // clients (Claude included) will refuse or leak the flow. Warn, don't refuse —
  // LAN and tunnel setups are legitimate during bring-up.
  const issuer = new URL(config.baseUrl);
  if (issuer.protocol === "http:" && !["127.0.0.1", "[::1]", "::1", "localhost"].includes(issuer.hostname)) {
    logger.warn(
      `YAP_BASE_URL (${config.baseUrl}) is plain http on a non-loopback host; OAuth requires https for remote ` +
        `clients. Put a TLS-terminating proxy in front and set YAP_BASE_URL to its https origin.`,
    );
  }

  const server = buildServer(config, db, blob, logger);
  await server.start();
  logger.info(`yap listening on ${config.baseUrl} (REST under /v1, MCP at /mcp)`);

  const sweeper = setInterval(() => {
    sweepOrphans({ db, blob, config }, config.orphanMaxAgeMs).catch((err) =>
      logger.error("orphan sweep failed", err),
    );
  }, config.orphanSweepIntervalMs);
  sweeper.unref();

  let stopScheduler: (() => void) | undefined;
  if (config.backup.schedule) {
    const sink = await createBackupSink(config.backup.sink);
    stopScheduler = startBackupScheduler({ db, blob, sink, yapVersion }, config.backup.schedule, config.backup.keep, logger);
    logger.info(
      `backup scheduler active (${config.backup.schedule}, keep ${config.backup.keep ?? "all"}) → ${sink.describe()}`,
    );
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      clearInterval(sweeper);
      stopScheduler?.();
      await server.stop();
      await db.close();
      process.exit(0);
    });
  }
}
