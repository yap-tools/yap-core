/**
 * Boots a full Yap server (MCP + REST on one port) against a fresh database
 * for integration tests.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBlobStore, type BlobStore } from "../../src/blob/index.js";
import { loadConfig, type YapConfig } from "../../src/config.js";
import { createDb, type Db } from "../../src/db/index.js";
import { createLogger } from "../../src/logger.js";
import { buildServer, type YapServer } from "../../src/server.js";

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

export async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not allocate port"));
        return;
      }
      const port = address.port;
      srv.close(() => resolvePort(port));
    });
    srv.on("error", reject);
  });
}

export interface TestApp {
  server: YapServer;
  config: YapConfig;
  db: Db;
  blob: BlobStore;
  baseUrl: string;
  stop(): Promise<void>;
}

export async function bootTestApp(envOverrides: Record<string, string> = {}, db?: Db): Promise<TestApp> {
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
  const quiet = createLogger({ debug() {}, info() {}, log() {}, warn() {}, error: console.error.bind(console) });
  const server = buildServer(config, database, blob, quiet);
  await server.start();
  return {
    server,
    config,
    db: database,
    blob,
    baseUrl: config.baseUrl,
    stop: async () => {
      await server.stop();
      await database.close();
    },
  };
}
