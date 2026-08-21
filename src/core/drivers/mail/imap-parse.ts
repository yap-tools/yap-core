/**
 * IMAP response grammar, the parts of it this driver needs.
 *
 * IMAP is a line protocol only until it is not: a response line may end in a
 * literal marker `{n}` after which the server sends n raw bytes and then the
 * *rest of the same logical response* on a new line, possibly with another
 * literal. The Tokenizer here is therefore resumable — `feed(line)` either
 * finishes or reports the literal it needs, the caller (imap.ts) pulls the
 * bytes off the socket and hands them back with `feedLiteral`, then feeds the
 * continuation line. `tokenize(line)` is the one-shot convenience for lines
 * without literals; it still returns a `{literal: n}` marker at the end so the
 * caller can tell what happened.
 *
 * Tokens are plain values so the rest of the code can pattern-match with
 * array indexing: atoms and quoted strings are strings, NIL is null, lists are
 * arrays, literals are Buffers (bytes are not always text — a fetched section
 * is binary until its transfer encoding is undone), `[...]` groups are
 * `{bracket: tokens}` (response codes and BODY[section] specs both live there)
 * and the free-text tail of a status line is `{text}`. Numbers stay strings
 * because IMAP numbers are only numbers by position; the client converts where
 * it knows.
 *
 * The ENVELOPE and BODYSTRUCTURE readers turn RFC 3501 §7.4.2's positional
 * lists into named trees. BODYSTRUCTURE in particular is the reason the `read`
 * action can show a message without downloading it: the tree carries sizes,
 * types and section numbers, so the client fetches exactly one text part.
 */

import libmime from "libmime";

const STATUS_WORDS = new Set(["OK", "NO", "BAD", "PREAUTH", "BYE"]);
const ATOM_TERMINATORS = new Set([" ", "(", ")", "[", "]", "{", '"']);

export type Token = string | null | Buffer | Token[] | BracketToken | LiteralToken | TextToken;
export interface BracketToken {
  bracket: Token[];
}
export interface LiteralToken {
  literal: number;
}
export interface TextToken {
  text: string;
}

export function isBracket(t: Token | undefined): t is BracketToken {
  return typeof t === "object" && t !== null && !Array.isArray(t) && !Buffer.isBuffer(t) && "bracket" in t;
}
export function isText(t: Token | undefined): t is TextToken {
  return typeof t === "object" && t !== null && !Array.isArray(t) && !Buffer.isBuffer(t) && "text" in t;
}
export function isList(t: Token | undefined): t is Token[] {
  return Array.isArray(t);
}

interface Frame {
  arr: Token[];
  kind: "root" | "list" | "bracket";
}

export type FeedResult = { literal: number; done?: undefined } | { done: true; literal?: undefined };

export class Tokenizer {
  tokens: Token[] = [];
  // Each frame is {arr, kind}; kind "list" closes on ")", "bracket" on "]".
  private stack: Frame[] = [{ arr: this.tokens, kind: "root" }];
  private pendingLiteral: { arr: Token[] } | null = null; // token slot awaiting its bytes
  done = false;

  private get current(): Frame {
    const top = this.stack[this.stack.length - 1];
    if (!top) throw new Error("IMAP parser: empty stack");
    return top;
  }

  feedLiteral(buffer: Buffer): void {
    if (!this.pendingLiteral) throw new Error("IMAP parser: no literal pending");
    const arr = this.pendingLiteral.arr;
    arr[arr.length - 1] = buffer;
    this.pendingLiteral = null;
  }

  /** Feed one CRLF-stripped line. Returns {literal: n} or {done: true}. */
  feed(line: string): FeedResult {
    if (this.done) throw new Error("IMAP parser: response already complete");
    if (this.pendingLiteral) throw new Error("IMAP parser: literal bytes expected before more text");
    let i = 0;
    const n = line.length;
    while (i < n) {
      const ch = line[i];
      if (ch === " ") {
        i++;
        continue;
      }
      // Status lines (tag + OK/NO/BAD/PREAUTH/BYE) and continuation requests
      // carry free text after an optional [code]; the text is not tokens.
      if (this.stack.length === 1 && this.isAtTextPosition() && ch !== "[") {
        this.tokens.push({ text: line.slice(i).trim() });
        i = n;
        break;
      }
      if (ch === "(") {
        const arr: Token[] = [];
        this.current.arr.push(arr);
        this.stack.push({ arr, kind: "list" });
        i++;
      } else if (ch === ")") {
        if (this.current.kind !== "list") throw new Error("IMAP parser: unbalanced ')'");
        this.stack.pop();
        i++;
      } else if (ch === "[") {
        const arr: Token[] = [];
        this.current.arr.push({ bracket: arr });
        this.stack.push({ arr, kind: "bracket" });
        i++;
      } else if (ch === "]") {
        if (this.current.kind !== "bracket") throw new Error("IMAP parser: unbalanced ']'");
        this.stack.pop();
        i++;
        if (this.stack.length === 1 && this.isAtTextPosition(true)) {
          this.tokens.push({ text: line.slice(i).trim() });
          i = n;
        }
      } else if (ch === '"') {
        let j = i + 1;
        let out = "";
        for (;;) {
          if (j >= n) throw new Error("IMAP parser: unterminated quoted string");
          const c = line[j];
          if (c === "\\") {
            if (j + 1 >= n) throw new Error("IMAP parser: unterminated quoted string");
            out += line[j + 1];
            j += 2;
          } else if (c === '"') {
            j++;
            break;
          } else {
            out += c;
            j++;
          }
        }
        this.current.arr.push(out);
        i = j;
      } else if (ch === "{") {
        const m = /^\{(\d+)\+?\}$/.exec(line.slice(i));
        if (!m) throw new Error("IMAP parser: literal marker must end the line");
        const size = Number(m[1]);
        const arr = this.current.arr;
        arr.push({ literal: size });
        this.pendingLiteral = { arr };
        return { literal: size };
      } else {
        let j = i;
        while (j < n && !ATOM_TERMINATORS.has(line[j] as string)) j++;
        const atom = line.slice(i, j);
        this.current.arr.push(atom.toUpperCase() === "NIL" ? null : atom);
        i = j;
      }
    }
    if (this.stack.length !== 1) throw new Error("IMAP parser: unbalanced parentheses at end of line");
    if (this.isAtTextPosition() || this.isAtTextPosition(true)) this.tokens.push({ text: "" });
    this.done = true;
    return { done: true };
  }

  /** True when the next thing on a root-level line is the status text. */
  private isAtTextPosition(afterCode = false): boolean {
    const t = this.tokens;
    if (t.length === 1 && t[0] === "+") return true;
    const second = t[1];
    if (afterCode) {
      return t.length === 3 && typeof second === "string" && STATUS_WORDS.has(second.toUpperCase()) && isBracket(t[2]);
    }
    return t.length === 2 && typeof second === "string" && STATUS_WORDS.has(second.toUpperCase());
  }
}

/** Tokenize a single line. A trailing literal marker stays as `{literal: n}`. */
export function tokenize(line: string): Token[] {
  const t = new Tokenizer();
  t.feed(line);
  return t.tokens;
}

/**
 * Shape a token line into a response record. `data` is whatever followed the
 * type word; numbered responses (`* 3 FETCH …`) carry `number` too. Status
 * responses carry the optional `[code args]` and the free text.
 */
export interface ParsedResponse {
  tag: string;
  type: string;
  data: Token[];
  number?: number;
  code?: string;
  codeArgs?: Token[];
  text?: string;
  /** The first wire line of the response; set by the client for logging. */
  raw?: string;
}

export function parseResponse(tokens: Token[]): ParsedResponse {
  const [tag, second, third] = tokens;
  if (typeof tag !== "string") throw new Error("IMAP parser: response without a tag");
  if (tag === "+") {
    return { tag, type: "CONTINUE", text: isText(second) ? second.text : "", data: [] };
  }
  const word = typeof second === "string" ? second.toUpperCase() : "";
  if (STATUS_WORDS.has(word)) {
    const res: ParsedResponse = { tag, type: word, code: undefined, codeArgs: [], text: "", data: [] };
    let i = 2;
    const maybeCode = tokens[i];
    if (isBracket(maybeCode)) {
      const [code, ...args] = maybeCode.bracket;
      res.code = typeof code === "string" ? code.toUpperCase() : undefined;
      res.codeArgs = args;
      i++;
    }
    const maybeText = tokens[i];
    if (isText(maybeText)) res.text = maybeText.text;
    return res;
  }
  if (/^\d+$/.test(word) && typeof third === "string") {
    return { tag, type: third.toUpperCase(), number: Number(word), data: tokens.slice(3) };
  }
  return { tag, type: word, data: tokens.slice(2) };
}

// ---------------------------------------------------------------------------
// Modified UTF-7 (RFC 3501 §5.1.3): '&' opens a shift, '-' closes it, "&-" is a
// literal ampersand, the base64 alphabet uses ',' for '/', and the payload is
// UTF-16BE so non-BMP characters become surrogate pairs.

export function utf7Encode(name: string): string {
  let out = "";
  let run = "";
  const flush = (): void => {
    if (!run) return;
    const b64 = Buffer.from(run, "utf16le").swap16().toString("base64").replace(/=+$/, "").replace(/\//g, ",");
    out += "&" + b64 + "-";
    run = "";
  };
  for (const ch of name) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x26) {
      flush();
      out += "&-";
    } else if (cp >= 0x20 && cp <= 0x7e) {
      flush();
      out += ch;
    } else {
      run += ch;
    }
  }
  flush();
  return out;
}

export function utf7Decode(name: string): string {
  return name.replace(/&([A-Za-z0-9+,]*)-?/g, (match: string, b64: string) => {
    if (!match.endsWith("-")) return match; // malformed: leave as is
    if (b64 === "") return "&";
    const std = b64.replace(/,/g, "/");
    const bytes = Buffer.from(std, "base64");
    if (bytes.length % 2 !== 0) return match;
    return Buffer.from(bytes).swap16().toString("utf16le");
  });
}

// ---------------------------------------------------------------------------
// ENVELOPE and BODYSTRUCTURE readers.

/** A string-ish token (string, Buffer, or NIL) as a string or null. */
export function str(token: Token | undefined): string | null {
  if (token == null) return null;
  if (Buffer.isBuffer(token)) return token.toString("utf8");
  if (typeof token === "string") return token;
  return null;
}

function decodeWords(value: string | null): string | null {
  if (value == null) return null;
  try {
    return libmime.decodeWords(value);
  } catch {
    return value;
  }
}

function addressList(tokens: Token | undefined): string[] {
  if (!Array.isArray(tokens)) return [];
  const out: string[] = [];
  for (const a of tokens) {
    if (!Array.isArray(a) || a.length < 4) continue;
    const name = decodeWords(str(a[0]));
    const mailbox = str(a[2]);
    const host = str(a[3]);
    if (host == null) continue; // RFC 2822 group start/end markers
    const addr = mailbox == null ? "" : `${mailbox}@${host}`;
    out.push(name ? `${name} <${addr}>` : addr);
  }
  return out;
}

export interface Envelope {
  date: string | null;
  subject: string | null;
  from: string[];
  sender: string[];
  replyTo: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  inReplyTo: string | null;
  messageId: string | null;
}

export function parseEnvelope(list: Token | undefined): Envelope {
  if (!Array.isArray(list)) throw new Error("IMAP parser: ENVELOPE is not a list");
  return {
    date: str(list[0]),
    subject: decodeWords(str(list[1])),
    from: addressList(list[2]),
    sender: addressList(list[3]),
    replyTo: addressList(list[4]),
    to: addressList(list[5]),
    cc: addressList(list[6]),
    bcc: addressList(list[7]),
    inReplyTo: str(list[8]),
    messageId: str(list[9]),
  };
}

function paramList(tokens: Token | undefined): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (!Array.isArray(tokens)) return out;
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const key = str(tokens[i]);
    if (key == null) continue;
    out[key.toLowerCase()] = decodeWords(str(tokens[i + 1]));
  }
  return out;
}

function disposition(token: Token | undefined): { disposition: string | null; dispositionParams: Record<string, string | null> } {
  if (!Array.isArray(token)) return { disposition: null, dispositionParams: {} };
  const name = str(token[0]);
  return { disposition: name ? name.toLowerCase() : null, dispositionParams: paramList(token[1]) };
}

/** One node of a BODYSTRUCTURE tree. */
export interface BodyPart {
  /** Lowercased media type ("text", "multipart", "message", …). */
  type: string;
  subtype: string;
  params: Record<string, string | null>;
  id: string | null;
  description: string | null;
  encoding: string | null;
  size: number | null;
  disposition: string | null;
  dispositionParams: Record<string, string | null>;
  children: BodyPart[];
  /** IMAP section number ("1.2"); "" for the top-level multipart. */
  part: string;
  /** Line count for text/* and message/rfc822 parts. */
  lines?: number | null;
  /** Extension data: body MD5 (single parts only). */
  md5?: string | null;
  /** Envelope of an embedded message/rfc822. */
  envelope?: Envelope;
}

/**
 * Turn a BODYSTRUCTURE list into a tree. `part` is the IMAP section number
 * ("1.2"); the top-level multipart has part "" (its text is section TEXT),
 * children are numbered from 1 at each level, and the body inside a
 * message/rfc822 part continues that part's numbering.
 */
export function parseBodyStructure(list: Token | undefined, part: string | null = null): BodyPart {
  if (!Array.isArray(list) || list.length === 0) throw new Error("IMAP parser: BODYSTRUCTURE is not a body list");
  // `part` is null only for the top level: a multipart there has no section
  // number of its own, a single part there is section "1".
  if (Array.isArray(list[0])) return parseMultipart(list, part ?? "");
  if (list.length < 7) throw new Error("IMAP parser: BODYSTRUCTURE body part too short");
  return parseSinglePart(list, part ?? "1");
}

function parseMultipart(list: Token[], part: string): BodyPart {
  let i = 0;
  const children: BodyPart[] = [];
  while (i < list.length && Array.isArray(list[i])) {
    const childPart = part === "" ? String(i + 1) : `${part}.${i + 1}`;
    children.push(parseBodyStructure(list[i], childPart));
    i++;
  }
  const subtype = (str(list[i]) ?? "").toLowerCase();
  i++;
  return {
    type: "multipart",
    subtype,
    params: paramList(list[i]),
    id: null,
    description: null,
    encoding: null,
    size: null,
    ...disposition(list[i + 1]),
    children,
    part,
  };
}

function parseSinglePart(list: Token[], part: string): BodyPart {
  const type = (str(list[0]) ?? "").toLowerCase();
  const subtype = (str(list[1]) ?? "").toLowerCase();
  const node: BodyPart = {
    type,
    subtype,
    params: paramList(list[2]),
    id: str(list[3]),
    description: decodeWords(str(list[4])),
    encoding: (str(list[5]) ?? "").toLowerCase() || null,
    size: list[6] == null ? null : Number(str(list[6])),
    disposition: null,
    dispositionParams: {},
    children: [],
    part,
  };
  let i = 7;
  const embeddedEnvelope = list[7];
  const embeddedBody = list[8];
  if (type === "message" && subtype === "rfc822" && Array.isArray(embeddedEnvelope) && Array.isArray(embeddedBody)) {
    node.envelope = parseEnvelope(embeddedEnvelope);
    // The embedded body: a multipart continues this part's numbering, a single
    // part becomes "<part>.1".
    const inner = Array.isArray(embeddedBody[0]) ? parseMultipart(embeddedBody, part) : parseSinglePart(embeddedBody, `${part}.1`);
    node.children = [inner];
    node.lines = list[9] == null ? null : Number(str(list[9]));
    i = 10;
  } else if (type === "text") {
    node.lines = list[7] == null ? null : Number(str(list[7]));
    i = 8;
  }
  // Extension data: md5, disposition, language, location, ...
  node.md5 = str(list[i]) ?? null;
  Object.assign(node, disposition(list[i + 1]));
  return node;
}

/**
 * The parts that are candidates for "the message's text": text/* leaves that
 * are not attachments, excluding anything inside a forwarded message/rfc822
 * (that is the other message's text). In document order, so a caller can
 * prefer text/plain, else text/html.
 */
export function textParts(tree: BodyPart): BodyPart[] {
  const out: BodyPart[] = [];
  const walk = (node: BodyPart): void => {
    if (node.type === "message" && node.subtype === "rfc822") return;
    if (node.type === "multipart") {
      node.children.forEach(walk);
      return;
    }
    if (node.type === "text" && node.disposition !== "attachment") out.push(node);
  };
  walk(tree);
  return out;
}

/**
 * The parts worth listing as attachments: anything with an attachment
 * disposition, a filename, or a non-text leaf type — forwarded messages are
 * listed as one attachment, not walked into.
 */
export function attachmentParts(tree: BodyPart): BodyPart[] {
  const out: BodyPart[] = [];
  const walk = (node: BodyPart): void => {
    if (node.type === "multipart") {
      node.children.forEach(walk);
      return;
    }
    const hasName = Boolean(node.dispositionParams["filename"] || node.params["name"]);
    if (node.disposition === "attachment" || hasName || (node.type !== "text" && node.type !== "multipart")) {
      out.push(node);
    }
  };
  walk(tree);
  return out;
}

/** Best-effort display name for an attachment part. */
export function partFilename(node: BodyPart): string | null {
  return node.dispositionParams["filename"] || node.params["name"] || null;
}
