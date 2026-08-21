/**
 * An in-memory IMAP server for the mail driver's tests.
 *
 * It speaks exactly the subset src/core/drivers/mail/imap.ts uses, and only as
 * far as a test needs to see the client do the right thing on the wire: it
 * records every command line (so a test can assert the literal bytes the
 * client sent), computes ENVELOPE and BODYSTRUCTURE from the raw RFC 5322
 * messages a test seeds it with (honestly for text/* and one level of
 * multipart; a test can supply a precomputed `bodystructure` string and
 * `sections` map for anything fancier), and can be told to misbehave in the
 * ways the client must survive: LOGINDISABLED, no UIDPLUS, BADCHARSET, a BYE
 * greeting, a dropped connection.
 *
 * It is not an IMAP server. Anything it does not understand gets a BAD, which
 * is also what a test wants to hear when the client says something wrong.
 */

import net from "node:net";
import tls from "node:tls";

import { Tokenizer, isBracket, utf7Encode, type Token } from "../../../src/core/drivers/mail/imap-parse.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface MockMessageSeed {
  uid: number;
  flags?: string[];
  internalDate?: Date | string;
  raw: string;
  /** Precomputed BODYSTRUCTURE list (wire form) overriding the computed one. */
  bodystructure?: string;
  /** Precomputed BODY[...] sections keyed by the spec text ("1", "HEADER.FIELDS (FROM)"). */
  sections?: Record<string, string>;
}

export interface MockMessage {
  uid: number;
  flags: string[];
  internalDate: Date;
  raw: string;
  bodystructure?: string;
  sections?: Record<string, string>;
  _mime?: MimeNode;
}

export interface MockMailboxSeed {
  /** Name as on the wire (modified UTF-7 encoded). */
  name: string;
  attributes?: string[];
  uidvalidity?: number;
  delimiter?: string;
  uidnext?: number;
  messages?: MockMessageSeed[];
}

export interface MockMailbox {
  name: string;
  attributes: string[];
  uidvalidity: number;
  delimiter: string;
  uidnext: number;
  messages: MockMessage[];
}

export interface ImapMockOptions {
  mailboxes?: MockMailboxSeed[];
  loginDisabled?: boolean;
  noUidplus?: boolean;
  silent?: boolean;
  badCharset?: boolean;
  preauth?: boolean;
  greetingBye?: boolean;
  dropAfterLogin?: boolean;
  /** Key and certificate to offer STARTTLS. */
  tls?: { key: Buffer | string; cert: Buffer | string };
  /** Extra capability atoms. */
  capabilities?: string[];
  /** A command word the server never answers (for abort tests). */
  slowCommand?: string;
  /** A command word answered with an untagged BYE and a closed socket. */
  byeOn?: string;
  /** Advertise only AUTH=XOAUTH2 so a password client falls back to LOGIN. */
  noAuthPlain?: boolean;
  /** Reject every authentication with NO. */
  authFail?: boolean;
}

export interface RecordedAuth {
  mechanism: "LOGIN" | "PLAIN" | "XOAUTH2";
  user: string | null | undefined;
  pass?: string | null | undefined;
  token?: string | undefined;
  payload?: string;
}

interface MockState {
  opts: ImapMockOptions;
  mailboxes: MockMailbox[];
  /** Raw command lines, in order, across connections. */
  commands: string[];
  /** Outbound literal payloads the client sent, in order. */
  literals: Buffer[];
  auth: RecordedAuth[];
  connections: number;
}

export interface ImapMock extends MockState {
  host: string;
  port: number;
  mailbox(name: string): MockMailbox | undefined;
  close(): Promise<void>;
}

export async function startImapMock(options: ImapMockOptions = {}): Promise<ImapMock> {
  // Quiet by default; IMAP_MOCK_VERBOSE=1 (or silent: false) prints the wire.
  const opts: ImapMockOptions = { silent: !process.env["IMAP_MOCK_VERBOSE"], ...options };
  const state: MockState = {
    opts,
    mailboxes: (opts.mailboxes ?? [defaultInbox()]).map(normalizeMailbox),
    commands: [],
    literals: [],
    auth: [],
    connections: 0,
  };

  const server = net.createServer((socket) => {
    state.connections++;
    handleConnection(socket, state).catch(() => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("imap-mock: no listening port");
  const sockets = new Set<net.Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  return {
    host: "127.0.0.1",
    port: address.port,
    opts: state.opts,
    mailboxes: state.mailboxes,
    commands: state.commands,
    literals: state.literals,
    auth: state.auth,
    get connections() {
      return state.connections;
    },
    mailbox: (name: string) => state.mailboxes.find((m) => m.name === name),
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function defaultInbox(): MockMailboxSeed {
  return { name: "INBOX", attributes: ["\\HasNoChildren"], uidvalidity: 1, messages: [] };
}

function normalizeMailbox(mb: MockMailboxSeed): MockMailbox {
  const messages: MockMessage[] = (mb.messages ?? []).map((m) => ({
    ...m,
    flags: [...(m.flags ?? [])],
    internalDate: m.internalDate instanceof Date ? m.internalDate : new Date(m.internalDate ?? Date.now()),
    raw: m.raw.includes("\r\n") ? m.raw : m.raw.replace(/\n/g, "\r\n"),
  }));
  const maxUid = messages.reduce((a, m) => Math.max(a, m.uid), 0);
  return {
    delimiter: mb.delimiter ?? "/",
    attributes: mb.attributes ?? [],
    uidvalidity: mb.uidvalidity ?? 1,
    name: mb.name,
    messages,
    uidnext: (mb.uidnext ?? maxUid) + 1,
  };
}

// ---------------------------------------------------------------------------
// Connection handling

class Reader {
  private buf = Buffer.alloc(0);
  private waiter: (() => void) | null = null;
  private closed = false;

  constructor(socket: net.Socket) {
    this.bind(socket);
  }

  bind(socket: net.Socket): void {
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
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  private async wait(): Promise<void> {
    if (this.closed) throw new Error("closed");
    await new Promise<void>((resolve) => {
      this.waiter = resolve;
    });
  }

  async readLine(): Promise<string> {
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
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return Buffer.from(out);
  }
}

interface Conn {
  state: MockState;
  socket: net.Socket;
  reader: Reader;
  secure: boolean;
  authed: boolean;
  selected: MockMailbox | null;
  readOnly: boolean;
  send: (line: string) => void;
  sendRaw: (buf: Buffer) => void;
}

function capabilities(conn: Conn): string {
  const { opts } = conn.state;
  const caps = ["IMAP4rev1", "SPECIAL-USE"];
  if (!opts.noUidplus) caps.push("UIDPLUS");
  if (opts.tls && !conn.secure) caps.push("STARTTLS");
  if (opts.loginDisabled && !conn.secure) caps.push("LOGINDISABLED");
  else if (opts.noAuthPlain) caps.push("AUTH=XOAUTH2");
  else caps.push("AUTH=PLAIN", "AUTH=XOAUTH2");
  if (opts.capabilities) caps.push(...opts.capabilities);
  return caps.join(" ");
}

async function handleConnection(socket: net.Socket, state: MockState): Promise<void> {
  const conn: Conn = {
    state,
    socket,
    reader: new Reader(socket),
    secure: false,
    authed: false,
    selected: null,
    readOnly: false,
    send: (line) => {
      if (!state.opts.silent) process.stdout.write(`  imap-mock > ${line.length > 200 ? line.slice(0, 200) + "…" : line}\n`);
      conn.socket.write(line + "\r\n");
    },
    sendRaw: (buf) => {
      conn.socket.write(buf);
    },
  };
  const { send } = conn;

  if (state.opts.greetingBye) {
    send("* BYE Server shutting down");
    socket.end();
    return;
  }
  if (state.opts.preauth) {
    conn.authed = true;
    send(`* PREAUTH [CAPABILITY ${capabilities(conn)}] Logged in as anonymous`);
  } else {
    send(`* OK [CAPABILITY ${capabilities(conn)}] imap-mock ready`);
  }

  for (;;) {
    let line: string;
    try {
      line = await conn.reader.readLine();
    } catch {
      return;
    }
    if (!state.opts.silent) process.stdout.write(`  imap-mock < ${line}\n`);
    state.commands.push(line);
    // Commands with a literal argument end in {n}; answer + and collect bytes.
    const tokenizer = new Tokenizer();
    try {
      let res = tokenizer.feed(line);
      while (res.literal !== undefined) {
        send("+ Ready for literal data");
        const bytes = await conn.reader.readBytes(res.literal);
        state.literals.push(bytes);
        tokenizer.feedLiteral(bytes);
        const cont = await conn.reader.readLine();
        state.commands.push(`(+${bytes.length} bytes)${cont}`);
        res = tokenizer.feed(cont);
      }
    } catch (e) {
      send(`* BAD ${(e as Error).message}`);
      continue;
    }
    const [tag, ...rest] = tokenizer.tokens;
    if (typeof tag !== "string" || rest.length === 0) {
      send(`${typeof tag === "string" ? tag : "*"} BAD Missing command`);
      continue;
    }
    let command = String(rest[0]).toUpperCase();
    let args = rest.slice(1);
    if (command === "UID") {
      command = "UID " + String(args[0]).toUpperCase();
      args = args.slice(1);
    }
    if (state.opts.byeOn && command === state.opts.byeOn) {
      send("* BYE Connection closed by server");
      socket.end();
      return;
    }
    if (state.opts.slowCommand && command === state.opts.slowCommand) {
      await new Promise<void>((resolve) => socket.once("close", () => resolve()));
      return;
    }
    try {
      const keepGoing = await dispatch(conn, tag, command, args);
      if (keepGoing === false) return;
    } catch (e) {
      send(`${tag} BAD ${(e as Error).message}`);
    }
  }
}

async function dispatch(conn: Conn, tag: string, command: string, args: Token[]): Promise<boolean | undefined> {
  const { state, send } = conn;
  const { opts } = state;
  const needAuth = (): boolean => {
    if (!conn.authed) {
      send(`${tag} NO Authenticate first`);
      return false;
    }
    return true;
  };
  const needSelected = (): MockMailbox | null => {
    if (!needAuth()) return null;
    if (!conn.selected) {
      send(`${tag} NO Select a mailbox first`);
      return null;
    }
    return conn.selected;
  };

  switch (command) {
    case "CAPABILITY":
      send(`* CAPABILITY ${capabilities(conn)}`);
      send(`${tag} OK CAPABILITY completed`);
      return;
    case "NOOP":
      send(`${tag} OK NOOP completed`);
      return;
    case "LOGOUT":
      send("* BYE Logging out");
      send(`${tag} OK LOGOUT completed`);
      conn.socket.end();
      return false;
    case "STARTTLS": {
      if (!opts.tls || conn.secure) {
        send(`${tag} BAD STARTTLS not available`);
        return;
      }
      send(`${tag} OK Begin TLS negotiation now`);
      const secure = new tls.TLSSocket(conn.socket, { isServer: true, key: opts.tls.key, cert: opts.tls.cert });
      conn.socket = secure;
      conn.reader = new Reader(secure);
      conn.secure = true;
      return;
    }
    case "LOGIN": {
      if (opts.loginDisabled && !conn.secure) {
        send(`${tag} NO [PRIVACYREQUIRED] LOGIN disabled`);
        return;
      }
      const [user, pass] = args.map(textOf);
      state.auth.push({ mechanism: "LOGIN", user, pass });
      if (opts.authFail || !user) {
        send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
        return;
      }
      conn.authed = true;
      send(`${tag} OK [CAPABILITY ${capabilities(conn)}] LOGIN completed`);
      return;
    }
    case "AUTHENTICATE": {
      const mech = String(args[0]).toUpperCase();
      if (opts.loginDisabled && !conn.secure) {
        send(`${tag} NO [PRIVACYREQUIRED] Plaintext authentication disabled`);
        return;
      }
      let payload = args[1] != null ? textOf(args[1]) : null;
      if (payload == null) {
        send("+ ");
        payload = await conn.reader.readLine();
        state.commands.push(`(auth)${payload}`);
      }
      const decoded = Buffer.from(payload, "base64").toString("utf8");
      if (mech === "PLAIN") {
        const [, user, pass] = decoded.split("\0");
        state.auth.push({ mechanism: "PLAIN", user, pass, payload });
        if (opts.authFail || !user) {
          send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
          return;
        }
      } else if (mech === "XOAUTH2") {
        const m = /^user=([^\x01]*)\x01auth=Bearer ([^\x01]*)\x01\x01$/.exec(decoded);
        state.auth.push({ mechanism: "XOAUTH2", user: m?.[1], token: m?.[2], payload });
        if (opts.authFail || !m) {
          // The real protocol: an error JSON challenge, the client answers with
          // an empty line, then the NO arrives.
          send("+ " + Buffer.from('{"status":"400","schemes":"Bearer","scope":"https://mail.google.com/"}').toString("base64"));
          const empty = await conn.reader.readLine();
          state.commands.push(`(auth)${empty}`);
          send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)`);
          return;
        }
      } else {
        send(`${tag} NO Unsupported mechanism`);
        return;
      }
      conn.authed = true;
      send(`${tag} OK [CAPABILITY ${capabilities(conn)}] Authenticated`);
      if (opts.dropAfterLogin) {
        conn.socket.destroy();
        return false;
      }
      return;
    }
    case "LIST": {
      if (!needAuth()) return;
      for (const mb of state.mailboxes) {
        send(`* LIST (${mb.attributes.join(" ")}) "${mb.delimiter}" ${quote(mb.name)}`);
      }
      send(`${tag} OK LIST completed`);
      return;
    }
    case "SELECT":
    case "EXAMINE": {
      if (!needAuth()) return;
      const mb = state.mailboxes.find((m) => m.name === textOf(args[0]));
      if (!mb) {
        send(`${tag} NO [NONEXISTENT] Mailbox does not exist`);
        return;
      }
      conn.selected = mb;
      conn.readOnly = command === "EXAMINE";
      send(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)`);
      send(`* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Flags permitted.`);
      send(`* ${mb.messages.length} EXISTS`);
      send(`* 0 RECENT`);
      send(`* OK [UIDVALIDITY ${mb.uidvalidity}] UIDs valid`);
      send(`* OK [UIDNEXT ${mb.uidnext}] Predicted next UID`);
      send(`${tag} OK [${conn.readOnly ? "READ-ONLY" : "READ-WRITE"}] ${command} completed`);
      return;
    }
    case "UID SEARCH": {
      const mb = needSelected();
      if (!mb) return;
      const result = search(conn, mb, args);
      if ("error" in result) {
        send(`${tag} ${result.error}`);
        return;
      }
      send(`* SEARCH${result.uids.length ? " " + result.uids.join(" ") : ""}`);
      send(`${tag} OK SEARCH completed`);
      return;
    }
    case "UID FETCH": {
      const mb = needSelected();
      if (!mb) return;
      const uids = parseSet(textOf(args[0]) ?? "", mb);
      const second = args[1];
      const items = Array.isArray(second) ? second : args.slice(1);
      for (const uid of uids) {
        const idx = mb.messages.findIndex((m) => m.uid === uid);
        const msg = mb.messages[idx];
        if (idx < 0 || !msg) continue;
        const body = renderItems(fetchItems(msg, items));
        const head = Buffer.from(`* ${idx + 1} FETCH (`);
        if (!opts.silent) process.stdout.write(`  imap-mock > ${head.toString()}${body.toString().slice(0, 200)}…\n`);
        conn.sendRaw(Buffer.concat([head, body, Buffer.from(")\r\n")]));
      }
      send(`${tag} OK FETCH completed`);
      return;
    }
    case "UID STORE": {
      const mb = needSelected();
      if (!mb) return;
      if (conn.readOnly) {
        send(`${tag} NO [READ-ONLY] Mailbox is read-only`);
        return;
      }
      const uids = parseSet(textOf(args[0]) ?? "", mb);
      const op = String(args[1]).toUpperCase();
      const third = args[2];
      const flags = (Array.isArray(third) ? third : args.slice(2)).map(String);
      for (const uid of uids) {
        const idx = mb.messages.findIndex((m) => m.uid === uid);
        const msg = mb.messages[idx];
        if (idx < 0 || !msg) continue;
        if (op.startsWith("+FLAGS")) msg.flags = [...new Set([...msg.flags, ...flags])];
        else if (op.startsWith("-FLAGS")) msg.flags = msg.flags.filter((f) => !flags.includes(f));
        else if (op.startsWith("FLAGS")) msg.flags = [...flags];
        else throw new Error("Unknown STORE operation");
        if (!op.endsWith(".SILENT")) send(`* ${idx + 1} FETCH (UID ${uid} FLAGS (${msg.flags.join(" ")}))`);
      }
      send(`${tag} OK STORE completed`);
      return;
    }
    case "APPEND": {
      if (!needAuth()) return;
      const mb = state.mailboxes.find((m) => m.name === textOf(args[0]));
      if (!mb) {
        send(`${tag} NO [TRYCREATE] Mailbox does not exist`);
        return;
      }
      let i = 1;
      let flags: string[] = [];
      const maybeFlags = args[i];
      if (Array.isArray(maybeFlags)) {
        flags = maybeFlags.map(String);
        i++;
      }
      const maybeDate = args[i];
      if (typeof maybeDate === "string" && /^\d{1,2}-/.test(maybeDate)) i++; // optional date
      const literal = args[i];
      if (!Buffer.isBuffer(literal)) {
        send(`${tag} BAD APPEND needs a literal`);
        return;
      }
      const uid = mb.uidnext++;
      mb.messages.push({ uid, flags, internalDate: new Date(), raw: literal.toString("utf8") });
      if (opts.noUidplus) send(`${tag} OK APPEND completed`);
      else send(`${tag} OK [APPENDUID ${mb.uidvalidity} ${uid}] APPEND completed`);
      return;
    }
    default:
      send(`${tag} BAD Unknown command ${command}`);
      return;
  }
}

// ---------------------------------------------------------------------------
// Message model: headers, MIME parts, ENVELOPE, BODYSTRUCTURE, sections.

function textOf(token: Token | undefined): string | null {
  if (Buffer.isBuffer(token)) return token.toString("utf8");
  return token == null ? null : String(token);
}

function quote(s: string | null | undefined): string {
  if (s == null) return "NIL";
  return `"${s.replace(/[\\"]/g, (c) => "\\" + c)}"`;
}

type Chunk = string | { literal: Buffer };

/** A string as an IMAP string: quoted when it can be, a literal otherwise. */
function imapString(s: string | null): Chunk {
  if (s == null) return "NIL";
  if (/[\r\n\x80-\uffff]/.test(s) || s.includes('"')) return { literal: Buffer.from(s, "utf8") };
  return quote(s);
}

export function splitMessage(raw: string): { header: string; body: string } {
  const idx = raw.indexOf("\r\n\r\n");
  if (idx < 0) return { header: raw.endsWith("\r\n") ? raw : raw + "\r\n", body: "" };
  return { header: raw.slice(0, idx + 2), body: raw.slice(idx + 4) };
}

export interface ParsedHeader {
  name: string;
  value: string;
  raw: string;
}

export function parseHeaders(header: string): ParsedHeader[] {
  const lines = header.split("\r\n").filter((l) => l.length);
  const out: ParsedHeader[] = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (/^[ \t]/.test(line) && last) {
      last.value += " " + line.trim();
      last.raw += "\r\n" + line;
      continue;
    }
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    out.push({ name: m[1] ?? "", value: (m[2] ?? "").trim(), raw: line });
  }
  return out;
}

function headerValue(headers: ParsedHeader[], name: string): string | null {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

interface ContentType {
  type: string;
  subtype: string;
  params: Record<string, string>;
}

function parseContentType(value: string | null): ContentType {
  if (!value) return { type: "text", subtype: "plain", params: { charset: "us-ascii" } };
  const [mime = "", ...rest] = value.split(";");
  const [type = "text", subtype = "plain"] = mime.trim().toLowerCase().split("/");
  const params: Record<string, string> = {};
  for (const p of rest) {
    const m = /^\s*([^=]+)=\s*"?([^"]*)"?\s*$/.exec(p);
    if (m) params[(m[1] ?? "").trim().toLowerCase()] = m[2] ?? "";
  }
  return { type, subtype, params };
}

export interface MimeNode extends ContentType {
  headers: ParsedHeader[];
  header: string;
  body: string;
  encoding: string;
  children: MimeNode[];
}

export function parseMime(raw: string): MimeNode {
  const { header, body } = splitMessage(raw);
  const headers = parseHeaders(header);
  const ct = parseContentType(headerValue(headers, "Content-Type"));
  const node: MimeNode = { headers, header, body, ...ct, encoding: headerValue(headers, "Content-Transfer-Encoding") ?? "7BIT", children: [] };
  const boundary = ct.params["boundary"];
  if (ct.type === "multipart" && boundary) {
    const b = "--" + boundary;
    const segments = body.split(new RegExp(`(?:^|\\r\\n)${escapeRe(b)}(?:--)?(?:\\r\\n|$)`));
    // first segment is the preamble, last is the epilogue
    for (const seg of segments.slice(1, -1)) node.children.push(parseMime(seg));
  }
  return node;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addressesOf(value: string | null): string {
  if (!value) return "NIL";
  const out: string[] = [];
  for (const part of value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const p = part.trim();
    if (!p) continue;
    let m = /^"?([^"<]*?)"?\s*<([^@>]+)@([^>]+)>$/.exec(p);
    if (m) {
      out.push(`(${quote((m[1] ?? "").trim() || null)} NIL ${quote(m[2])} ${quote(m[3])})`);
      continue;
    }
    m = /^([^@\s]+)@(\S+)$/.exec(p);
    if (m) out.push(`(NIL NIL ${quote(m[1])} ${quote(m[2])})`);
  }
  return out.length ? `(${out.join("")})` : "NIL";
}

/** ENVELOPE as a list of chunks (strings and {literal}) so literals can be sent. */
export function envelopeChunks(headers: ParsedHeader[]): Chunk[] {
  const h = (n: string): string | null => headerValue(headers, n);
  const from = addressesOf(h("From"));
  const fields: Chunk[] = [
    imapString(h("Date")),
    imapString(h("Subject")),
    from,
    addressesOf(h("Sender")) === "NIL" ? from : addressesOf(h("Sender")),
    addressesOf(h("Reply-To")) === "NIL" ? from : addressesOf(h("Reply-To")),
    addressesOf(h("To")),
    addressesOf(h("Cc")),
    addressesOf(h("Bcc")),
    imapString(h("In-Reply-To")),
    imapString(h("Message-ID")),
  ];
  return ["(", ...fields.flatMap((f, i): Chunk[] => (i === 0 ? [f] : [" ", f])), ")"];
}

export function bodyStructureOf(node: MimeNode): string {
  if (node.type === "multipart") {
    const kids = node.children.map(bodyStructureOf).join("");
    return `(${kids} ${quote(node.subtype.toUpperCase())} ("BOUNDARY" ${quote(node.params["boundary"])}) NIL NIL NIL)`;
  }
  const params = Object.entries(node.params)
    .map(([k, v]) => `${quote(k.toUpperCase())} ${quote(v)}`)
    .join(" ");
  const size = Buffer.byteLength(node.body);
  const base = `${quote(node.type.toUpperCase())} ${quote(node.subtype.toUpperCase())} ${params ? `(${params})` : "NIL"} ${quote(headerValue(node.headers, "Content-ID"))} NIL ${quote(node.encoding.toUpperCase())} ${size}`;
  const disp = headerValue(node.headers, "Content-Disposition");
  let dispStr = "NIL";
  if (disp) {
    const ct = parseContentType(disp);
    const dp = Object.entries(ct.params)
      .map(([k, v]) => `${quote(k.toUpperCase())} ${quote(v)}`)
      .join(" ");
    dispStr = `(${quote(ct.type.toUpperCase())} ${dp ? `(${dp})` : "NIL"})`;
  }
  if (node.type === "text") {
    const lines = node.body.split("\r\n").length - 1;
    return `(${base} ${lines} NIL ${dispStr} NIL NIL)`;
  }
  return `(${base} NIL ${dispStr} NIL NIL)`;
}

function specKey(spec: Token[]): string {
  return spec.map((t) => (Array.isArray(t) ? `(${t.map(String).join(" ")})` : String(t))).join(" ");
}

function sectionOf(msg: MockMessage, mime: MimeNode, spec: Token[]): string {
  // spec: tokens inside BODY[...]: [] | ["TEXT"] | ["HEADER"] | ["HEADER.FIELDS", [names]] | ["1.2"] | ["1.2.TEXT"]...
  if (msg.sections) {
    const key = specKey(spec);
    const hit = msg.sections[key];
    if (hit !== undefined) return hit;
  }
  if (spec.length === 0) return msg.raw;
  const head = String(spec[0]).toUpperCase();
  if (head === "TEXT") return mime.body;
  if (head === "HEADER") return mime.header + "\r\n";
  if (head === "HEADER.FIELDS") {
    const names = spec[1];
    const wanted = new Set((Array.isArray(names) ? names : []).map((n) => String(n).toLowerCase()));
    return (
      mime.headers
        .filter((h) => wanted.has(h.name.toLowerCase()))
        .map((h) => h.raw)
        .join("\r\n") + "\r\n\r\n"
    );
  }
  const m = /^([\d.]+)(?:\.(TEXT|HEADER|MIME))?$/i.exec(head);
  if (!m) throw new Error(`Unsupported section ${head}`);
  const path = m[1] ?? "";
  let node: MimeNode = mime;
  for (const n of path.split(".")) {
    const i = Number(n) - 1;
    if (node.children.length === 0 && i === 0) {
      // "1" on a single-part message is the body itself
      continue;
    }
    const child = node.children[i];
    if (!child) throw new Error(`No such part ${path}`);
    node = child;
  }
  if (!m[2]) return node.body;
  if (m[2].toUpperCase() === "TEXT") return node.body;
  return node.header + "\r\n";
}

interface RenderedItem {
  key: string;
  value: string | Chunk[];
}

/**
 * FETCH items as a list of {key, value} where value is a string or, for
 * sections and literal-worthy envelope fields, an array of chunks (strings and
 * {literal: Buffer}).
 */
function fetchItems(msg: MockMessage, items: Token[]): RenderedItem[] {
  const mime = parseMime(msg.raw);
  const out: RenderedItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = String(items[i]).toUpperCase();
    if (item === "UID") out.push({ key: "UID", value: String(msg.uid) });
    else if (item === "FLAGS") out.push({ key: "FLAGS", value: `(${msg.flags.join(" ")})` });
    else if (item === "INTERNALDATE") out.push({ key: "INTERNALDATE", value: quote(internalDate(msg.internalDate)) });
    else if (item === "RFC822.SIZE") out.push({ key: "RFC822.SIZE", value: String(Buffer.byteLength(msg.raw)) });
    else if (item === "ENVELOPE") out.push({ key: "ENVELOPE", value: envelopeChunks(mime.headers) });
    else if (item === "BODYSTRUCTURE") out.push({ key: "BODYSTRUCTURE", value: msg.bodystructure ?? bodyStructureOf(mime) });
    else if (item === "BODY.PEEK" || item === "BODY") {
      const next = items[i + 1];
      if (!isBracket(next)) throw new Error("BODY.PEEK without a section");
      const spec = next.bracket;
      i++;
      let partial: { start: number; count: number } | null = null;
      const after = items[i + 1];
      if (typeof after === "string") {
        const pm = /^<(\d+)\.(\d+)>$/.exec(after);
        if (pm) {
          partial = { start: Number(pm[1]), count: Number(pm[2]) };
          i++;
        }
      }
      let data = Buffer.from(sectionOf(msg, mime, spec), "utf8");
      let key = `BODY[${specKey(spec)}]`;
      if (partial) {
        data = data.subarray(partial.start, partial.start + partial.count);
        key += `<${partial.start}>`;
      }
      out.push({ key, value: [{ literal: data }] });
    } else throw new Error(`Unsupported FETCH item ${item}`);
  }
  return out;
}

function renderItems(items: RenderedItem[]): Buffer {
  const bufs: Buffer[] = [];
  items.forEach((it, i) => {
    if (i) bufs.push(Buffer.from(" "));
    bufs.push(Buffer.from(it.key + " "));
    const chunks: Chunk[] = Array.isArray(it.value) ? it.value : [it.value];
    for (const c of chunks) {
      if (typeof c === "string") bufs.push(Buffer.from(c));
      else bufs.push(Buffer.from(`{${c.literal.length}}\r\n`), c.literal);
    }
  });
  return Buffer.concat(bufs);
}

export function internalDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${pad(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${sign}${pad(Math.floor(a / 60))}${pad(a % 60)}`;
}

function parseImapDate(s: string | null): Date {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s ?? "");
  if (!m) throw new Error("Bad date");
  const mon = (m[2] ?? "").toLowerCase();
  return new Date(
    Number(m[3]),
    MONTHS.findIndex((x) => x.toLowerCase() === mon),
    Number(m[1]),
  );
}

function parseSet(set: string, mb: MockMailbox): number[] {
  const uids = mb.messages.map((m) => m.uid);
  const max = Math.max(0, ...uids);
  const out = new Set<number>();
  for (const piece of set.split(",")) {
    const [a = "", b] = piece.split(":");
    const lo = a === "*" ? max : Number(a);
    const hi = b === undefined ? lo : b === "*" ? max : Number(b);
    for (const u of uids) if (u >= Math.min(lo, hi) && u <= Math.max(lo, hi)) out.add(u);
  }
  return [...out].sort((x, y) => x - y);
}

type SearchResult = { uids: number[] } | { error: string };

function search(conn: Conn, mb: MockMailbox, args: Token[]): SearchResult {
  const { opts } = conn.state;
  let i = 0;
  if (String(args[0]).toUpperCase() === "CHARSET") {
    const charset = (textOf(args[1]) ?? "").toUpperCase();
    i = 2;
    if (opts.badCharset && charset !== "US-ASCII") return { error: "NO [BADCHARSET (US-ASCII)] Charset not supported" };
  }
  const preds: Array<(m: MockMessage) => boolean> = [];
  const dayOf = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  while (i < args.length) {
    const key = String(args[i]).toUpperCase();
    const nextText = (): string => (textOf(args[++i]) ?? "").toLowerCase();
    const mime = (m: MockMessage): MimeNode => (m._mime ??= parseMime(m.raw));
    const hdr = (m: MockMessage, n: string): string => (headerValue(mime(m).headers, n) ?? "").toLowerCase();
    switch (key) {
      case "ALL":
        break;
      case "SEEN":
        preds.push((m) => m.flags.includes("\\Seen"));
        break;
      case "UNSEEN":
        preds.push((m) => !m.flags.includes("\\Seen"));
        break;
      case "FLAGGED":
        preds.push((m) => m.flags.includes("\\Flagged"));
        break;
      case "UNFLAGGED":
        preds.push((m) => !m.flags.includes("\\Flagged"));
        break;
      case "FROM": {
        const s = nextText();
        preds.push((m) => hdr(m, "From").includes(s));
        break;
      }
      case "TO": {
        const s = nextText();
        preds.push((m) => hdr(m, "To").includes(s));
        break;
      }
      case "SUBJECT": {
        const s = nextText();
        preds.push((m) => hdr(m, "Subject").includes(s));
        break;
      }
      case "TEXT": {
        const s = nextText();
        preds.push((m) => m.raw.toLowerCase().includes(s));
        break;
      }
      case "SINCE": {
        const d = parseImapDate(textOf(args[++i]));
        preds.push((m) => dayOf(m.internalDate) >= d);
        break;
      }
      case "BEFORE": {
        const d = parseImapDate(textOf(args[++i]));
        preds.push((m) => dayOf(m.internalDate) < d);
        break;
      }
      case "UID": {
        const set = parseSet(textOf(args[++i]) ?? "", mb);
        preds.push((m) => set.includes(m.uid));
        break;
      }
      default:
        return { error: `BAD Unsupported search key ${key}` };
    }
    i++;
  }
  const uids = mb.messages
    .filter((m) => preds.every((p) => p(m)))
    .map((m) => m.uid)
    .sort((a, b) => a - b);
  return { uids };
}

export interface SimpleMessageOptions {
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  messageId?: string;
  body?: string;
  extraHeaders?: string;
  contentType?: string;
}

/** Helper for tests: a small RFC 5322 message. */
export function simpleMessage({
  from = "Alice <alice@example.com>",
  to = "bob@example.com",
  subject = "Hello",
  date = "Mon, 3 Mar 2025 10:00:00 +0000",
  messageId,
  body = "Hi Bob",
  extraHeaders = "",
  contentType,
}: SimpleMessageOptions = {}): string {
  const id = messageId ?? `<${Math.random().toString(36).slice(2)}@example.com>`;
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: ${id}`,
    "MIME-Version: 1.0",
    `Content-Type: ${contentType ?? "text/plain; charset=utf-8"}`,
    ...(extraHeaders ? [extraHeaders] : []),
    "",
    body,
    "",
  ].join("\r\n");
}

export { utf7Encode };
