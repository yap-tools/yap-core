/**
 * Boots a full Yap server (MCP + REST on one port) against a fresh database
 * for integration tests.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBlobStore, type BlobStore } from "../../src/blob/index.js";
import { loadConfig, type YapConfig } from "../../src/config.js";
import { loadExternalDrivers } from "../../src/core/drivers/load.js";
import { createDb, type Db } from "../../src/db/index.js";
import { createLogger, type YapLogger } from "../../src/logger.js";
import { getFreeLoopbackPort } from "../../src/rest/edge.js";
import { buildServer, createDriverRegistry, type YapServer } from "../../src/server.js";

export const TEST_SYSADMIN_KEY = "test-sysadmin-key-0123456789abcdef";

export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    YAP_SYSADMIN_KEY: TEST_SYSADMIN_KEY,
    YAP_MASTER_KEY: randomBytes(32).toString("base64"),
    YAP_SQLITE_PATH: ":memory:",
    YAP_BLOB_FS_ROOT: mkdtempSync(join(tmpdir(), "yap-blobs-")),
    ...overrides,
  };
}

/** Re-exported from src so the allocator has a single implementation. */
export const getFreePort = getFreeLoopbackPort;

export interface TestApp {
  server: YapServer;
  config: YapConfig;
  db: Db;
  blob: BlobStore;
  /** The logger the whole server (REST env, MCP env, runs layer) writes to —
   *  pass one in to capture what a test's operator-side output would say. */
  logger: YapLogger;
  baseUrl: string;
  stop(): Promise<void>;
}

export async function bootTestApp(
  envOverrides: Record<string, string> = {},
  db?: Db,
  logger?: YapLogger,
): Promise<TestApp> {
  const port = await getFreePort();
  const config = loadConfig(
    testEnv({
      YAP_PORT: String(port),
      YAP_HOST: "127.0.0.1",
      YAP_BASE_URL: `http://127.0.0.1:${port}`,
      ...envOverrides,
    }),
  );
  const database = db ?? (await createDb(config.db));
  if (!db) await database.migrate();
  const blob = await createBlobStore(config);
  const quiet =
    logger ?? createLogger({ debug() {}, info() {}, log() {}, warn() {}, error: console.error.bind(console) });
  // Mirrors serve.ts: the operator's drivers are loaded into the registry
  // before the server is built, so tests exercise the real loader.
  const registry = createDriverRegistry(config);
  await loadExternalDrivers(config.driversDir, registry, quiet);
  const server = buildServer(config, database, blob, quiet, registry);
  await server.start();
  return {
    server,
    config,
    db: database,
    blob,
    logger: quiet,
    baseUrl: config.baseUrl,
    stop: async () => {
      await server.stop();
      await database.close();
    },
  };
}
