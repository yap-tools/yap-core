/**
 * A mock SMTP server: just enough of RFC 5321 to drive the example smtp driver
 * end to end, and nothing more.
 *
 * It exists to exercise the *driver*, so the parts it implements are the parts
 * a driver can get wrong: a multi-line EHLO reply (the continuation parser),
 * the `334` AUTH LOGIN challenge/response pair, the `354` DATA transition, and
 * the lone-dot terminator with its dot-stuffing. Everything it receives is
 * recorded verbatim, so a test can assert on the bytes that went over the wire
 * rather than on the driver's own account of them.
 */
import net from "node:net";

export interface MockSmtpMessage {
  from: string;
  to: string[];
  /** The DATA payload as the server saw it, un-destuffed, CRLF-joined. */
  data: string;
}

export interface MockSmtpOptions {
  /** Reject every RCPT TO with a 550 — the permanent-failure path. */
  rejectRcpt?: boolean;
  /** Advertise AUTH and refuse MAIL FROM until the client has authenticated. */
  requireAuth?: boolean;
  /** Accept the connection and then say nothing at all — no greeting, ever.
   * The client must give up on its own budget. */
  silent?: boolean;
}

export interface MockSmtp {
  port: number;
  messages: MockSmtpMessage[];
  /** Base64 payloads the client sent in answer to a `334` challenge. */
  authLines: string[];
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
  /** Which half of the AUTH LOGIN exchange the next line answers, if any. */
  awaiting: "user" | "pass" | null;
  authed: boolean;
}

export async function startMockSmtp(options: MockSmtpOptions = {}): Promise<MockSmtp> {
  const messages: MockSmtpMessage[] = [];
  const authLines: string[] = [];
  let connections = 0;
  let closed = 0;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => {
      closed += 1;
      sockets.delete(socket);
    });
    socket.on("error", () => {}); // a client that hangs up mid-session is fine
    socket.setEncoding("utf8");

    const session: Session = { from: "", to: [], dataLines: [], inData: false, awaiting: null, authed: false };
    const send = (line: string): void => {
      socket.write(`${line}\r\n`);
    };

    if (options.silent) return; // no greeting, no replies: the client must time out
    send("220 mock.example.test ESMTP ready");

    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handle(line);
      }
    });

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
        if (session.awaiting === "user") {
          session.awaiting = "pass";
          send("334 UGFzc3dvcmQ6"); // "Password:"
        } else {
          session.awaiting = null;
          session.authed = true;
          send("235 2.7.0 Authentication successful");
        }
        return;
      }

      const verb = line.split(/[ :]/, 1)[0]!.toUpperCase();
      switch (verb) {
        case "EHLO":
        case "HELO":
          // Deliberately multi-line: the continuation form ("250-") is what a
          // naive reply parser mistakes for the end of the reply.
          send("250-mock greets you");
          if (options.requireAuth) send("250-AUTH LOGIN");
          send("250 OK");
          return;
        case "AUTH":
          session.awaiting = "user";
          send("334 VXNlcm5hbWU6"); // "Username:"
          return;
        case "MAIL":
          if (options.requireAuth && !session.authed) {
            send("530 5.7.0 Authentication required");
            return;
          }
          session.from = address(line);
          send("250 2.1.0 Ok");
          return;
        case "RCPT":
          if (options.rejectRcpt) {
            send("550 5.1.1 <recipient> unknown user");
            return;
          }
          session.to.push(address(line));
          send("250 2.1.5 Ok");
          return;
        case "DATA":
          session.inData = true;
          send("354 End data with <CR><LF>.<CR><LF>");
          return;
        case "RSET":
          session.from = "";
          session.to = [];
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
  const address_ = server.address();
  if (!address_ || typeof address_ === "string") throw new Error("mock smtp server did not bind a port");

  return {
    port: address_.port,
    messages,
    authLines,
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
