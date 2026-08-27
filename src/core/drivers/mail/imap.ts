/**
 * A small IMAP client over an egress-vetted socket.
 *
 * Why hand-rolled: the network door a Yap driver gets is `ctx.egress.connect()`,
 * which hands back an already-connected socket, and no IMAP library accepts an
 * injected socket. So this speaks the subset the mail actions need — LIST,
 * SELECT/EXAMINE, UID SEARCH, UID FETCH, UID STORE, UID EXPUNGE,
 * APPEND — and nothing more.
 * It is a client for *this driver*, not a library: every method maps onto one
 * action need and returns already-shaped data (decoded folder names, parsed
 * envelopes, a BODYSTRUCTURE tree) so the actions layer never sees a token.
 *
 * The wire details that matter:
 *
 * - Commands are tagged A1, A2, … and run one at a time. Everything untagged
 *   that arrives before the tagged reply is collected for that command; a
 *   method picks out the types it cares about and ignores the rest, which is
 *   how EXISTS/EXPUNGE/FETCH noise from the server stays harmless.
 * - Literals go both ways. Inbound, the tokenizer pauses at `{n}` and the
 *   bytes are pulled with `reader.readBytes(n)` (capped by the reader).
 *   Outbound (APPEND, non-ASCII SEARCH) the line ends in `{n}`, the server
 *   must answer `+`, and only then do the bytes go out — a server that says NO
 *   instead gets no bytes.
 * - Credentials never go over a plaintext connection unless the operator set
 *   `allow_plaintext_auth` (lab servers), and never when the server advertises
 *   LOGINDISABLED. STARTTLS is only attempted when advertised; with
 *   `security: "starttls"` its absence is an error, not a silent downgrade.
 * - `ctx.log` gets every command and every tagged reply. Credentials are
 *   redacted before logging and literals are summarised by size — a log line
 *   must never contain a password or a message body.
 *
 * Errors are `ProtocolError`s (from net.ts) carrying `step` and the raw
 * `reply`. Where the failure is the caller's own input — a folder or message
 * that does not exist, a server that cannot search non-ASCII text — the error
 * also carries `agent: "not_found" | "invalid_request"`, the hint the actions
 * layer turns into `ctx.fail` so the agent sees a useful message instead of a
 * flat "run failed".
 *
 * `deps` exists for the tests: `openLine`, `resolveAuth`, `xoauth2Payload` and
 * `ProtocolError` default to the sibling modules but can be replaced so the
 * client can be exercised without the egress layer.
 */

import libmime from "libmime";

import type { AuthConfig, ResolvedAuth, resolveAuth as resolveAuthImpl, xoauth2Payload as xoauth2PayloadImpl } from "./auth.js";
import type { ProtocolBlock } from "./config.js";
import {
  Tokenizer,
  parseResponse,
  parseEnvelope,
  parseBodyStructure,
  utf7Encode,
  utf7Decode,
  str,
  isBracket,
  type BodyPart,
  type Envelope,
  type ParsedResponse,
  type Token,
} from "./imap-parse.js";
import type { LineConnection, MailCtx, ProtocolError, openLine as openLineImpl } from "./net.js";

const CONNECT_TIMEOUT_MS = 15_000;
/** How many UIDs one FETCH may name; longer sets are split. */
const FETCH_BATCH = 100;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export type { MailCtx } from "./net.js";

/** The `ProtocolError` class as the client needs it: constructible with
 * `{step, reply, ...extra}` and carrying those as own properties. */
export type ProtocolErrorCtor = typeof ProtocolError;

/** The slice of the mail config the IMAP side reads: credentials for
 * `resolveAuth`, the endpoint, and the plaintext-auth opt-in. A full
 * `MailConfig` satisfies it. */
export interface ImapConnectConfig extends AuthConfig {
  imap?: ProtocolBlock;
  allow_plaintext_auth?: boolean;
}

export interface ImapDeps {
  openLine: typeof openLineImpl;
  resolveAuth: typeof resolveAuthImpl;
  xoauth2Payload: typeof xoauth2PayloadImpl;
  ProtocolError: ProtocolErrorCtor;
}

async function defaultDeps(): Promise<ImapDeps> {
  const [net, auth] = await Promise.all([import("./net.js"), import("./auth.js")]);
  return {
    openLine: net.openLine,
    ProtocolError: net.ProtocolError,
    resolveAuth: auth.resolveAuth,
    xoauth2Payload: auth.xoauth2Payload,
  };
}

/**
 * Connect and authenticate. `config` is the driver config: `user`/`pass` (or
 * the oauth2 block that resolveAuth understands), `imap: {host, port,
 * security}`, and `allow_plaintext_auth`.
 */
export async function imapConnect(ctx: MailCtx, config: ImapConnectConfig, deps: Partial<ImapDeps> = {}): Promise<ImapClient> {
  const d: ImapDeps = { ...(await defaultDeps()), ...deps };
  const ProtocolError = d.ProtocolError;
  const imap = config.imap;
  if (!imap) throw new Error("imapConnect: the config has no imap block");
  const security = imap.security;

  ctx.log(`imap: connecting to ${imap.host}:${imap.port} (${security})`);
  const conn = await d.openLine(ctx, { host: imap.host, port: imap.port, security, connectTimeoutMs: CONNECT_TIMEOUT_MS });
  const client = new ImapClient(ctx, conn, ProtocolError);
  try {
    const greeting = await client.readGreeting();
    if (!client.capabilities.size) await client.refreshCapabilities();

    if (security === "starttls") {
      if (!client.capabilities.has("STARTTLS")) {
        throw new ProtocolError('the server does not offer STARTTLS; use security "tls" on the TLS port or "none" for a plaintext lab server', {
          step: "STARTTLS",
        });
      }
      await client.command("STARTTLS");
      ctx.log("imap: STARTTLS upgrade");
      await conn.startTls();
      client.secure = true;
      await client.refreshCapabilities();
    } else {
      client.secure = security === "tls";
    }

    if (greeting.type !== "PREAUTH") {
      const auth = await d.resolveAuth(ctx, config);
      if (!auth) {
        throw new ProtocolError("the server requires authentication but the config carries no credentials (user/pass or oauth2)", {
          step: "AUTHENTICATE",
        });
      }
      await client.authenticate(auth, { allowPlaintext: config.allow_plaintext_auth === true, xoauth2Payload: d.xoauth2Payload });
    } else {
      ctx.log("imap: PREAUTH greeting, no authentication needed");
    }
    return client;
  } catch (e) {
    conn.close();
    throw e;
  }
}

export interface MailboxInfo {
  /** Decoded (modified UTF-7 → Unicode) folder name. */
  name: string;
  /** The name as it is on the wire; what SELECT/APPEND must be given. */
  raw: string;
  delimiter: string | null;
  attributes: string[];
}

export interface SelectInfo {
  folder: string;
  exists: number;
  uidvalidity: number | null;
  flags: string[];
  readOnly: boolean;
}

export interface Summary {
  uid: number;
  flags: string[];
  internalDate: Date | null;
  size: number | null;
  envelope: Envelope | null;
}

export interface FetchedSection {
  spec: Token[];
  offset: number;
  data: Buffer;
}

export interface FetchRow {
  uid: number;
  items: FetchItems;
  sections: FetchedSection[];
}

/** Flattened FETCH items keyed by upper-cased item name. */
export interface FetchItems {
  [key: string]: Token | undefined;
}

export type SearchCriterion = string | { literal: string };

interface CommandOptions {
  literal?: Buffer;
  onContinue?: (text: string) => Promise<string>;
  logLine?: string;
  step?: string;
}

interface CommandResult {
  tagged: ParsedResponse;
  untagged: ParsedResponse[];
}

export class ImapClient {
  capabilities = new Set<string>();
  closed = false;
  secure = false;
  selected: SelectInfo | null = null;
  private tagCounter = 0;
  private busy: Promise<void> | null = null;
  private lastTagged: ParsedResponse | null = null;

  constructor(
    private readonly ctx: MailCtx,
    private readonly conn: LineConnection,
    private readonly ProtocolError: ProtocolErrorCtor,
  ) {}

  // --- transport -----------------------------------------------------------

  /** `extra` rides on the error as own properties; `agent` is the hint the
   * actions layer turns into `ctx.fail` ("not_found" / "invalid_request"). */
  private fail(message: string, step?: string, reply?: string, extra?: Record<string, unknown>): ProtocolError {
    return new this.ProtocolError(message, { step, reply, ...extra });
  }

  /** Read one complete response, resolving server literals. */
  private async readResponse(): Promise<ParsedResponse> {
    const t = new Tokenizer();
    const line: string | undefined | null = await this.conn.reader.nextLine();
    if (line === undefined || line === null) throw this.fail("connection closed by the server", "read");
    let res = t.feed(line);
    while (res.literal !== undefined) {
      t.feedLiteral(await this.conn.reader.readBytes(res.literal));
      res = t.feed(await this.conn.reader.nextLine());
    }
    const parsed = parseResponse(t.tokens);
    parsed.raw = line;
    return parsed;
  }

  async readGreeting(): Promise<ParsedResponse> {
    const g = await this.readResponse();
    this.ctx.log(`imap: < ${summarise(g.raw ?? "")}`);
    if (g.tag !== "*" || !["OK", "PREAUTH"].includes(g.type)) {
      throw this.fail(`unexpected IMAP greeting: ${g.type === "BYE" ? "BYE " : ""}${g.text || g.raw}`, "greeting", g.raw);
    }
    if (g.code === "CAPABILITY") this.setCapabilities(g.codeArgs ?? []);
    return g;
  }

  private setCapabilities(atoms: Token[]): void {
    this.capabilities = new Set(atoms.filter((a): a is string => typeof a === "string").map((a) => a.toUpperCase()));
  }

  async refreshCapabilities(): Promise<void> {
    const { untagged } = await this.command("CAPABILITY");
    const cap = untagged.find((u) => u.type === "CAPABILITY");
    if (cap) this.setCapabilities(cap.data);
  }

  /**
   * Send one command and collect its responses. `literal` is sent after the
   * server's `+`; `onContinue` handles other continuation requests (SASL).
   * Resolves {tagged, untagged}; rejects with ProtocolError on NO/BAD/BYE.
   */
  async command(line: string, { literal, onContinue, logLine, step }: CommandOptions = {}): Promise<CommandResult> {
    if (this.closed) throw this.fail("the IMAP connection is closed", step ?? line.split(" ")[0]);
    if (this.busy) await this.busy.catch(() => {});
    let release: () => void = () => {};
    this.busy = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const tag = `A${++this.tagCounter}`;
      const stepName = step ?? line.split(" ").slice(0, line.startsWith("UID ") ? 2 : 1).join(" ");
      const wire = literal ? `${line} {${literal.length}}` : line;
      this.ctx.log(`imap: > ${tag} ${logLine ?? wire}`);
      this.conn.write(`${tag} ${wire}`);
      let literalSent = !literal;
      const untagged: ParsedResponse[] = [];
      for (;;) {
        const res = await this.readResponse();
        if (res.tag === "+") {
          if (!literalSent && literal) {
            this.conn.writeRaw(literal);
            this.conn.write("");
            literalSent = true;
          } else if (onContinue) {
            const answer = await onContinue(res.text ?? "");
            this.conn.write(answer);
          } else {
            throw this.fail("unexpected continuation request", stepName, res.raw);
          }
          continue;
        }
        if (res.tag === "*") {
          if (res.type === "BYE") {
            this.closed = true;
            this.conn.close();
            throw this.fail(`the server closed the connection: BYE ${res.text}`, stepName, res.raw);
          }
          untagged.push(res);
          continue;
        }
        if (res.tag !== tag) throw this.fail(`unexpected tagged reply ${res.tag}`, stepName, res.raw);
        this.ctx.log(`imap: < ${summarise(res.raw ?? "")}`);
        this.lastTagged = res;
        if (res.type !== "OK") {
          throw this.fail(`${stepName} failed: ${res.text || res.type}`, stepName, res.raw, { code: res.code, codeArgs: res.codeArgs });
        }
        return { tagged: res, untagged };
      }
    } catch (e) {
      if (!(e instanceof this.ProtocolError) || e.step === "read") {
        // A transport failure (abort, EOF, cap exceeded) leaves the session
        // unusable: nothing below can trust the stream position any more.
        this.closed = true;
        this.conn.close();
      }
      throw e;
    } finally {
      release();
    }
  }

  // --- authentication ------------------------------------------------------

  async authenticate(
    auth: NonNullable<ResolvedAuth>,
    { allowPlaintext, xoauth2Payload }: { allowPlaintext: boolean; xoauth2Payload: ImapDeps["xoauth2Payload"] },
  ): Promise<void> {
    const caps = this.capabilities;
    if (caps.has("LOGINDISABLED")) {
      throw this.fail("the server advertises LOGINDISABLED on this connection; credentials were not sent (use TLS or STARTTLS)", "AUTHENTICATE");
    }
    if (!this.secure && !allowPlaintext) {
      throw this.fail("refusing to send credentials over a plaintext connection (set allow_plaintext_auth: true for a lab server)", "AUTHENTICATE");
    }
    const authFailed = (e: unknown): unknown => {
      if (e instanceof this.ProtocolError && e.reply) {
        return this.fail(`authentication failed: ${e.reply.replace(/^\S+\s+\S+\s*/, "")}`, e.step, e.reply, { code: e["code"] });
      }
      return e;
    };
    try {
      if (auth.kind === "xoauth2") {
        const payload = xoauth2Payload(auth.user, auth.token);
        let challenged = false;
        await this.command("AUTHENTICATE XOAUTH2", {
          logLine: "AUTHENTICATE XOAUTH2",
          onContinue: async (text) => {
            if (!challenged) {
              challenged = true;
              this.ctx.log("imap: > [xoauth2 payload redacted]");
              return payload;
            }
            // The second challenge carries an error JSON; an empty line makes
            // the server finish with its NO.
            const detail = Buffer.from(text, "base64").toString("utf8");
            this.ctx.log(`imap: xoauth2 error challenge ${summarise(detail)}`);
            return "";
          },
        });
      } else if (caps.has("AUTH=PLAIN")) {
        const payload = Buffer.from(`\0${auth.user}\0${auth.pass}`, "utf8").toString("base64");
        await this.command("AUTHENTICATE PLAIN", {
          logLine: "AUTHENTICATE PLAIN",
          onContinue: async () => {
            this.ctx.log("imap: > [plain payload redacted]");
            return payload;
          },
        });
      } else {
        await this.command(`LOGIN ${quote(auth.user)} ${quote(auth.pass)}`, { logLine: `LOGIN ${quote(auth.user)} [redacted]` });
      }
    } catch (e) {
      throw authFailed(e);
    }
    this.ctx.log(`imap: authenticated as ${auth.user}`);
    // Servers typically report post-login capabilities in the OK's code; if
    // not, ask once — the CAPABILITY set differs before and after login.
    const last = this.lastTagged;
    if (last?.code === "CAPABILITY") this.setCapabilities(last.codeArgs ?? []);
    else await this.refreshCapabilities();
  }

  // --- mailbox operations --------------------------------------------------

  async noop(): Promise<void> {
    await this.command("NOOP");
  }

  async list(): Promise<MailboxInfo[]> {
    const { untagged } = await this.command('LIST "" "*"');
    const out: MailboxInfo[] = [];
    for (const u of untagged) {
      if (u.type !== "LIST") continue;
      const [attrs, delimiter, name] = u.data;
      const raw = str(name);
      if (raw == null) continue;
      out.push({
        name: utf7Decode(raw),
        raw,
        delimiter: str(delimiter),
        attributes: (Array.isArray(attrs) ? attrs : []).filter((a): a is string => typeof a === "string"),
      });
    }
    return out;
  }

  async select(folder: string, { readOnly = false }: { readOnly?: boolean } = {}): Promise<SelectInfo> {
    const verb = readOnly ? "EXAMINE" : "SELECT";
    const { tagged, untagged } = await this.command(`${verb} ${quote(utf7Encode(folder))}`, { step: verb }).catch((e: unknown) => {
      // A NO here is, in practice, "no such mailbox" — and the name is the
      // caller's own input, so it is safe to hand back to the agent.
      if (e instanceof this.ProtocolError && e.reply && /^\S+ NO\b/.test(e.reply)) {
        throw this.fail(`folder ${JSON.stringify(folder)} not found`, verb, e.reply, { agent: "not_found" });
      }
      throw e;
    });
    const info: SelectInfo = { folder, exists: 0, uidvalidity: null, flags: [], readOnly: tagged.code === "READ-ONLY" || readOnly };
    for (const u of untagged) {
      if (u.type === "EXISTS") info.exists = u.number ?? 0;
      else if (u.type === "FLAGS") {
        const list = u.data[0];
        info.flags = (Array.isArray(list) ? list : []).filter((f): f is string => typeof f === "string");
      } else if (u.type === "OK" && u.code === "UIDVALIDITY") info.uidvalidity = Number(str(u.codeArgs?.[0]));
    }
    this.selected = info;
    return info;
  }

  /**
   * UID SEARCH. `criteria` is a flat list of already-formatted IMAP tokens
   * (`"SINCE"`, `"1-Feb-2025"`, `'"alice"'`); wrap user-supplied text as
   * `{literal: text}` and the client quotes it when it can and sends a literal
   * (with CHARSET UTF-8) when it contains non-ASCII, quotes or line breaks.
   */
  async search(criteria: SearchCriterion[], { charset }: { charset?: string } = {}): Promise<number[]> {
    const parts: Array<string | null> = [];
    let literal: Buffer | null = null;
    let needsUtf8 = false;
    for (const c of criteria) {
      if (typeof c === "object") {
        const text = String(c.literal);
        if (/^[\x20-\x7e]*$/.test(text) && !/["\\]/.test(text)) {
          parts.push(quote(text));
        } else {
          if (literal) throw new Error("search: only one literal criterion is supported per command");
          literal = Buffer.from(text, "utf8");
          needsUtf8 = needsUtf8 || /[^\x00-\x7f]/.test(text);
          parts.push(null); // placeholder: the literal ends the line
        }
      } else {
        parts.push(String(c));
      }
    }
    if (literal && parts.indexOf(null) !== parts.length - 1) {
      throw new Error("search: a literal criterion must be the last one");
    }
    const cs = charset ?? (needsUtf8 ? "UTF-8" : null);
    const head = ["UID SEARCH", ...(cs ? ["CHARSET", cs] : []), ...parts.filter((p): p is string => p !== null)].join(" ");
    let res: CommandResult;
    try {
      res = await this.command(head, { literal: literal ?? undefined, step: "UID SEARCH" });
    } catch (e) {
      if (e instanceof this.ProtocolError && e["code"] === "BADCHARSET") {
        throw this.fail("the server cannot search non-ASCII text (NO [BADCHARSET])", "UID SEARCH", e.reply, { agent: "invalid_request" });
      }
      throw e;
    }
    const uids: number[] = [];
    for (const u of res.untagged) {
      if (u.type !== "SEARCH") continue;
      for (const n of u.data) if (typeof n === "string" && /^\d+$/.test(n)) uids.push(Number(n));
    }
    return uids.sort((a, b) => a - b);
  }

  /**
   * Run UID FETCH over batches; returns [{uid, items, sections}] where items
   * is {KEY: value} and sections lists BODY[...] payloads in order.
   */
  private async fetchRaw(uids: number[], itemSpec: string, { step = "UID FETCH" }: { step?: string } = {}): Promise<FetchRow[]> {
    const unique = [...new Set(uids.map(Number))].sort((a, b) => a - b);
    const rows: FetchRow[] = [];
    for (let i = 0; i < unique.length; i += FETCH_BATCH) {
      const batch = unique.slice(i, i + FETCH_BATCH);
      const { untagged } = await this.command(`UID FETCH ${uidSet(batch)} (${itemSpec})`, { step });
      for (const u of untagged) {
        const list = u.data[0];
        if (u.type !== "FETCH" || !Array.isArray(list)) continue;
        const { items, sections } = fetchItems(list);
        const uid = items["UID"] != null ? Number(str(items["UID"])) : null;
        if (uid == null || !batch.includes(uid)) continue; // unsolicited FETCH noise
        rows.push({ uid, items, sections });
      }
    }
    return rows;
  }

  async fetchSummaries(uids: number[]): Promise<Summary[]> {
    if (!uids.length) return [];
    const rows = await this.fetchRaw(uids, "UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE");
    return rows.map(({ uid, items }) => {
      const flags = items["FLAGS"];
      const size = items["RFC822.SIZE"];
      const envelope = items["ENVELOPE"];
      return {
        uid,
        flags: (Array.isArray(flags) ? flags : []).filter((f): f is string => typeof f === "string"),
        internalDate: parseInternalDate(str(items["INTERNALDATE"])),
        size: size == null ? null : Number(str(size)),
        envelope: Array.isArray(envelope) ? parseEnvelope(envelope) : null,
      };
    });
  }

  async fetchHeaders(uid: number, fields: string[]): Promise<Record<string, string>> {
    const spec = `UID BODY.PEEK[HEADER.FIELDS (${fields.join(" ")})]`;
    const [row] = await this.fetchRaw([uid], spec);
    if (!row) throw this.fail(`message ${uid} not found`, "UID FETCH", undefined, { agent: "not_found" });
    const section = row.sections[0]?.data ?? Buffer.alloc(0);
    return parseHeaderBlock(section.toString("utf8"));
  }

  async fetchStructure(uid: number): Promise<BodyPart> {
    const [row] = await this.fetchRaw([uid], "UID BODYSTRUCTURE");
    if (!row) throw this.fail(`message ${uid} not found`, "UID FETCH", undefined, { agent: "not_found" });
    const structure = row.items["BODYSTRUCTURE"];
    if (!Array.isArray(structure)) throw this.fail(`no BODYSTRUCTURE for message ${uid}`, "UID FETCH");
    return parseBodyStructure(structure);
  }

  /**
   * Fetch one section (e.g. "1", "2.1", "TEXT", "HEADER") capped at maxBytes.
   * `truncated` is true when the server returned exactly maxBytes and the
   * part is known (or assumed) to be larger; pass `size` from the structure
   * to make that exact.
   */
  async fetchSection(uid: number, section: string, { maxBytes, size }: { maxBytes: number; size?: number | null }): Promise<{ buffer: Buffer; truncated: boolean }> {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error("fetchSection: maxBytes is required");
    const [row] = await this.fetchRaw([uid], `UID BODY.PEEK[${section}]<0.${maxBytes}>`);
    if (!row) throw this.fail(`message ${uid} not found`, "UID FETCH", undefined, { agent: "not_found" });
    const buffer = row.sections[0]?.data ?? Buffer.alloc(0);
    const truncated = buffer.length >= maxBytes && (size == null || size > maxBytes);
    this.ctx.log(`imap: section ${section} of ${uid}: ${buffer.length} bytes${truncated ? " (truncated)" : ""}`);
    return { buffer, truncated };
  }

  async store(uid: number, op: "+FLAGS" | "-FLAGS", flags: string[]): Promise<string[]> {
    if (op !== "+FLAGS" && op !== "-FLAGS") throw new Error(`store: unsupported operation ${String(op)}`);
    const { untagged } = await this.command(`UID STORE ${uid} ${op} (${flags.join(" ")})`, { step: "UID STORE" });
    for (const u of untagged) {
      const list = u.data[0];
      if (u.type !== "FETCH" || !Array.isArray(list)) continue;
      const { items } = fetchItems(list);
      if (Number(str(items["UID"])) !== Number(uid)) continue;
      const got = items["FLAGS"];
      return (Array.isArray(got) ? got : []).filter((f): f is string => typeof f === "string");
    }
    throw this.fail(`message ${uid} not found`, "UID STORE", undefined, { agent: "not_found" });
  }

  async deleteDraft(folder: string, uid: number): Promise<void> {
    if (!this.capabilities.has("UIDPLUS")) {
      throw this.fail("delete_draft requires the IMAP UIDPLUS capability for UID EXPUNGE", "UID EXPUNGE", undefined, { agent: "invalid_request" });
    }
    await this.select(folder, { readOnly: false });
    await this.store(uid, "+FLAGS", ["\\Deleted"]);
    await this.command(`UID EXPUNGE ${uid}`, { step: "UID EXPUNGE" });
  }

  async append(folder: string, message: Buffer, flags: string[] = []): Promise<{ uid: number | null }> {
    const flagPart = flags.length ? ` (${flags.join(" ")})` : "";
    const line = `APPEND ${quote(utf7Encode(folder))}${flagPart}`;
    const { tagged } = await this.command(line, { literal: message, logLine: `${line} {${message.length} bytes}` });
    const appendUid = tagged.codeArgs?.[1];
    if (tagged.code === "APPENDUID" && appendUid != null) {
      return { uid: Number(str(appendUid)) };
    }
    return { uid: null };
  }

  async logout(): Promise<void> {
    if (this.closed) return;
    try {
      await this.command("LOGOUT");
    } catch {
      // BYE arrives before the tagged OK and is reported as a ProtocolError;
      // for LOGOUT that is the expected shape of success.
    } finally {
      this.closed = true;
      this.conn.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers

/**
 * Flatten a FETCH item list into {KEY: value}. `BODY[spec]<n>` entries are
 * collected under `sections` because the bracket group and the optional
 * offset atom are separate tokens.
 */
function fetchItems(list: Token[]): { items: FetchItems; sections: FetchedSection[] } {
  const items: FetchItems = {};
  const sections: FetchedSection[] = [];
  for (let i = 0; i < list.length; i++) {
    const cur = list[i];
    const key = typeof cur === "string" ? cur.toUpperCase() : null;
    const next = list[i + 1];
    if (key === "BODY" && isBracket(next)) {
      const spec = next.bracket;
      let j = i + 2;
      let offset = 0;
      const maybeOffset = list[j];
      if (typeof maybeOffset === "string" && /^<\d+>$/.test(maybeOffset)) {
        offset = Number(maybeOffset.slice(1, -1));
        j++;
      }
      const payload = list[j];
      const data = Buffer.isBuffer(payload) ? payload : Buffer.from(str(payload) ?? "", "utf8");
      sections.push({ spec, offset, data });
      i = j;
      continue;
    }
    if (key == null) continue;
    items[key] = next;
    i++;
  }
  return { items, sections };
}

/** Compact UID set: [1,2,3,5] → "1:3,5". */
export function uidSet(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === (sorted[j] as number) + 1) j++;
    parts.push(j > i ? `${sorted[i]}:${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(",");
}

/** Quoted-string form. CR/LF/NUL cannot be quoted and would split the
 * command, so they are refused here — callers validate earlier; this is the
 * last line of defence. */
export function quote(s: string): string {
  const text = String(s);
  if (/[\r\n\0]/.test(text)) throw new Error("quote: a quoted string cannot contain a line break or NUL");
  return `"${text.replace(/[\\"]/g, (c) => "\\" + c)}"`;
}

/** "10-Jan-2025 09:00:00 +0100" → Date (null when unparsable). */
export function parseInternalDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const [, day, mon, year, hh, mm, ss, sign, offH, offM] = m;
  const month = MONTHS.indexOf((mon ?? "").toLowerCase());
  if (month < 0) return null;
  const utc = Date.UTC(Number(year), month, Number(day), Number(hh), Number(mm), Number(ss));
  const offsetMin = (sign === "-" ? -1 : 1) * (Number(offH) * 60 + Number(offM));
  return new Date(utc - offsetMin * 60_000);
}

/** A HEADER.FIELDS block → {lowercased name: unfolded, RFC 2047-decoded value}. */
export function parseHeaderBlock(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = text.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const m = /^([!-9;-~]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1] ?? "";
    let value = (m[2] ?? "").trim();
    try {
      value = libmime.decodeWords(value);
    } catch {
      // keep the raw value
    }
    out[name.toLowerCase()] = value;
  }
  return out;
}

/** One log-safe line: long lines cut, control characters escaped. */
function summarise(line: string, max = 300): string {
  const clean = String(line).replace(/[\x00-\x1f\x7f]/g, " ");
  return clean.length > max ? `${clean.slice(0, max)}… (${clean.length} chars)` : clean;
}
