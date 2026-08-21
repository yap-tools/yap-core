import net from "node:net";
import type { TLSSocket } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";

import type { EgressConnectOptions } from "../../src/core/drivers/egress.js";
import { openLine, ProtocolError, requireEgress } from "../../src/core/drivers/mail/net.js";
import { createCtx, createFakeEgress, trustMockCertificate } from "../helpers/mail/egress.js";
import { startMockSmtp } from "../helpers/smtp.js";

/** A raw TCP server whose handler gets the accepted socket. */
async function rawServer(handler: (socket: net.Socket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    handler(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("raw server did not bind a port");
  return {
    port: bound.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function open(port: number, overrides: { signal?: AbortSignal } = {}, host = "mail.example.test") {
  const egress = createFakeEgress();
  cleanups.push(() => egress.dispose());
  const ctx = createCtx(egress, overrides);
  const line = await openLine(ctx, { host, port, security: "none", connectTimeoutMs: 2000 });
  cleanups.push(() => line.close());
  return { line, ctx };
}

describe("openLine reader", () => {
  it("reads CRLF-delimited lines, across chunk boundaries", async () => {
    const server = await rawServer((socket) => {
      socket.write("220 hel");
      setTimeout(() => socket.write("lo\r\n250 second\r\n"), 20);
    });
    cleanups.push(server.close);
    const { line } = await open(server.port);
    expect(await line.reader.nextLine()).toBe("220 hello");
    expect(await line.reader.nextLine()).toBe("250 second");
  });

  it("fails a line that exceeds 64 KiB without a terminator", async () => {
    const server = await rawServer((socket) => {
      socket.write("x".repeat(70 * 1024));
    });
    cleanups.push(server.close);
    const { line } = await open(server.port);
    await expect(line.reader.nextLine()).rejects.toThrow(/exceeded 65536 bytes/);
  });

  it("readBytes returns exactly n bytes and leaves the rest for nextLine", async () => {
    const server = await rawServer((socket) => {
      socket.write("* 5 FETCH {6}\r\nabcdef)\r\nA1 OK\r\n");
    });
    cleanups.push(server.close);
    const { line } = await open(server.port);
    expect(await line.reader.nextLine()).toBe("* 5 FETCH {6}");
    expect((await line.reader.readBytes(6)).toString()).toBe("abcdef");
    expect(await line.reader.nextLine()).toBe(")");
    expect(await line.reader.nextLine()).toBe("A1 OK");
  });

  it("readBytes refuses more than 25 MiB and a negative length", async () => {
    const server = await rawServer(() => {});
    cleanups.push(server.close);
    const { line } = await open(server.port);
    await expect(line.reader.readBytes(25 * 1024 * 1024 + 1)).rejects.toThrow(/25 MiB/);
    await expect(line.reader.readBytes(-1)).rejects.toThrow(/invalid literal length/);
  });

  it("refuses a second read while one is pending", async () => {
    const server = await rawServer((socket) => {
      setTimeout(() => socket.write("220 late\r\n"), 20);
    });
    cleanups.push(server.close);
    const { line } = await open(server.port);
    const first = line.reader.nextLine();
    await expect(line.reader.nextLine()).rejects.toThrow(/already pending/);
    expect(await first).toBe("220 late");
  });

  it("rejects a pending read when the signal aborts", async () => {
    const server = await rawServer(() => {});
    cleanups.push(server.close);
    const controller = new AbortController();
    const { line } = await open(server.port, { signal: controller.signal });
    const pending = line.reader.nextLine();
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects immediately when the signal was already aborted", async () => {
    const server = await rawServer(() => {});
    cleanups.push(server.close);
    const controller = new AbortController();
    const { line } = await open(server.port, { signal: controller.signal });
    controller.abort();
    await expect(line.reader.nextLine()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses to connect when the signal was aborted beforehand", async () => {
    const controller = new AbortController();
    controller.abort();
    const egress = createFakeEgress();
    await expect(
      openLine(createCtx(egress, { signal: controller.signal }), { host: "h", port: 1, security: "none" }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails a pending read when the server closes", async () => {
    const server = await rawServer((socket) => {
      setTimeout(() => socket.end(), 10);
    });
    cleanups.push(server.close);
    const { line } = await open(server.port);
    await expect(line.reader.nextLine()).rejects.toThrow(/closed the connection/);
  });

  it("write appends CRLF", async () => {
    let received = "";
    const server = await rawServer((socket) => {
      socket.on("data", (chunk) => {
        received += chunk.toString();
        if (received.endsWith("\r\n")) socket.write("250 ok\r\n");
      });
    });
    cleanups.push(server.close);
    const { line } = await open(server.port);
    line.write("NOOP");
    await line.reader.nextLine();
    expect(received).toBe("NOOP\r\n");
  });

  it("connects with tls:true and the hostname as servername", async () => {
    const egress = createFakeEgress();
    const seen: Array<{ host: string; port: number; opts: EgressConnectOptions | undefined }> = [];
    const realConnect = egress.connect.bind(egress);
    egress.connect = (host, port, opts) => {
      seen.push({ host, port, opts });
      return realConnect(host, port, { ...opts, tls: false });
    };
    const server = await rawServer(() => {});
    cleanups.push(server.close);
    const line = await openLine(createCtx(egress), { host: "mail.example.test", port: server.port, security: "tls" });
    cleanups.push(() => line.close());
    expect(seen[0]?.opts).toMatchObject({ tls: true, servername: "mail.example.test" });
  });

  it("refuses a run context without an egress handle", async () => {
    const ctx = { ...createCtx(createFakeEgress()), egress: null };
    expect(() => requireEgress(ctx)).toThrow(/egress/);
    await expect(openLine(ctx, { host: "h", port: 1 })).rejects.toThrow(/egress/);
  });
});

describe("ProtocolError", () => {
  it("carries step and reply", () => {
    const err = new ProtocolError("SMTP DATA was rejected", { step: "DATA", reply: "554 nope" });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ProtocolError");
    expect(err.step).toBe("DATA");
    expect(err.reply).toBe("554 nope");
  });

  it("keeps any extra detail it was given", () => {
    const err = new ProtocolError("x", { step: "RCPT TO", rejections: [{ address: "a@b.c" }] });
    expect(err.rejections).toEqual([{ address: "a@b.c" }]);
    expect(err.reply).toBeUndefined();
  });
});

describe("startTls", () => {
  const trusted = trustMockCertificate();

  it.skipIf(!trusted)("upgrades the socket in place and rebinds the reader", async () => {
    const smtp = await startMockSmtp({ startTls: true });
    cleanups.push(smtp.close);
    // The fixture certificate names localhost, which is what makes the
    // verified upgrade succeed here and fail in the next test.
    const { line } = await open(smtp.port, {}, "localhost");
    expect(await line.reader.nextLine()).toMatch(/^220/);
    line.write("STARTTLS");
    expect(await line.reader.nextLine()).toMatch(/^220/);
    const before = line.socket;
    await line.startTls();
    expect(line.socket).not.toBe(before);
    expect((line.socket as TLSSocket).encrypted).toBe(true);
    expect(before.listenerCount("data")).toBe(0);
    line.write("NOOP");
    expect(await line.reader.nextLine()).toMatch(/^250/);
  });

  it.skipIf(!trusted)("rejects when the certificate does not match the host", async () => {
    const smtp = await startMockSmtp({ startTls: true });
    cleanups.push(smtp.close);
    const egress = createFakeEgress();
    cleanups.push(() => egress.dispose());
    const line = await openLine(createCtx(egress), { host: "wrong.example.test", port: smtp.port, security: "starttls" });
    cleanups.push(() => line.close());
    await line.reader.nextLine();
    line.write("STARTTLS");
    await line.reader.nextLine();
    await expect(line.startTls()).rejects.toThrow(/altname|certificate|Hostname/i);
  });
});
