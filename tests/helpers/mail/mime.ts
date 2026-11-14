/**
 * A strict reader for the messages the mail driver builds, for asserting on
 * them. Parameter values (RFC 2231 continuations, charsets) and encoded words
 * are decoded with libmime, not with the driver's own code, so a test that
 * round-trips a filename checks the encoder against an independent decoder.
 *
 * Strict on purpose: a delimiter is a whole line `--boundary` (or the closing
 * `--boundary--`), every line ends in CRLF, and anything else is an error
 * rather than something to be lenient about.
 */
import libmime from "libmime";

export interface ParsedPart {
  /** Header name (lowercased) → unfolded value, first occurrence. */
  headers: Record<string, string>;
  /** Every header line exactly as written, folds included. */
  rawHeader: string;
  contentType: string;
  params: Record<string, string>;
  disposition: string | null;
  dispositionParams: Record<string, string>;
  encoding: string | null;
  /** The part's body as it is on the wire. */
  rawBody: string;
  /** The body transfer-decoded (base64) or, for 8bit, the UTF-8 bytes. */
  bytes: Buffer;
}

export interface ParsedMessage extends ParsedPart {
  boundary: string | null;
  parts: ParsedPart[];
}

function parsePart(raw: string): ParsedPart {
  const end = raw.indexOf("\r\n\r\n");
  if (end < 0) throw new Error("part has no header/body separator");
  const rawHeader = raw.slice(0, end);
  const rawBody = raw.slice(end + 4);
  const headers: Record<string, string> = {};
  for (const line of rawHeader.split(/\r\n(?![ \t])/)) {
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error(`malformed header line ${JSON.stringify(line)}`);
    const name = line.slice(0, colon).toLowerCase();
    // Unfold: drop the CRLF, keep the whitespace (RFC 5322 §2.2.3).
    if (!(name in headers)) headers[name] = line.slice(colon + 1).replace(/\r\n(?=[ \t])/g, "").trim();
  }
  const ct = libmime.parseHeaderValue(headers["content-type"] ?? "text/plain");
  const dispositionHeader = headers["content-disposition"];
  const disp = dispositionHeader ? libmime.parseHeaderValue(dispositionHeader) : null;
  const encoding = headers["content-transfer-encoding"]?.toLowerCase() ?? null;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(ct.params)) params[k] = libmime.decodeWords(String(v));
  const dispositionParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(disp?.params ?? {})) dispositionParams[k] = libmime.decodeWords(String(v));
  const bytes = encoding === "base64" ? Buffer.from(rawBody.replace(/\r\n/g, ""), "base64") : Buffer.from(rawBody, "utf8");
  return {
    headers,
    rawHeader,
    contentType: ct.value.toLowerCase(),
    params,
    disposition: disp ? disp.value.toLowerCase() : null,
    dispositionParams,
    encoding,
    rawBody,
    bytes,
  };
}

export function parseMessage(raw: string | Buffer): ParsedMessage {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  const top = parsePart(text);
  if (!top.contentType.startsWith("multipart/")) return { ...top, boundary: null, parts: [] };
  const boundary = top.params["boundary"];
  if (!boundary) throw new Error("multipart message without a boundary");
  const lines = top.rawBody.split("\r\n");
  const parts: ParsedPart[] = [];
  let current: string[] | null = null;
  let closed = false;
  for (const line of lines) {
    if (closed) {
      if (line !== "") throw new Error("content after the closing delimiter");
      continue;
    }
    if (line === `--${boundary}` || line === `--${boundary}--`) {
      if (current) parts.push(parsePart(current.join("\r\n")));
      current = line.endsWith("--") ? null : [];
      closed = line.endsWith("--");
      continue;
    }
    if (current) current.push(line);
    else if (line.includes(boundary)) throw new Error("boundary inside the preamble");
  }
  if (!closed) throw new Error("multipart message without a closing delimiter");
  return { ...top, boundary, parts };
}

/** Every physical line of the message, for line-length assertions. */
export function physicalLines(raw: string | Buffer): string[] {
  return (typeof raw === "string" ? raw : raw.toString("utf8")).split("\r\n");
}
