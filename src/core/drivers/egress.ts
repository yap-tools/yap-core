/**
 * Guarded egress: the only sanctioned way a driver reaches the network.
 *
 * Drivers are operator-installed code that runs in-process, so the server
 * cannot stop a determined driver from opening its own socket — but every
 * driver Yap ships, and every driver written against this contract, goes
 * through here, which means one place enforces the SSRF policy for all of
 * them (the same policy hooks use; see ssrf.ts).
 *
 * Both doors apply the guard twice, for different windows:
 *
 * - `fetch` pre-flights `assertPublicDestination` (fast rejection, and the
 *   only check that covers IP-literal destinations, for which undici never
 *   invokes the pinning lookup), then dispatches through an undici Agent
 *   whose `connect.lookup` re-validates the exact address the socket uses.
 *   That closes the DNS-rebinding window between check and connect.
 *   Redirects are `manual` — a 302 could otherwise bounce to a private host.
 * - `connect` resolves the host itself, validates every returned address, and
 *   then connects to a *validated address* rather than the hostname, so no
 *   second, unvalidated resolution happens inside `net`/`tls`. The original
 *   hostname is still passed as `servername` so TLS SNI and certificate
 *   validation are unaffected — except when the target is an IP literal, where
 *   SNI is not permitted (RFC 6066) and the certificate is instead checked
 *   against the IP, which is the correct identity in that case.
 *
 * Both doors are also bounded. `connect` takes a timeout (default 30s) and an
 * optional AbortSignal, and every failure path destroys the socket exactly
 * once, so a driver cannot strand a half-open connection. The undici Agent is
 * created lazily, at most once per handle, and released by `dispose()` — which
 * the caller that built the handle MUST call in a `finally`, or the connection
 * pool outlives the invocation (the same leak `hooks.ts` avoids by destroying
 * its per-fire agent).
 *
 * Errors surface raw: this layer names the host and the blocked address,
 * which is what an operator needs. Callers that expose failures to an agent
 * (the http driver, the service runner) are responsible for collapsing them
 * into a generic policy error so a hidden destination cannot leak.
 */
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";

import { Agent, fetch as undiciFetch } from "undici";

import type { YapConfig } from "../../config.js";
import { invalid } from "../errors.js";
import {
  assertPublicDestination,
  blockedAddresses,
  createPinningLookup,
  defaultResolver,
  SSRF_PIN_ERROR_CODE,
  type Resolver,
} from "../ssrf.js";

export interface EgressResponse {
  status: number;
  text(): Promise<string>;
}

export interface EgressFetchInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  redirect?: "manual";
}

export interface EgressConnectOptions {
  tls?: boolean;
  /** SNI/certificate name; defaults to the hostname, omitted for IP literals. */
  servername?: string;
  /** Aborts a connect still in flight; rejects with an `AbortError`. */
  signal?: AbortSignal;
  /** Connect budget in ms; defaults to 30000. */
  timeoutMs?: number;
}

export interface Egress {
  fetch(url: string, init: EgressFetchInit): Promise<EgressResponse>;
  connect(host: string, port: number, opts?: EgressConnectOptions): Promise<Duplex>;
  assertPublic(url: string): Promise<void>;
  /** Releases the connection pool this handle may have opened. Idempotent, and
   * a no-op when no fetch ever happened; using the handle afterwards throws. */
  dispose(): Promise<void>;
}

/** Default wall-clock budget for establishing one connection. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

function pinError(message: string): Error {
  return Object.assign(new Error(message), { code: SSRF_PIN_ERROR_CODE });
}

/** Shaped like the DOM/undici abort rejection so callers can branch on `name`. */
function abortError(message: string): Error {
  return Object.assign(new Error(message), { name: "AbortError", code: "ABORT_ERR" });
}

function timeoutError(message: string): Error {
  return Object.assign(new Error(message), { code: "ETIMEDOUT" });
}

/**
 * Builds the egress handle for one driver invocation (or authoring-time
 * validation). `resolver` and `fetchImpl` are injectable for tests, mirroring
 * HookEnv; when a fetch is injected the undici pinning dispatcher is skipped
 * (the injected implementation does its own transport), so the pre-flight
 * guard is the check that runs.
 *
 * The handle owns a connection pool once anything fetches through it, so the
 * builder is responsible for calling `dispose()` when the invocation ends.
 */
export function createEgress(config: YapConfig, resolver?: Resolver, fetchImpl?: typeof fetch): Egress {
  const allowHosts = config.hookAllowHosts;
  // One resolved value for all three members: a default that lives in only one
  // place cannot drift between the pre-flight check and the connect check.
  const resolve = resolver ?? defaultResolver;
  let pinningAgent: Agent | undefined;
  let disposed = false;

  function assertUsable(): void {
    if (disposed) throw new Error("egress handle has been disposed");
  }

  return {
    async assertPublic(url: string): Promise<void> {
      assertUsable();
      await assertPublicDestination(url, allowHosts, resolve);
    },

    async fetch(url: string, init: EgressFetchInit): Promise<EgressResponse> {
      assertUsable();
      await assertPublicDestination(url, allowHosts, resolve);
      const request = {
        method: init.method,
        ...(init.headers ? { headers: init.headers } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
        redirect: init.redirect ?? ("manual" as const),
      };
      if (fetchImpl) return await fetchImpl(url, request);
      // One pinning dispatcher per handle (an egress handle is scoped to a
      // single driver invocation), created lazily so a driver that never
      // fetches never opens a pool, and destroyed by dispose().
      pinningAgent ??= new Agent({ connect: { lookup: createPinningLookup(allowHosts) } });
      return await undiciFetch(url, { ...request, dispatcher: pinningAgent });
    },

    async connect(host: string, port: number, opts?: EgressConnectOptions): Promise<Duplex> {
      assertUsable();
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw invalid(`egress connect port must be an integer between 1 and 65535, got ${JSON.stringify(port)}`);
      }
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw invalid(`egress connect timeoutMs must be a positive integer, got ${JSON.stringify(timeoutMs)}`);
      }
      const signal = opts?.signal;
      if (signal?.aborted) throw abortError(`connection to ${host}:${port} was aborted`);

      const hostname = host.replace(/^\[|\]$/g, ""); // strip ipv6 brackets
      const isIpLiteral = net.isIP(hostname) !== 0;
      let addresses: string[];
      if (isIpLiteral) {
        addresses = [hostname];
      } else {
        try {
          addresses = await resolve(hostname);
        } catch {
          throw new Error(`${hostname} could not be resolved`);
        }
        if (addresses.length === 0) throw new Error(`${hostname} could not be resolved`);
      }
      const blocked = blockedAddresses(hostname, addresses, allowHosts);
      if (blocked.length > 0) {
        throw pinError(`SSRF guard blocked ${hostname} → ${blocked.join(", ")}`);
      }
      // Connect to a validated address, never to the name: re-resolving inside
      // net/tls would reopen the rebinding window we just closed. `servername`
      // keeps SNI/certificate validation pinned to the real hostname; for an IP
      // literal it is omitted, since SNI must not carry an IP (RFC 6066) and
      // the certificate is then matched against the address itself.
      const address = addresses[0]!;
      const servername = opts?.servername ?? (isIpLiteral ? undefined : hostname);
      const readyEvent = opts?.tls ? "secureConnect" : "connect";
      return await new Promise<Duplex>((resolvePromise, reject) => {
        const socket = opts?.tls
          ? tls.connect({ host: address, port, ...(servername !== undefined ? { servername } : {}) })
          : net.connect({ host: address, port });
        let settled = false;
        const cleanup = (): void => {
          // Detach everything before settling: a late `error` (or a connect
          // that lands after the timeout) must not fire a second time.
          socket.setTimeout(0);
          socket.removeListener("error", onError);
          socket.removeListener("timeout", onTimeout);
          socket.removeListener(readyEvent, onReady);
          signal?.removeEventListener("abort", onAbort);
        };
        const fail = (err: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          socket.destroy(); // exactly once: every failure path routes through here
          reject(err);
        };
        const onError = (err: Error): void => fail(err);
        const onTimeout = (): void =>
          fail(timeoutError(`connection to ${hostname}:${port} timed out after ${timeoutMs}ms`));
        const onAbort = (): void => fail(abortError(`connection to ${hostname}:${port} was aborted`));
        const onReady = (): void => {
          if (settled) return;
          settled = true;
          cleanup(); // clears the connect timeout; the socket is the caller's now
          resolvePromise(socket);
        };
        socket.setTimeout(timeoutMs);
        socket.once("timeout", onTimeout);
        socket.once("error", onError);
        socket.once(readyEvent, onReady);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },

    async dispose(): Promise<void> {
      disposed = true;
      const agent = pinningAgent;
      pinningAgent = undefined; // idempotent: a second dispose finds nothing
      if (agent) await agent.destroy();
    },
  };
}
