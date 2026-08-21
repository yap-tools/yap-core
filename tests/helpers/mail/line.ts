/**
 * A stand-in for net.ts's `openLine` so the IMAP client tests do not depend on
 * the egress layer: a plain net.connect socket with the same reader contract
 * (nextLine / readBytes racing the abort signal) and a STARTTLS upgrade that
 * trusts the test fixture certificate.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import type { LineConnection, MailCtx, OpenLineOptions } from "../../../src/core/drivers/mail/net.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, "../../fixtures/mail");

let cert: Buffer | undefined;
let key: Buffer | undefined;
/** The fixture certificate, read on first use. */
export function fixtureCert(): Buffer {
  return (cert ??= fs.readFileSync(path.join(fixtureDir, "mock-cert.pem")));
}
/** The fixture private key, read on first use. */
export function fixtureKey(): Buffer {
  return (key ??= fs.readFileSync(path.join(fixtureDir, "mock-key.pem")));
}

export async function fakeOpenLine(ctx: MailCtx, { host, port, security = "none" }: OpenLineOptions): Promise<LineConnection> {
  let socket: Duplex = await new Promise<net.Socket>((resolve, reject) => {
    const s: net.Socket =
      security === "tls"
        ? tls.connect({ host, port, ca: fixtureCert(), servername: "localhost" }, () => resolve(s))
        : net.connect({ host, port }, () => resolve(s));
    s.once("error", reject);
  });
  const reader = new Reader(ctx.signal);
  reader.bind(socket);
  const conn: LineConnection = {
    get socket() {
      return socket;
    },
    reader,
    write(line: string) {
      socket.write(line + "\r\n");
    },
    writeRaw(buffer: Buffer) {
      socket.write(buffer);
    },
    async startTls() {
      socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const t = tls.connect({ socket, ca: fixtureCert(), servername: "localhost" }, () => resolve(t));
        t.once("error", reject);
      });
      reader.bind(socket);
    },
    close() {
      socket.destroy();
    },
  };
  return conn;
}

class Reader {
  private buf = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private closed = false;

  constructor(private readonly signal: AbortSignal | undefined) {}

  bind(socket: Duplex): void {
    socket.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.wake();
    });
    socket.on("close", () => {
      this.closed = true;
      this.wake();
    });
    socket.on("error", () => {
      this.closed = true;
      this.wake();
    });
  }

  private wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  private wait(): Promise<void> {
    if (this.signal?.aborted) throw abortError(this.signal);
    if (this.closed) throw new Error("connection closed");
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(abortError(this.signal));
      this.signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(() => {
        this.signal?.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  async nextLine(): Promise<string> {
    for (;;) {
      const idx = this.buf.indexOf("\r\n");
      if (idx >= 0) {
        const line = this.buf.subarray(0, idx).toString("utf8");
        this.buf = this.buf.subarray(idx + 2);
        return line;
      }
      await this.wait();
    }
  }

  async readBytes(n: number): Promise<Buffer> {
    while (this.buf.length < n) await this.wait();
    const out = Buffer.from(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  const e = new Error(reason instanceof Error ? reason.message : "aborted");
  e.name = "AbortError";
  return e;
}

export interface FakeCtx extends MailCtx {
  logs: string[];
}

/** A MailCtx with no egress (the fake openLine does not need one) and a log sink. */
export function fakeCtx({ signal }: { signal?: AbortSignal } = {}): FakeCtx {
  const logs: string[] = [];
  return { signal: signal ?? new AbortController().signal, log: (m) => logs.push(m), logs, egress: null };
}
