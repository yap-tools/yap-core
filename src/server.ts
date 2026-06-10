/**
 * Single-process server: the MCP surface and the REST API served by one
 * fastmcp instance (REST rides on fastmcp's internal Hono app). Both surfaces
 * are thin transports over the core domain library — no logic lives here.
 */
import { FastMCP } from "fastmcp";

import type { YapConfig } from "./config.js";
import type { Db } from "./db/index.js";
import { createLogger, type YapLogger } from "./logger.js";

/** MCP session auth payload: identity only — permissions come from grants. */
export interface SessionAuth extends Record<string, unknown> {
  userId: string;
}

export interface YapServer {
  mcp: FastMCP<SessionAuth>;
  config: YapConfig;
  db: Db;
  logger: YapLogger;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function buildServer(config: YapConfig, db: Db, logger: YapLogger = createLogger()): YapServer {
  const mcp = new FastMCP<SessionAuth>({
    name: "yap",
    version: "0.1.0",
    instructions:
      "Yap serves navigable context. Discover with load → load_space → load_bundle, then execute with call.",
    logger,
    health: { enabled: true, path: "/health", message: "ok" },
    ping: { enabled: false },
    roots: { enabled: false },
  });

  return {
    mcp,
    config,
    db,
    logger,
    start: async () => {
      await mcp.start({
        transportType: "httpStream",
        httpStream: { port: config.port, host: config.host, stateless: true },
      });
    },
    stop: async () => {
      await mcp.stop();
    },
  };
}
