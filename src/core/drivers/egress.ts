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
 * optional AbortSignal, and both cover the *whole* flow — DNS resolution
 * included, not just the socket — so a slow or hanging resolver cannot make a
 * connect unbounded; every failure path destroys the socket exactly once, so a
 * driver cannot strand a half-open connection. The undici Agent is created
 * lazily, at most once per handle, and released by `dispose()` — which the
 * caller that built the handle MUST call in a `finally`, or the connection
 * pool outlives the invocation (the same leak `hooks.ts` avoids by destroying
 * its per-fire agent). `dispose()` releases only the fetch pool: a socket
 * already handed back by `connect()` belongs to the driver, which must close
 * it itself. Because a call can be parked on an `await` when `dispose()` lands,
 * the disposed flag is re-checked after every internal await that precedes
 * acquiring a resource — otherwise a disposed handle could still open a pool.
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
  /** Aborts a connect still in flight — DNS phase included; rejects with an
   * `AbortError`. */
  signal?: AbortSignal;
  /** Budget in ms for resolution *and* connect together; defaults to 30000. */
  timeoutMs?: number;
}

export interface Egress {
  fetch(url: string, init: EgressFetchInit): Promise<EgressResponse>;
  /** Resolves to a connected socket that is the *caller's* to close. */
  connect(host: string, port: number, opts?: EgressConnectOptions): Promise<Duplex>;
  assertPublic(url: string): Promise<void>;
  /** Releases the connection pool this handle may have opened. Idempotent, and
   * a no-op when no fetch ever happened; using the handle afterwards throws.
   * Sockets already returned by `connect()` are not touched — those belong to
   * the driver that asked for them. */
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

/** Renders a rejected argument for an error message. Numbers go through
 * `String` because `JSON.stringify(NaN)` is `"null"`, which would report the
 * wrong input; everything else keeps the quoting that distinguishes `"5000"`
 * from `5000`. */
function describeValue(value: unknown): string {
  if (typeof value === "number") return String(value);
  return JSON.stringify(value) ?? String(value);
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
      // The pre-flight awaited, so dispose() may have landed while this call
      // was parked: re-check before acquiring anything, or a disposed handle
      // would lazily open a pool nobody will ever destroy.
      assertUsable();
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
        throw invalid(`egress connect port must be an integer between 1 and 65535, got ${describeValue(port)}`);
      }
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw invalid(`egress connect timeoutMs must be a positive integer, got ${describeValue(timeoutMs)}`);
      }
      const signal = opts?.signal;
      if (signal?.aborted) throw abortError(`connection to ${host}:${port} was aborted`);

      const hostname = host.replace(/^\[|\]$/g, ""); // strip ipv6 brackets
      const isIpLiteral = net.isIP(hostname) !== 0;
      const readyEvent = opts?.tls ? "secureConnect" : "connect";
      // The whole flow — DNS resolution included — races the signal and one
      // overall deadline. Attaching the abort listener and arming the timer
      // before resolving is what makes the DNS phase bounded: a resolver that
      // never answers used to hang here forever, because the socket (and its
      // own timeout) only existed after resolution.
      return await new Promise<Duplex>((resolvePromise, reject) => {
        let settled = false;
        let socket: net.Socket | undefined;
        const detach = (): void => {
          signal?.removeEventListener("abort", onAbort);
          clearTimeout(deadline);
        };
        const fail = (err: Error): void => {
          if (settled) return;
          settled = true;
          detach();
          socket?.destroy(); // exactly once: every failure path routes through here
          reject(err);
        };
        const onAbort = (): void => fail(abortError(`connection to ${hostname}:${port} was aborted`));
        signal?.addEventListener("abort", onAbort, { once: true });
        const deadline = setTimeout(
          () => fail(timeoutError(`connection to ${hostname}:${port} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );

        void (async () => {
          try {
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
              // Resolution awaited: a late answer for an already-aborted or
              // timed-out connect is discarded, and a dispose() that landed
              // meanwhile must not still get a socket opened for it.
              if (settled) return;
              assertUsable();
            }
            const blocked = blockedAddresses(hostname, addresses, allowHosts);
            if (blocked.length > 0) {
              throw pinError(`SSRF guard blocked ${hostname} → ${blocked.join(", ")}`);
            }
            // Connect to a validated address, never to the name: re-resolving
            // inside net/tls would reopen the rebinding window we just closed.
            // `servername` keeps SNI/certificate validation pinned to the real
            // hostname; for an IP literal it is omitted, since SNI must not
            // carry an IP (RFC 6066) and the certificate is then matched
            // against the address itself.
            const address = addresses[0]!;
            const servername = opts?.servername ?? (isIpLiteral ? undefined : hostname);
            const opened = opts?.tls
              ? tls.connect({ host: address, port, ...(servername !== undefined ? { servername } : {}) })
              : net.connect({ host: address, port });
            if (settled) {
              opened.destroy(); // settled in the same tick: never strand it
              return;
            }
            socket = opened;
            const onError = (err: Error): void => fail(err);
            const onReady = (): void => {
              if (settled) return;
              settled = true;
              detach();
              opened.removeListener("error", onError);
              // The caller attaches its own handlers on the next tick at the
              // earliest; an `error` in that window would be unhandled and
              // take the process down, so leave an inert listener behind.
              opened.on("error", () => {});
              resolvePromise(opened);
            };
            opened.once("error", onError);
            opened.once(readyEvent, onReady);
          } catch (err) {
            fail(err as Error);
          }
        })();
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
