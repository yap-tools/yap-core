/**
 * The SMTP client: greeting, EHLO, STARTTLS, AUTH, MAIL FROM, RCPT TO, DATA,
 * QUIT — one already-built message to a list of recipients. It is not a mail
 * library; it is the smallest thing that really talks to a real server, on top
 * of the line reader in net.ts.
 *
 * What it is careful about:
 *
 * - Credentials never travel in the clear by accident. With `security:
 *   "starttls"` the upgrade must succeed before AUTH (a server that does not
 *   advertise STARTTLS fails the run rather than being quietly downgraded), and
 *   with `security: "none"` credentials are sent only when the operator set
 *   `allow_plaintext_auth: true` — meant for lab servers like GreenMail, not
 *   for the internet. A server that offers no AUTH at all while we hold
 *   credentials is a misconfiguration, reported as such instead of guessed at.
 * - The transcript in `ctx.log` is complete *except* for secrets and the
 *   message: AUTH payloads are logged as placeholders and the DATA body as its
 *   byte count. Yap's runs layer treats a driver error as "run failed" for the
 *   agent, so the server's reply lines survive only here — which is why every
 *   reply is logged.
 * - Dot-stuffing happens here, on the wire, and so does a final line-break
 *   normalisation: a bare CR or LF in the message is turned into CRLF before
 *   the dot check, so no line of the payload can impersonate the terminator
 *   even to a server that treats bare CR as a line end (SMTP smuggling).
 * - One RCPT TO per recipient; if any is refused, nothing is sent and the
 *   error lists every rejection. A partial delivery to "whoever the server
 *   liked" is not what the caller asked for.
 * - Errors are `ProtocolError`s carrying the step and the server's reply line,
 *   never credentials.
 */
import { xoauth2Payload, type ResolvedAuth } from "./auth.js";
import type { ProtocolBlock } from "./config.js";
import { abortError, openLine, ProtocolError, type LineConnection, type MailCtx } from "./net.js";

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_REPLY_CONTINUATION_LINES = 100;
const EHLO_NAME = "yap";

/** The endpoint plus the result of `resolveAuth` (null for no authentication). */
export type SmtpSessionConfig = ProtocolBlock & { allow_plaintext_auth?: boolean; auth: ResolvedAuth };

export interface SmtpEnvelope {
  from: string;
  to: string[];
  /** The built message; dot-stuffed and CRLF-normalised here, on the wire. */
  message: Buffer | string;
}

export interface SmtpRejection {
  address: string;
  reply: string;
}

interface Reply {
  code: number;
  lines: string[];
  last: string;
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** Resolves to `{accepted: true}` once the DATA terminator got its 250. */
export async function smtpSend(
  ctx: MailCtx,
  config: SmtpSessionConfig,
  { from, to, message }: SmtpEnvelope,
): Promise<{ accepted: true }> {
  if (!Array.isArray(to) || to.length === 0) throw new Error("smtpSend needs at least one recipient");
  const { line, session } = await openSession(ctx, config);
  try {
    await session.command(`MAIL FROM:<${from}>`, [250], "MAIL FROM");
    const rejections: SmtpRejection[] = [];
    for (const address of to) {
      const reply = await session.command(`RCPT TO:<${address}>`, null, "RCPT TO");
      if (reply.code !== 250 && reply.code !== 251) rejections.push({ address, reply: reply.last });
    }
    if (rejections.length > 0) {
      throw new ProtocolError(`SMTP RCPT TO was rejected for ${rejections.length} of ${to.length} recipients`, {
        step: "RCPT TO",
        reply: rejections[0]?.reply,
        rejections,
      });
    }

    await session.command("DATA", [354], "DATA");
    const payload = dotStuff(message);
    ctx.log(`> <message, ${payload.length} bytes>`);
    line.writeRaw(payload);
    line.write(".");
    await session.expect([250], "message");
    await quit(session);
    return { accepted: true };
  } finally {
    line.close();
  }
}

/**
 * Connect, (STARTTLS), authenticate, QUIT — nothing sent. For authoring-time
 * validation: a wrong password fails here rather than on the first run.
 */
export async function smtpProbe(ctx: MailCtx, config: SmtpSessionConfig): Promise<void> {
  const { line, session } = await openSession(ctx, config);
  try {
    await quit(session);
  } finally {
    line.close();
  }
}

async function quit(session: Session): Promise<void> {
  try {
    await session.command("QUIT", [221], "QUIT");
  } catch {
    // Best effort: the mail is accepted once the DATA terminator got its
    // 250, so a server that hangs up during QUIT has still taken it.
  }
}

/** Greeting through authentication; the caller owns `line` from here on. */
async function openSession(
  ctx: MailCtx,
  config: SmtpSessionConfig,
): Promise<{ line: LineConnection; session: Session }> {
  const line = await openLine(ctx, {
    host: config.host,
    port: config.port,
    security: config.security ?? "none",
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
  });
  const session = createSession(line, ctx);
  try {
    await session.expect([220], "greeting");
    let ehlo = parseEhlo(await session.command(`EHLO ${EHLO_NAME}`, [250], "EHLO"));
    let encrypted = config.security === "tls";

    if (config.security === "starttls") {
      if (!ehlo.has("STARTTLS")) {
        throw new ProtocolError("the SMTP server does not advertise STARTTLS", { step: "STARTTLS" });
      }
      await session.command("STARTTLS", [220], "STARTTLS");
      await line.startTls();
      ctx.log("* TLS established");
      encrypted = true;
      // RFC 3207: the client must forget everything learnt before the upgrade.
      ehlo = parseEhlo(await session.command(`EHLO ${EHLO_NAME}`, [250], "EHLO"));
    }

    if (config.auth) {
      if (!encrypted && config.allow_plaintext_auth !== true) {
        throw new ProtocolError(
          "refusing to send credentials over a plaintext connection (set allow_plaintext_auth to override)",
          { step: "AUTH" },
        );
      }
      await authenticate(session, ehlo, config.auth);
    }
    return { line, session };
  } catch (e) {
    line.close();
    throw e;
  }
}

/** The EHLO keywords (upper-cased), with `AUTH` expanded to its mechanisms. */
function parseEhlo(reply: Reply): Set<string> {
  const keywords = new Set<string>();
  for (const text of reply.lines.slice(1)) {
    const words = text.slice(4).trim().split(/\s+/);
    const keyword = words[0]?.toUpperCase();
    if (!keyword) continue;
    keywords.add(keyword);
    if (keyword === "AUTH") for (const mech of words.slice(1)) keywords.add(`AUTH ${mech.toUpperCase()}`);
  }
  return keywords;
}

async function authenticate(session: Session, ehlo: Set<string>, auth: NonNullable<ResolvedAuth>): Promise<void> {
  if (!ehlo.has("AUTH")) {
    throw new ProtocolError("credentials are configured but the SMTP server did not advertise AUTH", {
      step: "AUTH",
    });
  }
  if (auth.kind === "xoauth2") {
    if (!ehlo.has("AUTH XOAUTH2")) {
      throw new ProtocolError("the SMTP server does not offer AUTH XOAUTH2", { step: "AUTH XOAUTH2" });
    }
    const reply = await session.command(
      `AUTH XOAUTH2 ${xoauth2Payload(auth.user, auth.token)}`,
      null,
      "AUTH XOAUTH2",
      "AUTH XOAUTH2 <credentials>",
    );
    if (reply.code === 235) return;
    if (reply.code === 334) {
      // The server is handing back a base64 JSON error; an empty line asks it
      // to finish the exchange with the real (5xx) status.
      const final = await session.command("", null, "AUTH XOAUTH2", "<empty>");
      throw new ProtocolError("SMTP AUTH XOAUTH2 was rejected", { step: "AUTH XOAUTH2", reply: final.last });
    }
    throw new ProtocolError("SMTP AUTH XOAUTH2 was rejected", { step: "AUTH XOAUTH2", reply: reply.last });
  }
  if (ehlo.has("AUTH PLAIN")) {
    await session.command(
      `AUTH PLAIN ${base64(`\0${auth.user}\0${auth.pass}`)}`,
      [235],
      "AUTH PLAIN",
      "AUTH PLAIN <credentials>",
    );
    return;
  }
  if (ehlo.has("AUTH LOGIN")) {
    await session.command("AUTH LOGIN", [334], "AUTH LOGIN");
    await session.command(base64(auth.user), [334], "AUTH LOGIN username", "<username>");
    await session.command(base64(auth.pass), [235], "AUTH LOGIN password", "<password>");
    return;
  }
  throw new ProtocolError("the SMTP server offers neither AUTH PLAIN nor AUTH LOGIN", { step: "AUTH" });
}

/**
 * The message as it goes on the wire: every line-break form → CRLF, every line
 * starting with "." gets a second one, trailing CRLF guaranteed so the
 * terminator the caller writes next stands on its own line. latin1 keeps the
 * bytes intact — the message is UTF-8, but this function need not care.
 */
export function dotStuff(message: Buffer | string): Buffer {
  const text = Buffer.isBuffer(message) ? message.toString("latin1") : Buffer.from(message, "utf8").toString("latin1");
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  const stuffed = lines.map((l) => (l.startsWith(".") ? `.${l}` : l));
  return Buffer.from(`${stuffed.join("\r\n")}\r\n`, "latin1");
}

interface Session {
  /** Reads a reply and, when `codes` is given, demands one of them. */
  expect(codes: number[] | null, step: string): Promise<Reply>;
  /** Writes one line and reads its reply. `label` redacts what is logged. */
  command(text: string, codes: number[] | null, step: string, label?: string): Promise<Reply>;
}

/**
 * The reply grammar on top of the line reader: a reply may be multi-line
 * (`250-first` … `250 last`), and a runaway continuation is capped.
 */
function createSession(line: LineConnection, ctx: MailCtx): Session {
  async function readReply(): Promise<Reply> {
    const collected: string[] = [];
    for (;;) {
      const text = await line.reader.nextLine();
      collected.push(text);
      if (collected.length > MAX_REPLY_CONTINUATION_LINES) {
        throw new ProtocolError(`SMTP reply exceeded ${MAX_REPLY_CONTINUATION_LINES} continuation lines`, {
          step: "reply",
        });
      }
      const match = /^(\d{3})([ -]?)/.exec(text);
      if (!match) throw new ProtocolError("unexpected SMTP reply", { step: "reply", reply: text });
      if (match[2] !== "-") return { code: Number(match[1]), lines: collected, last: text };
    }
  }

  const session: Session = {
    async expect(codes, step) {
      if (ctx.signal.aborted) throw abortError("run aborted");
      const reply = await readReply();
      for (const text of reply.lines) ctx.log(`< ${text}`);
      if (codes && !codes.includes(reply.code)) {
        throw new ProtocolError(`SMTP ${step} was rejected`, { step, reply: reply.last });
      }
      return reply;
    },

    async command(text, codes, step, label) {
      if (ctx.signal.aborted) throw abortError("run aborted");
      ctx.log(`> ${label ?? text}`);
      line.write(text);
      return await session.expect(codes, step);
    },
  };
  return session;
}
