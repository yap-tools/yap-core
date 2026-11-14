/**
 * Building the RFC 5322 message the mail driver sends or drafts, and
 * validating the caller-supplied pieces that end up in it.
 *
 * Two threats shape this file. The first is header injection: every value an
 * agent supplies that lands in a header (subject, addresses, display name,
 * threading ids) is checked for CR/LF before it is written, because a line
 * break inside a header ends the header block and lets a caller add headers
 * — a Bcc, say — or a body of its own. `assertHeaderSafe` is that check, and
 * it names the field so the error is actionable.
 *
 * The second is SMTP smuggling. The body is split on *every* line-break form —
 * CRLF, bare LF, and bare CR — and rejoined with CRLF, so nothing but real CRLF
 * line breaks ever leaves here. A bare CR left inside a "line" would reach the
 * wire raw, and a server that treats bare CR as its own terminator would see
 * the dot-stuffing applied to the wrong logical lines: "\r.\rRCPT TO:<x>\r"
 * would read to it as end-of-DATA followed by a new command. Dot-stuffing
 * itself is *not* done here — it is a transport detail, applied by smtp.ts as
 * the bytes go out, so a message built here can also be APPENDed to an IMAP
 * folder verbatim.
 *
 * Headers may not carry raw UTF-8 (the body may; it is declared 8bit), so
 * non-ASCII header text becomes RFC 2047 encoded words, chunked so no header
 * line exceeds the 998-octet limit.
 *
 * A message with attachments is `multipart/mixed`: the text part first,
 * exactly as a single-part message would carry it, then one base64 part per
 * file. Without attachments the message is the single `text/plain` part it
 * has always been, byte for byte. A filename is attacker-shaped input (it
 * comes from whoever uploaded the file), so it goes through the same CR/LF
 * check as every other header value and, unless it is plain printable ASCII
 * with nothing that needs quoting, is written only in encoded form: RFC 2231
 * on `filename*` (what current clients read) and RFC 2047 encoded words on
 * the `name` parameter of Content-Type (what older ones fall back to). An
 * encoded value is all `attr-char`s and `%XX`, so no quote, semicolon or
 * control character in a name can end the parameter or the header.
 */
import crypto from "node:crypto";

export const MAX_RECIPIENTS = 50;

/** A single address, strictly enough to keep CR/LF, grouping syntax, and
 * display names out — the envelope and the header use the same bare form. */
const ADDRESS_RE = /^[^\s<>@,;:\\"]+@[^\s<>@,;:\\"]+\.[^\s<>@,;:\\"]+$/;

export function isAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

export function assertAddress(value: unknown, field: string): string {
  if (!isAddress(value)) {
    throw new Error(`${field} must be a single email address like "name@example.com"`);
  }
  return value;
}

/** Rejects anything that could end a header line early. NUL is refused too:
 * it is not a line break, but no header has a legitimate use for it and some
 * parsers truncate on it. */
export function assertHeaderSafe(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  if (/[\r\n\0]/.test(value)) throw new Error(`${field} must not contain a line break`);
  return value;
}

/** "a@x.com, b@y.com" → ["a@x.com", "b@y.com"], every entry validated. */
export function parseAddresses(list: unknown, field = "recipient list"): string[] {
  if (typeof list !== "string") throw new Error(`${field} must be a string of comma-separated addresses`);
  const parts = list.split(",").map((part) => part.trim());
  if (parts.length === 1 && parts[0] === "") throw new Error(`${field} must contain at least one address`);
  if (parts.length > MAX_RECIPIENTS) throw new Error(`${field} may contain at most ${MAX_RECIPIENTS} addresses`);
  // The offending entry is deliberately not echoed: this same path validates a
  // pinned recipient, and a pin that fails to parse must stay as invisible to
  // the agent as one that does.
  return parts.map((part) => assertAddress(part, `${field} entry`));
}

export function makeMessageId(domain: string): string {
  const id = `${Date.now().toString(36)}.${crypto.randomBytes(12).toString("hex")}`;
  return `<${id}@${domain}>`;
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** Printable ASCII only — no controls, no DEL, nothing above 126. */
function isAscii(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 126 || code < 32) return false;
  }
  return true;
}

/**
 * RFC 2047 encoding for a header value with non-ASCII in it. Encoded words are
 * limited to 75 characters, so the text is cut into chunks of at most 45 UTF-8
 * bytes (→ 60 base64 chars + the 12-char wrapper), never splitting a code
 * point, and the words are folded one per line.
 */
export function encodeHeaderWord(value: string): string {
  if (isAscii(value)) return value;
  return encodedWords(value);
}

/** `encodeHeaderWord` without the ASCII shortcut: always encoded words. */
function encodedWords(value: string): string {
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char, "utf8") > 45) {
      words.push(`=?utf-8?B?${base64(chunk)}?=`);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(`=?utf-8?B?${base64(chunk)}?=`);
  return words.join("\r\n ");
}

/** RFC 5322 date: `toUTCString` is the right shape but spells the zone "GMT". */
export function rfc5322Date(date: Date): string {
  return date.toUTCString().replace(/GMT$/, "+0000");
}

/** A display name: bare when it is plain atext, quoted when it has specials,
 * encoded when it is not ASCII. */
function formatMailbox(name: string | undefined, address: string): string {
  if (name === undefined || name === "") return address;
  if (!isAscii(name)) return `${encodeHeaderWord(name)} <${address}>`;
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(name)) return `${name} <${address}>`;
  return `"${name.replace(/[\\"]/g, (c) => `\\${c}`)}" <${address}>`;
}

/** Splits on every line-break form and rejoins with CRLF — see the header. */
export function normalizeLineBreaks(text: string): string {
  return text.split(/\r\n|\r|\n/).join("\r\n");
}

/** One file to attach: its name and type as the bundle stores them, and its bytes. */
export interface MessageAttachment {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

const OCTET_STREAM = "application/octet-stream";
/** RFC 6838 type and subtype names: restricted-name-chars, at most 127 each. */
const MIME_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * The Content-Type written for a file: its stored type, lowercased, with any
 * parameters dropped; `application/octet-stream` when there is none or it is
 * not a valid type. A line break is refused outright rather than replaced —
 * a stored type with one in it is a sign something upstream is wrong.
 */
export function attachmentMimeType(value: unknown): string {
  if (value === undefined || value === null || value === "") return OCTET_STREAM;
  const type = assertHeaderSafe(value, "attachment mime type").split(";")[0]!.trim().toLowerCase();
  return MIME_TYPE_RE.test(type) ? type : OCTET_STREAM;
}

function attachmentFilename(value: unknown): string {
  const name = assertHeaderSafe(value, "attachment filename");
  return name === "" ? "attachment" : name;
}

/**
 * The attachment as the message will carry it: the name checked for line
 * breaks ("" becomes "attachment"), the type checked and normalised. Throws
 * on a line break in either. `buildMessage` applies the same to whatever it
 * is given; calling this first is how a caller learns of a bad name before
 * it opens any connection.
 */
export function normalizeAttachment(attachment: MessageAttachment): MessageAttachment {
  return { filename: attachmentFilename(attachment.filename), mimeType: attachmentMimeType(attachment.mimeType), bytes: attachment.bytes };
}

/** What a run reports about the files on a (normalised) message: name,
 * type, and the raw (pre-base64) size. */
export function attachmentSummary(attachments: readonly MessageAttachment[]): Array<{ name: string; mime_type: string; size: number }> {
  return attachments.map((a) => ({ name: a.filename, mime_type: a.mimeType, size: a.bytes.byteLength }));
}

/** RFC 2231 attr-char: what may appear unencoded in an extended parameter value. */
const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;
/** Encoded characters per `filename*N*` section. Large on purpose: a single
 * `filename*=` is read by more clients than continuations are, so a name is
 * split only when it would not otherwise fit a 998-octet line. */
const RFC2231_SECTION_CHARS = 900;

/** A name that can go in a quoted-string as it is: printable ASCII with no
 * quote or backslash (the two characters a quoted-string would have to
 * escape, and that clients unescape inconsistently), and short enough to sit
 * on one line. */
function isPlainFilename(name: string): boolean {
  return isAscii(name) && !/["\\]/.test(name) && name.length <= 200;
}

/**
 * `filename*=utf-8''…` (RFC 2231), split into numbered `filename*N*`
 * sections only when too long for one line. A section never splits a code point, so each one
 * decodes on its own in clients that (wrongly) decode section by section.
 */
function rfc2231Filename(name: string): string {
  const sections: string[] = [];
  let current = "";
  for (const char of name) {
    let encoded = "";
    for (const byte of Buffer.from(char, "utf8")) {
      const c = String.fromCharCode(byte);
      encoded += byte < 128 && ATTR_CHAR.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    if (current.length + encoded.length > RFC2231_SECTION_CHARS && current !== "") {
      sections.push(current);
      current = "";
    }
    current += encoded;
  }
  sections.push(current);
  if (sections.length === 1) return `filename*=utf-8''${sections[0]}`;
  return sections.map((section, i) => (i === 0 ? `filename*0*=utf-8''${section}` : `filename*${i}*=${section}`)).join(";\r\n ");
}

function attachmentPart(attachment: MessageAttachment): { header: string; body: Buffer } {
  const { filename: name, mimeType: type, bytes } = normalizeAttachment(attachment);
  const [typeParam, dispositionParam] = isPlainFilename(name)
    ? [`name="${name}"`, `filename="${name}"`]
    : [`name="${encodedWords(name)}"`, rfc2231Filename(name)];
  const header = [
    `Content-Type: ${type};\r\n ${typeParam}`,
    `Content-Disposition: attachment;\r\n ${dispositionParam}`,
    "Content-Transfer-Encoding: base64",
  ].join("\r\n");
  return { header, body: base64Lines(bytes) };
}

/** Raw bytes per base64 line: 57 bytes encode to exactly 76 characters. */
const BASE64_LINE_BYTES = 57;
/** Lines encoded per chunk, so a large file is never one giant string. */
const BASE64_CHUNK_LINES = 1024;

/**
 * base64 in lines of 76 characters (RFC 2045 §6.8), CRLF between them, as
 * bytes. Encoded a chunk of whole lines at a time straight into one buffer
 * of the exact final size, so a 17 MiB attachment costs its encoded size
 * once rather than several intermediate strings.
 */
function base64Lines(bytes: Uint8Array): Buffer {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lines = Math.ceil(input.length / BASE64_LINE_BYTES);
  const out = Buffer.allocUnsafe(Math.ceil(input.length / 3) * 4 + Math.max(0, lines - 1) * 2);
  let at = 0;
  for (let line = 0; line < lines; line += BASE64_CHUNK_LINES) {
    const start = line * BASE64_LINE_BYTES;
    const encoded = input.subarray(start, start + BASE64_LINE_BYTES * BASE64_CHUNK_LINES).toString("base64");
    for (let i = 0; i < encoded.length; i += 76) {
      if (at > 0) at += out.write("\r\n", at, "latin1");
      at += out.write(encoded.slice(i, i + 76), at, "latin1");
    }
  }
  return out;
}

/**
 * A boundary of 128 random bits behind `=_yap_`. The `=_` pair cannot occur
 * in base64 at all, so only the text body and the part headers need
 * checking (and are), and a delimiter line can only ever be one of ours.
 */
function pickBoundary(contents: readonly string[]): string {
  for (;;) {
    const boundary = `=_yap_${crypto.randomBytes(16).toString("hex")}`;
    if (!contents.some((text) => text.includes(boundary))) return boundary;
  }
}

export interface BuildMessageOptions {
  from: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  /** Written as a `Bcc:` header — for a *draft*, where the mail client reads
   *  it back and strips it at send time. A sent message never carries one:
   *  smtp.ts puts bcc recipients on the envelope only. */
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string | string[];
  messageId?: string;
  date?: Date;
  /** Files to attach, in order. Empty or absent: a single text/plain part. */
  attachments?: readonly MessageAttachment[];
}

/**
 * Returns the message as a Buffer: CRLF headers, blank line, CRLF body. No
 * dot-stuffing (smtp.ts), no trailing CRLF added.
 */
export function buildMessage(options: BuildMessageOptions): Buffer {
  const { from, fromName, to, cc = [], bcc = [], subject, body, inReplyTo, references, messageId, date, attachments = [] } = options;
  assertAddress(from, "from");
  if (!Array.isArray(to) || to.length === 0) throw new Error("the message needs at least one recipient");
  for (const address of to) assertAddress(address, "to");
  for (const address of cc) assertAddress(address, "cc");
  for (const address of bcc) assertAddress(address, "bcc");
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
    throw new Error(`a message may have at most ${MAX_RECIPIENTS} recipients`);
  }
  assertHeaderSafe(subject, "subject");
  if (typeof body !== "string") throw new Error("body must be a string");
  if (fromName !== undefined) assertHeaderSafe(fromName, "name");
  if (inReplyTo !== undefined) assertHeaderSafe(inReplyTo, "In-Reply-To");
  const refs = references === undefined ? undefined : Array.isArray(references) ? references : [references];
  if (refs) for (const ref of refs) assertHeaderSafe(ref, "References");
  if (messageId !== undefined) assertHeaderSafe(messageId, "Message-ID");

  const headers = [
    `From: ${formatMailbox(fromName, from)}`,
    `To: ${to.join(", ")}`,
    ...(cc.length > 0 ? [`Cc: ${cc.join(", ")}`] : []),
    ...(bcc.length > 0 ? [`Bcc: ${bcc.join(", ")}`] : []),
    `Subject: ${encodeHeaderWord(subject)}`,
    `Date: ${rfc5322Date(date ?? new Date())}`,
    `Message-ID: ${messageId ?? makeMessageId(from.slice(from.lastIndexOf("@") + 1))}`,
    ...(inReplyTo !== undefined ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(refs && refs.length > 0 ? [`References: ${refs.join(" ")}`] : []),
    "MIME-Version: 1.0",
  ];
  const textHeader = "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit";
  const text = normalizeLineBreaks(body);
  if (attachments.length === 0) {
    return Buffer.from(`${headers.join("\r\n")}\r\n${textHeader}\r\n\r\n${text}`, "utf8");
  }
  // Every part is built (and every filename and type checked) before any of
  // it is joined, so a refused attachment leaves nothing half-assembled.
  const files = attachments.map(attachmentPart);
  const boundary = pickBoundary([text, ...files.map((part) => part.header)]);
  // The text part is 8bit, so the multipart around it says so too (RFC 2045 §6.4).
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, "Content-Transfer-Encoding: 8bit");
  const chunks: Buffer[] = [Buffer.from(`${headers.join("\r\n")}\r\n\r\n--${boundary}\r\n${textHeader}\r\n\r\n${text}\r\n`, "utf8")];
  for (const part of files) {
    chunks.push(Buffer.from(`--${boundary}\r\n${part.header}\r\n\r\n`, "latin1"), part.body, Buffer.from("\r\n", "latin1"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "latin1"));
  return Buffer.concat(chunks);
}
