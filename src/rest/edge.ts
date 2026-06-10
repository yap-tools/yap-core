/**
 * The HTTP edge: a thin CORS-correct reverse proxy that fronts fastmcp's
 * listener.
 *
 * Why this exists: fastmcp's transport (mcp-proxy) answers every CORS
 * preflight itself with a bare 204 and no usable headers, and its CORS code
 * crashes on `Origin: null` — which is exactly what a sandboxed widget iframe
 * sends. So a rendered upload widget cannot PUT its bytes cross-origin. None of
 * that is reachable or configurable from inside the Hono app, because mcp-proxy
 * sits in front of it. We therefore own the edge: fastmcp binds a loopback
 * port, and this listener takes the public port, answers preflights, tags every
 * response with permissive CORS, and forwards the rest to fastmcp.
 *
 * Permissive `*` is safe here: every surface is authenticated by a bearer key
 * or a signed URL token, never by cookies, so CORS grants a browser nothing it
 * couldn't already do with the credential in hand.
 */
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";

/** Allocates an OS-assigned free port on loopback (probe-and-close). */
export async function getFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not allocate a loopback port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

const ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const DEFAULT_ALLOW_HEADERS = "Content-Type, Authorization, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-Id";

/** Hop-by-hop headers must not be forwarded verbatim; Node manages framing. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization", "proxy-authenticate"]);

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", ALLOW_METHODS);
  const requested = req.headers["access-control-request-headers"];
  res.setHeader("access-control-allow-headers", (Array.isArray(requested) ? requested.join(", ") : requested) || DEFAULT_ALLOW_HEADERS);
  res.setHeader("access-control-expose-headers", "Mcp-Session-Id");
  res.setHeader("access-control-max-age", "600");
}

export interface EdgeOptions {
  targetHost: string;
  targetPort: number;
  onError?: (err: Error) => void;
}

/** Builds the edge reverse-proxy server (call `.listen(port, host)` to start). */
export function createEdgeServer(opts: EdgeOptions): Server {
  const server = createHttpServer((req, res) => {
    applyCors(req, res);
    if (req.method === "OPTIONS") {
      // Answer the preflight ourselves — fastmcp would, but without headers.
      res.writeHead(204);
      res.end();
      return;
    }

    const headers = { ...req.headers };
    // CORS is handled at this edge; drop Origin so mcp-proxy never tries (and
    // fails) to parse a null origin downstream.
    delete headers.origin;
    delete headers["access-control-request-method"];
    delete headers["access-control-request-headers"];
    headers.host = `${opts.targetHost}:${opts.targetPort}`;

    const upstream = httpRequest(
      { host: opts.targetHost, port: opts.targetPort, method: req.method, path: req.url, headers },
      (proxyRes) => {
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (value === undefined) continue;
          if (HOP_BY_HOP.has(key.toLowerCase())) continue;
          if (key.toLowerCase().startsWith("access-control-")) continue; // ours win
          res.setHeader(key, value);
        }
        applyCors(req, res);
        res.writeHead(proxyRes.statusCode ?? 502);
        proxyRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      opts.onError?.(err);
      if (!res.headersSent) {
        applyCors(req, res);
        res.writeHead(502, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: { code: "bad_gateway", message: "upstream unavailable" } }));
    });
    req.pipe(upstream);
  });
  // MCP streams over long-lived responses (SSE); the default 5-minute request
  // timeout would sever them.
  server.requestTimeout = 0;
  return server;
}
