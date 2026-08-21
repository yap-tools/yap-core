/**
 * A fake of the egress handle Yap injects into a driver (`ctx.egress`).
 *
 * The real one resolves the host, refuses private addresses, and connects to a
 * vetted IP. Tests talk to mock servers on the loopback interface — exactly
 * what the real handle refuses — so this one connects every host to 127.0.0.1
 * while keeping the shape the driver relies on: `tls` wraps the connection
 * from the first byte with `servername` for SNI, `signal` aborts a connect in
 * flight, `timeoutMs` bounds it, and the socket handed back is the caller's.
 *
 * `fetch` is a stub the test programs (`egress.fetchImpl = async (url, init)
 * => ...`); calls are recorded on `egress.fetchCalls` so a test can assert
 * what the driver posted without the stub having to.
 *
 * `trustMockCertificate()` installs the fixture certificate as a process-wide
 * trusted root (Node >= 22.15 via `tls.setDefaultCACertificates`), so the
 * driver's `rejectUnauthorized: true` path is exercised for real rather than
 * switched off. Tests that need it skip when the API is missing.
 */
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";

import type { Egress, EgressConnectOptions, EgressFetchInit, EgressResponse } from "../../../src/core/drivers/egress.js";
import type { TokenResponse } from "../../../src/core/drivers/mail/auth.js";
import type { DriverFailCode, RunContext } from "../../../src/core/drivers/types.js";
import { mockTlsMaterial } from "../smtp.js";

export interface FakeFetchCall {
  url: string;
  init: EgressFetchInit;
}

export interface FakeEgress extends Egress {
  fetchCalls: FakeFetchCall[];
  /** What `fetch` answers with; the response may be as bare as `{status, body}`. */
  fetchImpl: (url: string, init: EgressFetchInit) => Promise<TokenResponse>;
}

export function createFakeEgress(): FakeEgress {
  const sockets = new Set<Duplex>();
  const fetchCalls: FakeFetchCall[] = [];
  const egress: FakeEgress = {
    fetchCalls,
    fetchImpl: async () => {
      throw new Error("fake egress: fetch not programmed for this test");
    },
    async fetch(url, init) {
      fetchCalls.push({ url, init });
      // The stub may omit `text()`; auth.ts's readBody copes, the contract's
      // nominal type does not.
      return (await egress.fetchImpl(url, init)) as EgressResponse;
    },
    async assertPublic() {},
    connect(host: string, port: number, opts: EgressConnectOptions = {}) {
      return new Promise<Duplex>((resolve, reject) => {
        const timeoutMs = opts.timeoutMs ?? 30_000;
        let settled = false;
        const socket = opts.tls
          ? tls.connect({ host: "127.0.0.1", port, servername: opts.servername ?? host, minVersion: "TLSv1.2" })
          : net.connect({ host: "127.0.0.1", port });
        const fail = (err: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          socket.destroy();
          reject(err);
        };
        const timer = setTimeout(() => fail(new Error("fake egress: connect timed out")), timeoutMs);
        const onAbort = (): void => fail(Object.assign(new Error("connect aborted"), { name: "AbortError" }));
        const cleanup = (): void => {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          socket.removeListener("error", fail);
        };
        socket.once("error", fail);
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        socket.once(opts.tls ? "secureConnect" : "connect", () => {
          if (settled) return;
          settled = true;
          cleanup();
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
          resolve(socket);
        });
      });
    },
    async dispose() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
  return egress;
}

/** Returns true when the fixture certificate could be trusted process-wide. */
export function trustMockCertificate(): boolean {
  if (typeof tls.setDefaultCACertificates !== "function" || typeof tls.getCACertificates !== "function") return false;
  const { cert } = mockTlsMaterial();
  const current = tls.getCACertificates("default");
  if (!current.includes(cert.toString())) tls.setDefaultCACertificates([...current, cert.toString()]);
  return true;
}

/** The host's `ctx.fail`: an error whose message the agent may see. The
 * fake tags it `agentSafe` so tests can tell it from a collapsed failure. */
export function fakeFail(message: string, code?: DriverFailCode): Error {
  return Object.assign(new Error(message), { agentSafe: true, code: code ?? "invalid_request" });
}

export interface TestCtx extends RunContext {
  /** Everything the driver logged, in order. */
  logs: string[];
}

/** A run context with a programmable signal and a captured log. */
export function createCtx(
  egress: Egress,
  { signal, pinned = [] }: { signal?: AbortSignal; pinned?: readonly string[] } = {},
): TestCtx {
  const logs: string[] = [];
  return {
    egress,
    signal: signal ?? new AbortController().signal,
    log: (message) => logs.push(message),
    fail: fakeFail,
    pinned,
    logs,
    config: {},
    action: "",
    params: {},
    writer: null,
  };
}
