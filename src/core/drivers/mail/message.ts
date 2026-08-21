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
}

/**
 * Returns the message as a Buffer: CRLF headers, blank line, CRLF body. No
 * dot-stuffing (smtp.ts), no trailing CRLF added.
 */
export function buildMessage(options: BuildMessageOptions): Buffer {
  const { from, fromName, to, cc = [], bcc = [], subject, body, inReplyTo, references, messageId, date } = options;
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
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${normalizeLineBreaks(body)}`, "utf8");
}
