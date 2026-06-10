/**
 * Single-process server: the MCP surface and the REST API served by one
 * fastmcp instance (REST rides on fastmcp's internal Hono app). Both surfaces
 * are thin transports over the core domain library — no logic lives here.
 *
 * fastmcp binds a loopback port; a CORS-correct edge proxy (rest/edge.ts) takes
 * the public port and forwards to it. See edge.ts for why fastmcp can't front
 * browser traffic directly (its transport mishandles CORS preflights).
 */
import type { Server as HttpServer } from "node:http";

import { FastMCP } from "fastmcp";

import type { BlobStore } from "./blob/index.js";
import type { YapConfig } from "./config.js";
import { constantTimeEqual } from "./crypto.js";
import { authenticateKey } from "./core/keys.js";
import type { Db } from "./db/index.js";
import { createLogger, type YapLogger } from "./logger.js";
import { registerMcpTools } from "./mcp/tools.js";
import { createEdgeServer, getFreeLoopbackPort } from "./rest/edge.js";
import { registerRestRoutes } from "./rest/routes.js";

/** MCP session auth payload: identity only — permissions come from grants. */
export interface SessionAuth extends Record<string, unknown> {
  userId: string;
}

export interface YapServer {
  mcp: FastMCP<SessionAuth>;
  config: YapConfig;
  db: Db;
  blob: BlobStore;
  logger: YapLogger;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * MCP authentication: bearer access key preferred, with a ?key= query
 * fallback for URL-only clients. The sysadmin key never authenticates MCP.
 */
async function authenticateMcp(
  request: { headers: Record<string, string | string[] | undefined>; url?: string },
  db: Db,
  config: YapConfig,
): Promise<SessionAuth> {
  const deny = (message: string): never => {
    throw new Response(JSON.stringify({ error: { code: "unauthorized", message } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };

  let key: string | null = null;
  const header = request.headers["authorization"];
  const headerValue = Array.isArray(header) ? header[0] : header;
  if (headerValue) {
    const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
    if (match) key = match[1]!.trim();
  }
  if (!key && request.url) {
    const url = new URL(request.url, "http://internal");
    key = url.searchParams.get("key");
  }
  if (!key) return deny("access key required (Authorization: Bearer or ?key= fallback)");
  if (constantTimeEqual(key, config.sysadminKey)) {
    return deny("the sysadmin key cannot be used over MCP");
  }
  const userId = await authenticateKey(db, key);
  if (!userId) return deny("invalid or revoked access key");
  return { userId };
}

export function buildServer(config: YapConfig, db: Db, blob: BlobStore, logger: YapLogger = createLogger()): YapServer {
  const mcp = new FastMCP<SessionAuth>({
    name: "yap",
    version: "0.1.0",
    instructions:
      "Yap serves navigable context. Discover with load → load_space → load_bundle, then execute with call.",
    logger,
    authenticate: (request) => authenticateMcp(request, db, config),
    health: { enabled: true, path: "/health", message: "ok" },
    ping: { enabled: false },
    roots: { enabled: false },
  });

  let edge: HttpServer | undefined;

  const server: YapServer = {
    mcp,
    config,
    db,
    blob,
    logger,
    start: async () => {
      // fastmcp on loopback; the edge proxy owns the public port.
      const internalPort = await getFreeLoopbackPort();
      await mcp.start({
        transportType: "httpStream",
        httpStream: { port: internalPort, host: "127.0.0.1", stateless: true },
      });
      edge = createEdgeServer({
        targetHost: "127.0.0.1",
        targetPort: internalPort,
        onError: (err) => logger.error(`edge proxy upstream error: ${err.message}`),
      });
      await new Promise<void>((resolve, reject) => {
        edge!.once("error", reject);
        edge!.listen(config.port, config.host, () => {
          edge!.off("error", reject);
          resolve();
        });
      });
    },
    stop: async () => {
      if (edge) {
        await new Promise<void>((resolve) => edge!.close(() => resolve()));
        edge = undefined;
      }
      await mcp.stop();
    },
  };

  registerRestRoutes(server);
  registerMcpTools(server);

  return server;
}
