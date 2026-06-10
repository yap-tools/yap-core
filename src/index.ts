import { createBlobStore } from "./blob/index.js";
import { loadConfig } from "./config.js";
import { sweepOrphans } from "./core/files.js";
import { createDb } from "./db/index.js";
import { createLogger } from "./logger.js";
import { buildServer } from "./server.js";

const logger = createLogger();
const config = loadConfig();
const db = await createDb(config.db);
await db.migrate();
const blob = await createBlobStore(config);

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

const server = buildServer(config, db, blob, logger);
await server.start();
logger.info(`yap listening on ${config.baseUrl} (REST under /v1, MCP at /mcp)`);

const sweeper = setInterval(() => {
  sweepOrphans({ db, blob, config }, config.orphanMaxAgeMs).catch((err) =>
    logger.error("orphan sweep failed", err),
  );
}, config.orphanSweepIntervalMs);
sweeper.unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    clearInterval(sweeper);
    await server.stop();
    await db.close();
    process.exit(0);
  });
}
