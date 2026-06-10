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
