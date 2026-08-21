/**
 * A mock SMTP server: just enough of RFC 5321 to drive an SMTP client end to
 * end, and nothing more. It serves both the built-in mail driver's smtp.ts and
 * the example smtp driver's integration test.
 *
 * It exists to exercise the *client*, so the parts it implements are the parts
 * a client can get wrong: a multi-line EHLO reply (the continuation parser),
 * STARTTLS with a real TLS upgrade on the same socket (the reader rebind), the
 * three AUTH shapes the client may pick (PLAIN inline, LOGIN's two `334`
 * challenges, XOAUTH2 with its JSON error challenge), one RCPT TO per recipient
 * with selective rejection, the `354` DATA transition, and the lone-dot
 * terminator with its dot-stuffing. Everything it receives is recorded
 * verbatim, so a test can assert on the bytes that went over the wire rather
 * than on the client's own account of them.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mail");

/** The static self-signed certificate the mock presents (CN=localhost,
 * SAN localhost + 127.0.0.1). Generated once with openssl; see tests/fixtures/mail. */
export function mockTlsMaterial(): { key: Buffer; cert: Buffer } {
  return {
    key: fs.readFileSync(path.join(fixtures, "mock-key.pem")),
    cert: fs.readFileSync(path.join(fixtures, "mock-cert.pem")),
  };
}

export interface MockSmtpMessage {
  from: string;
  to: string[];
  /** The DATA payload as the server saw it, un-destuffed, CRLF-joined. */
  data: string;
}

export interface MockSmtpOptions {
  /** Mechanisms to advertise after EHLO (default PLAIN LOGIN XOAUTH2); `[]`
   * advertises none. */
  auth?: string[];
  /** Advertise AUTH only once the session is encrypted, the way real
   * submission servers do. */
  authAfterStartTls?: boolean;
  /** Refuse MAIL FROM until the client has authenticated. */
  requireAuth?: boolean;
  /** Advertise STARTTLS and honour it with the fixture certificate. */
  startTls?: boolean;
  /** `true` to 550 every recipient, or the addresses to reject selectively. */
  rejectRcpt?: boolean | string[];
  /** Answer an inline AUTH PLAIN with 535. */
  rejectAuth?: boolean;
  /** Answer AUTH XOAUTH2 with the `334` JSON error challenge and then a 535
   * once the client sends its empty line. */
  rejectXoauth2?: boolean;
  /** Accept the connection and then say nothing at all — no greeting, ever.
   * The client must give up on its own budget. */
  silent?: boolean;
}

export interface MockSmtp {
  port: number;
  messages: MockSmtpMessage[];
  /** Base64 payloads the client sent for AUTH (inline or in answer to `334`). */
  authLines: string[];
  /** Every command line received outside DATA/AUTH, in order. */
  commands: string[];
  /** How many TCP connections were accepted — 0 proves nothing dialled in. */
  connections: number;
  /** How many of those the client closed again — a dropped session is visible. */
  closed: number;
  close(): Promise<void>;
}

/** Per-connection state; a fresh one for every accepted socket. */
interface Session {
  from: string;
  to: string[];
  dataLines: string[];
  inData: boolean;
  /** Which AUTH exchange the next line answers, if any. */
  awaiting: "user" | "pass" | "plain" | "xoauth2-ack" | null;
  authed: boolean;
  secure: boolean;
}

export async function startMockSmtp(options: MockSmtpOptions = {}): Promise<MockSmtp> {
  const messages: MockSmtpMessage[] = [];
  const authLines: string[] = [];
  const commands: string[] = [];
  let connections = 0;
  let closed = 0;
  const sockets = new Set<net.Socket>();
  const advertised = options.auth ?? ["PLAIN", "LOGIN", "XOAUTH2"];

  const server = net.createServer((rawSocket) => {
    connections += 1;
    sockets.add(rawSocket);
    rawSocket.on("close", () => {
      closed += 1;
      sockets.delete(rawSocket);
    });
    rawSocket.on("error", () => {}); // a client that hangs up mid-session is fine

    const session: Session = {
      from: "",
      to: [],
      dataLines: [],
      inData: false,
      awaiting: null,
      authed: false,
      secure: false,
    };
    let socket: net.Socket = rawSocket;
    let buffer = "";
    const send = (line: string): void => {
      socket.write(`${line}\r\n`);
    };

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handle(line);
      }
    };
    const bind = (s: net.Socket): void => {
      socket = s;
      buffer = "";
      s.on("data", onData);
      s.on("error", () => {});
    };

    if (options.silent) return; // no greeting, no replies: the client must time out
    bind(rawSocket);
    send("220 mock.example.test ESMTP ready");

    function handle(line: string): void {
      if (session.inData) {
        if (line === ".") {
          session.inData = false;
          messages.push({ from: session.from, to: [...session.to], data: session.dataLines.join("\r\n") });
          session.dataLines = [];
          send("250 2.0.0 Ok: queued");
        } else {
          session.dataLines.push(line);
        }
        return;
      }
      if (session.awaiting) {
        authLines.push(line);
        switch (session.awaiting) {
          case "user":
            session.awaiting = "pass";
            send("334 UGFzc3dvcmQ6"); // "Password:"
            return;
          case "pass":
          case "plain":
            session.awaiting = null;
            session.authed = true;
            send("235 2.7.0 Authentication successful");
            return;
          case "xoauth2-ack":
            session.awaiting = null;
            send("535 5.7.8 Authentication credentials invalid");
            return;
        }
      }

      commands.push(line);
      const verb = line.split(/[ :]/, 1)[0]!.toUpperCase();
      switch (verb) {
        case "EHLO":
        case "HELO": {
          // Deliberately multi-line: the continuation form ("250-") is what a
          // naive reply parser mistakes for the end of the reply.
          send("250-mock greets you");
          const showAuth = advertised.length > 0 && (!options.authAfterStartTls || session.secure);
          if (showAuth) send(`250-AUTH ${advertised.join(" ")}`);
          if (options.startTls && !session.secure) send("250-STARTTLS");
          send("250 OK");
          return;
        }
        case "STARTTLS": {
          if (!options.startTls || session.secure) {
            send("502 5.5.1 STARTTLS not available");
            return;
          }
          send("220 2.0.0 Ready to start TLS");
          rawSocket.removeListener("data", onData);
          const secure = new tls.TLSSocket(rawSocket, { isServer: true, ...mockTlsMaterial() });
          session.secure = true;
          session.authed = false;
          bind(secure);
          return;
        }
        case "AUTH": {
          const [, mech, initial] = line.split(" ");
          const mechanism = (mech ?? "").toUpperCase();
          if (!advertised.includes(mechanism)) {
            send("504 5.5.4 Unrecognized authentication type");
            return;
          }
          if (mechanism === "LOGIN") {
            session.awaiting = "user";
            send("334 VXNlcm5hbWU6"); // "Username:"
            return;
          }
          if (mechanism === "PLAIN") {
            if (initial === undefined) {
              session.awaiting = "plain";
              send("334 ");
              return;
            }
            authLines.push(initial);
            if (options.rejectAuth) {
              send("535 5.7.8 Authentication credentials invalid");
              return;
            }
            session.authed = true;
            send("235 2.7.0 Authentication successful");
            return;
          }
          if (mechanism === "XOAUTH2") {
            authLines.push(initial ?? "");
            if (options.rejectXoauth2) {
              session.awaiting = "xoauth2-ack";
              const err = Buffer.from(JSON.stringify({ status: "401", schemes: "bearer" })).toString("base64");
              send(`334 ${err}`);
              return;
            }
            session.authed = true;
            send("235 2.7.0 Authentication successful");
            return;
          }
          send("504 5.5.4 Unrecognized authentication type");
          return;
        }
        case "MAIL":
          if (options.requireAuth && !session.authed) {
            send("530 5.7.0 Authentication required");
            return;
          }
          session.from = address(line);
          send("250 2.1.0 Ok");
          return;
        case "RCPT": {
          const rcpt = address(line);
          const reject =
            options.rejectRcpt === true || (Array.isArray(options.rejectRcpt) && options.rejectRcpt.includes(rcpt));
          if (reject) {
            send(`550 5.1.1 <${rcpt}> unknown user`);
            return;
          }
          session.to.push(rcpt);
          send("250 2.1.5 Ok");
          return;
        }
        case "DATA":
          session.inData = true;
          send("354 End data with <CR><LF>.<CR><LF>");
          return;
        case "RSET":
          session.from = "";
          session.to = [];
          send("250 2.0.0 Ok");
          return;
        case "NOOP":
          send("250 2.0.0 Ok");
          return;
        case "QUIT":
          send("221 2.0.0 Bye");
          socket.end();
          return;
        default:
          send("502 5.5.2 Command not implemented");
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("mock smtp server did not bind a port");

  return {
    port: bound.port,
    messages,
    authLines,
    commands,
    get connections() {
      return connections;
    },
    get closed() {
      return closed;
    },
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Pulls the address out of `MAIL FROM:<a@b>` / `RCPT TO:<a@b>`. */
function address(line: string): string {
  return /<([^>]*)>/.exec(line)?.[1] ?? line.split(":").slice(1).join(":").trim();
}
