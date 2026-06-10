import { loadConfig } from "./config.js";
import { createDb } from "./db/index.js";
import { createLogger } from "./logger.js";
import { buildServer } from "./server.js";

const logger = createLogger();
const config = loadConfig();
const db = await createDb(config.db);
await db.migrate();

const server = buildServer(config, db, logger);
await server.start();
logger.info(`yap listening on ${config.baseUrl} (REST under /v1, MCP at /mcp)`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await server.stop();
    await db.close();
    process.exit(0);
  });
}
