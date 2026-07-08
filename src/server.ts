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
import { createRequire } from "node:module";

import { FastMCP } from "fastmcp";

import type { BlobStore } from "./blob/index.js";
import type { YapConfig } from "./config.js";
import type { TokenAuth } from "./core/authScope.js";
import { bearerToken, resolveCredential } from "./core/credential.js";
import type { Db } from "./db/index.js";
import { createLogger, type YapLogger } from "./logger.js";
import { registerMcpTools } from "./mcp/tools.js";
import { createEdgeServer, getFreeLoopbackPort } from "./rest/edge.js";
import { registerOAuthRoutes } from "./rest/oauth.js";
import { registerRestRoutes } from "./rest/routes.js";

/** The running server's version, the single source of truth for the MCP
 * handshake's serverInfo and whoami. Read from package.json so a version bump
 * is the only edit — `../package.json` resolves the same from src/ and dist/. */
const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

/** MCP session auth payload: identity (plus, on the OAuth lane, the token's
 * delegation) — permissions always come from grants. */
export interface SessionAuth extends Record<string, unknown> {
  userId: string;
  /** Present on token-authenticated sessions; tools run inside its scope. */
  tokenAuth?: TokenAuth;
}

export interface YapServer {
  mcp: FastMCP<SessionAuth>;
  config: YapConfig;
  db: Db;
  blob: BlobStore;
  logger: YapLogger;
  /** Package version, surfaced in the MCP handshake and whoami. */
  version: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * MCP authentication, both credential lanes: a bearer access key (with a
 * ?key= query fallback for URL-only clients) or an OAuth access token. 401s
 * carry the RFC 9728 resource-metadata pointer — that header is what lets a
 * compliant MCP client discover the authorize flow with no manual config.
 * The sysadmin key never authenticates MCP.
 */
async function authenticateMcp(
  request: { headers: Record<string, string | string[] | undefined>; url?: string },
  db: Db,
  config: YapConfig,
): Promise<SessionAuth> {
  const deny = (message: string): never => {
    throw new Response(JSON.stringify({ error: { code: "unauthorized", message } }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource/mcp"`,
      },
    });
  };

  const header = request.headers["authorization"];
  let key = bearerToken(Array.isArray(header) ? header[0] : header);
  if (!key && request.url) {
    const url = new URL(request.url, "http://internal");
    key = url.searchParams.get("key");
  }

  const auth = await resolveCredential(db, config, key);
  switch (auth.kind) {
    case "user":
      return { userId: auth.userId };
    case "token":
      return { userId: auth.userId, tokenAuth: auth.tokenAuth };
    case "missing":
      return deny("access key or access token required (Authorization: Bearer or ?key= fallback)");
    case "sysadmin":
      return deny("the sysadmin key cannot be used over MCP");
    case "invalid-token":
      return deny("invalid, expired, or revoked access token");
    case "invalid-key":
      return deny("invalid or revoked access key");
  }
}

export function buildServer(config: YapConfig, db: Db, blob: BlobStore, logger: YapLogger = createLogger()): YapServer {
  const mcp = new FastMCP<SessionAuth>({
    name: "yap",
    // fastmcp types version as a semver template literal; ours is a plain string.
    version: VERSION as `${number}.${number}.${number}`,
    instructions: `Yap serves navigable context: spaces hold bundles; a bundle holds docs, item-types (schemas with items), files, and hooks.

Engage Yap whenever a request involves its spaces, stored items, files, or hooks, or names a space or bundle. Discovery is progressive — follow this order:
1. load — the spaces you can reach (with bundle names), your autoloading user docs, and a lightweight second-tier tool manifest.
2. load_space(space_id) — the space's operator instructions and bundle descriptions.
3. load_bundle(bundle_ids) — REQUIRED before call: binding docs, item-type schemas, files, hooks.
4. get_tools(names?) — when full second-tier descriptions or parameter specs are needed, expand the manifest by name; omit names to fetch the manifest directly.
5. call(space_id, calls) — execute second-tier tools against bundles (or the space itself).

If several spaces or bundles could match the user's intent, ask the user rather than guessing. Run the discovery chain silently — do not narrate loading calls.

Stored references are opaque — resolve before showing them to a user: file://{uuid} via show_file (returns an expiring link), item://{uuid} via get_items. Never surface raw reference URIs, durable storage locations, or hook transports. When reporting results, refer to items by their item-type name (e.g. "3 Todos"), never as "items".`,
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
    version: VERSION,
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
  registerOAuthRoutes(server);
  registerMcpTools(server);

  return server;
}
