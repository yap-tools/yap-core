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
 *   validation are unaffected.
 *
 * Errors surface raw: this layer names the host and the blocked address,
 * which is what an operator needs. Callers that expose failures to an agent
 * (the http driver, the service runner) are responsible for collapsing them
 * into a generic policy error so a hidden destination cannot leak.
 */
import dns from "node:dns/promises";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";

import { Agent, fetch as undiciFetch } from "undici";

import type { YapConfig } from "../../config.js";
import {
  assertPublicDestination,
  blockedAddresses,
  createPinningLookup,
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

export interface Egress {
  fetch(url: string, init: EgressFetchInit): Promise<EgressResponse>;
  connect(host: string, port: number, opts?: { tls?: boolean; servername?: string }): Promise<Duplex>;
  assertPublic(url: string): Promise<void>;
}

const defaultResolver: Resolver = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

function pinError(message: string): Error {
  return Object.assign(new Error(message), { code: SSRF_PIN_ERROR_CODE });
}

/**
 * Builds the egress handle for one driver invocation (or authoring-time
 * validation). `resolver` and `fetchImpl` are injectable for tests, mirroring
 * HookEnv; when a fetch is injected the undici pinning dispatcher is skipped
 * (the injected implementation does its own transport), so the pre-flight
 * guard is the check that runs.
 */
export function createEgress(config: YapConfig, resolver?: Resolver, fetchImpl?: typeof fetch): Egress {
  const allowHosts = config.hookAllowHosts;
  const resolve = resolver ?? defaultResolver;
  let pinningAgent: Agent | undefined;

  return {
    async assertPublic(url: string): Promise<void> {
      await assertPublicDestination(url, allowHosts, resolver);
    },

    async fetch(url: string, init: EgressFetchInit): Promise<EgressResponse> {
      await assertPublicDestination(url, allowHosts, resolver);
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
      // fetches never opens a pool.
      pinningAgent ??= new Agent({ connect: { lookup: createPinningLookup(allowHosts) } });
      return await undiciFetch(url, { ...request, dispatcher: pinningAgent });
    },

    async connect(host: string, port: number, opts?: { tls?: boolean; servername?: string }): Promise<Duplex> {
      const hostname = host.replace(/^\[|\]$/g, ""); // strip ipv6 brackets
      let addresses: string[];
      if (net.isIP(hostname)) {
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
      // keeps SNI/certificate validation pinned to the real hostname.
      const address = addresses[0]!;
      const servername = opts?.servername ?? hostname;
      return await new Promise<Duplex>((resolvePromise, reject) => {
        const socket = opts?.tls
          ? tls.connect({ host: address, port, servername })
          : net.connect({ host: address, port });
        const onError = (err: Error): void => {
          socket.destroy();
          reject(err);
        };
        socket.once("error", onError);
        socket.once(opts?.tls ? "secureConnect" : "connect", () => {
          socket.removeListener("error", onError);
          resolvePromise(socket);
        });
      });
    },
  };
}
