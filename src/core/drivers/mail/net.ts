/**
 * The wire layer both mail protocols share: open a connection through the
 * host's guarded egress door, read it as lines (or as a counted run of bytes,
 * for IMAP literals), upgrade it to TLS in place for STARTTLS, and tear it
 * down.
 *
 * Everything network-shaped the mail driver does goes through `openLine`,
 * which is what keeps three properties in one place:
 *
 * - The network is reached only through `ctx.egress.connect()`, which resolves
 *   the host itself and refuses private, link-local, and loopback addresses
 *   unless the operator allowlisted them. STARTTLS does *not* open a second
 *   connection: it wraps the already-vetted socket with `tls.connect({socket})`,
 *   so the SSRF decision made at connect time still holds after the upgrade.
 *   Certificate verification stays on, TLS 1.2 is the floor, and `servername`
 *   is the configured hostname so SNI and the name check are both real.
 * - Every read races `ctx.signal`, and a peer that closes or errors fails the
 *   pending read instead of hanging the run. A signal already aborted before a
 *   read starts fails it immediately: its "abort" event fired in the past and
 *   a listener added now would never see it.
 * - A hostile or broken server cannot grow memory for the whole timeout budget:
 *   a line without a terminator is capped at 64 KiB and a literal at 25 MiB.
 *
 * The reader binds to whichever socket is current. `startTls()` unbinds it
 * from the plaintext socket *before* the handshake begins — a listener left
 * behind would read TLS records as if they were lines — and rebinds it to the
 * TLS socket afterwards, discarding anything still buffered from the plaintext
 * phase, as RFC 3207 requires.
 */
import type { Duplex } from "node:stream";
import tls from "node:tls";

import type { Egress } from "../egress.js";
import type { RunContext } from "../types.js";
import type { Security } from "./config.js";

/** The slice of a run context the wire and auth layers need. */
export type MailCtx = Pick<RunContext, "egress" | "signal" | "log">;

const MAX_LINE_BYTES = 64 * 1024;
const MAX_LITERAL_BYTES = 25 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** How long `close()` waits for the peer to answer our FIN before destroying. */
const CLOSE_GRACE_MS = 200;

export interface ProtocolErrorDetails {
  step?: string;
  reply?: string;
  [extra: string]: unknown;
}

/** A protocol-level failure: the step that failed and the peer's reply line.
 * Never carries credentials — callers redact before constructing one. */
export class ProtocolError extends Error {
  readonly step: string | undefined;
  readonly reply: string | undefined;
  [extra: string]: unknown;

  constructor(message: string, { step, reply, ...rest }: ProtocolErrorDetails = {}) {
    super(message);
    this.name = "ProtocolError";
    this.step = step;
    this.reply = reply;
    Object.assign(this, rest);
  }
}

export function abortError(message = "the run was aborted"): Error {
  return Object.assign(new Error(message), { name: "AbortError" });
}

/** The egress handle, or a clear error: the mail driver declares `egress:
 * true`, so a null here is a wiring mistake, not a policy decision. */
export function requireEgress(ctx: MailCtx): Egress {
  if (!ctx.egress) throw new Error("the mail driver needs an egress handle but the run context carries none");
  return ctx.egress;
}

export interface LineReader {
  /** The next CRLF-terminated line, without its terminator, as UTF-8. */
  nextLine(): Promise<string>;
  /** Exactly `n` raw bytes (an IMAP literal). */
  readBytes(n: number): Promise<Buffer>;
}

export interface LineConnection {
  /** The current socket: the TLS socket once `startTls()` has completed. */
  readonly socket: Duplex;
  readonly reader: LineReader;
  /** Writes one line, appending CRLF. */
  write(text: string): void;
  writeRaw(buffer: Buffer): void;
  /** Upgrades the connection in place; the caller has already sent the
   * protocol's STARTTLS command and read its go-ahead. */
  startTls(): Promise<void>;
  close(): void;
}

export interface OpenLineOptions {
  host: string;
  port: number;
  security?: Security;
  connectTimeoutMs?: number;
}

/**
 * Opens a connection. `security` is "tls" (TLS from the first byte),
 * "starttls" (plaintext now; the caller issues the protocol's STARTTLS command
 * and then awaits `startTls()`), or "none".
 */
export async function openLine(ctx: MailCtx, options: OpenLineOptions): Promise<LineConnection> {
  const { host, port, security = "none", connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = options;
  if (security !== "tls" && security !== "starttls" && security !== "none") {
    throw new Error(`security must be "tls", "starttls", or "none", got ${JSON.stringify(security)}`);
  }
  const egress = requireEgress(ctx);
  if (ctx.signal.aborted) throw abortError();
  let socket: Duplex = await egress.connect(host, port, {
    tls: security === "tls",
    servername: host,
    signal: ctx.signal,
    timeoutMs: connectTimeoutMs,
  });
  const reader = createReader(ctx.signal);
  reader.bind(socket);

  let closed = false;
  const line: LineConnection = {
    get socket() {
      return socket;
    },
    reader,
    write(text) {
      socket.write(`${text}\r\n`);
    },
    writeRaw(buffer) {
      socket.write(buffer);
    },

    async startTls() {
      if (ctx.signal.aborted) throw abortError();
      const plain = socket;
      reader.unbind();
      const secure = tls.connect({
        socket: plain,
        servername: host,
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
      });
      try {
        await new Promise<void>((resolve, reject) => {
          let timer: NodeJS.Timeout | undefined;
          const cleanup = (): void => {
            clearTimeout(timer);
            ctx.signal.removeEventListener("abort", onAbort);
            secure.removeListener("error", onError);
            secure.removeListener("secureConnect", onSecure);
          };
          const onSecure = (): void => {
            cleanup();
            resolve();
          };
          const onError = (err: Error): void => {
            cleanup();
            reject(err);
          };
          const onAbort = (): void => onError(abortError("the run was aborted during the TLS upgrade"));
          timer = setTimeout(
            () => onError(new Error(`TLS upgrade did not complete within ${connectTimeoutMs} ms`)),
            connectTimeoutMs,
          );
          secure.once("secureConnect", onSecure);
          secure.once("error", onError);
          ctx.signal.addEventListener("abort", onAbort, { once: true });
        });
      } catch (err) {
        secure.destroy();
        plain.destroy();
        throw err;
      }
      socket = secure;
      reader.bind(secure);
    },

    close() {
      if (closed) return;
      closed = true;
      reader.dispose();
      // `end()` immediately followed by `destroy()` is not belt-and-braces, it
      // is a race: `destroy()` tears the socket down before the FIN `end()`
      // queued can reach the peer. We want the FIN sent — QUIT/LOGOUT may not
      // have gotten a reply, so this may be the only signal the peer gets that
      // the session is over — but we still want a hard close if the peer never
      // reciprocates. So: `end()`, then `destroy()` only if the socket has not
      // finished closing on its own within a short grace period.
      const current = socket;
      current.on("error", () => {});
      current.end();
      const graceTimer = setTimeout(() => current.destroy(), CLOSE_GRACE_MS);
      current.once("close", () => clearTimeout(graceTimer));
      graceTimer.unref();
    },
  };
  return line;
}

interface Reader extends LineReader {
  bind(socket: Duplex): void;
  unbind(): void;
  dispose(): void;
}

interface Pending {
  kind: "line" | "bytes";
  n: number;
  resolve: (value: never) => void;
  reject: (err: Error) => void;
}

/**
 * A byte buffer with two shapes of read on top, bound to one socket at a time.
 * Only one read may be pending; the protocols are strictly request/reply so
 * that is not a restriction in practice.
 */
function createReader(signal: AbortSignal): Reader {
  let chunks: Buffer[] = [];
  let buffered = 0;
  let waiting: Pending | null = null;
  let failure: Error | null = null;
  let socket: Duplex | null = null;

  const fail = (err: Error): void => {
    failure ??= err;
    settle();
  };
  const onData = (chunk: Buffer): void => {
    chunks.push(chunk);
    buffered += chunk.length;
    // The per-read caps below only apply while a read is pending; a peer that
    // floods between reads is stopped by the same ceiling a literal gets.
    if (buffered > MAX_LITERAL_BYTES + MAX_LINE_BYTES) {
      fail(new Error(`receive buffer exceeded ${MAX_LITERAL_BYTES + MAX_LINE_BYTES} bytes`));
      return;
    }
    settle();
  };
  const onClose = (): void => fail(new Error("the server closed the connection"));
  const onAbort = (): void => fail(abortError());

  function compact(): Buffer {
    if (chunks.length > 1) chunks = [Buffer.concat(chunks, buffered)];
    return chunks[0] ?? Buffer.alloc(0);
  }

  function take(n: number): Buffer {
    const all = compact();
    const out = all.subarray(0, n);
    chunks = all.length > n ? [all.subarray(n)] : [];
    buffered = all.length - n;
    return out;
  }

  function settle(): void {
    if (!waiting) return;
    const { kind, n, resolve, reject } = waiting;
    if (kind === "line") {
      const all = compact();
      const index = all.indexOf("\r\n");
      if (index >= 0) {
        waiting = null;
        const lineBytes = take(index + 2);
        resolve(lineBytes.subarray(0, index).toString("utf8") as never);
        return;
      }
      if (all.length > MAX_LINE_BYTES) {
        waiting = null;
        reject(new Error(`reply line exceeded ${MAX_LINE_BYTES} bytes without a terminator`));
        return;
      }
    } else if (buffered >= n) {
      waiting = null;
      resolve(Buffer.from(take(n)) as never);
      return;
    }
    if (failure) {
      waiting = null;
      reject(failure);
    }
  }

  function read<T>(kind: Pending["kind"], n: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (waiting) {
        reject(new Error("a read is already pending on this connection"));
        return;
      }
      if (signal.aborted) failure ??= abortError();
      waiting = { kind, n, resolve: resolve as Pending["resolve"], reject };
      settle();
    });
  }

  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  return {
    nextLine: () => read<string>("line", 0),
    readBytes(n) {
      if (!Number.isInteger(n) || n < 0) return Promise.reject(new Error(`invalid literal length ${n}`));
      if (n > MAX_LITERAL_BYTES) {
        return Promise.reject(new Error(`literal of ${n} bytes exceeds the 25 MiB cap`));
      }
      return read<Buffer>("bytes", n);
    },
    bind(next) {
      this.unbind();
      socket = next;
      chunks = [];
      buffered = 0;
      socket.on("data", onData);
      socket.on("error", fail);
      socket.on("end", onClose);
      socket.on("close", onClose);
    },
    unbind() {
      if (!socket) return;
      socket.removeListener("data", onData);
      socket.removeListener("error", fail);
      socket.removeListener("end", onClose);
      socket.removeListener("close", onClose);
      socket = null;
    },
    dispose() {
      this.unbind();
      signal.removeEventListener("abort", onAbort);
    },
  };
}
