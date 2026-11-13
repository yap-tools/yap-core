import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertHeaderSafe,
  attachmentSummary,
  buildMessage,
  encodeHeaderWord,
  isAddress,
  makeMessageId,
  normalizeAttachment,
  normalizeLineBreaks,
  parseAddresses,
  rfc5322Date,
} from "../../src/core/drivers/mail/message.js";
import { parseMessage, physicalLines } from "../helpers/mail/mime.js";

function headersOf(buffer: Buffer): { headers: Record<string, string>; body: string } {
  const text = buffer.toString("utf8");
  const end = text.indexOf("\r\n\r\n");
  const headers: Record<string, string> = {};
  for (const raw of text.slice(0, end).split(/\r\n(?![ \t])/)) {
    const colon = raw.indexOf(":");
    headers[raw.slice(0, colon)] = raw.slice(colon + 1).trim();
  }
  return { headers, body: text.slice(end + 4) };
}

describe("buildMessage", () => {
  const base = {
    from: "me@example.com",
    to: ["a@x.com", "b@y.com"],
    subject: "Hi",
    body: "hello",
    messageId: "<id@example.com>",
    date: new Date("2026-08-21T10:00:00Z"),
  };

  it("emits the required headers with CRLF and an 8bit utf-8 text body", () => {
    const out = buildMessage(base);
    expect(Buffer.isBuffer(out)).toBe(true);
    const { headers, body } = headersOf(out);
    expect(headers.From).toBe("me@example.com");
    expect(headers.To).toBe("a@x.com, b@y.com");
    expect(headers.Subject).toBe("Hi");
    expect(headers.Date).toBe("Fri, 21 Aug 2026 10:00:00 +0000");
    expect(headers["Message-ID"]).toBe("<id@example.com>");
    expect(headers["MIME-Version"]).toBe("1.0");
    expect(headers["Content-Type"]).toBe("text/plain; charset=utf-8");
    expect(headers["Content-Transfer-Encoding"]).toBe("8bit");
    expect(headers.Cc).toBeUndefined();
    expect(headers["In-Reply-To"]).toBeUndefined();
    expect(body).toBe("hello");
    expect(out.toString("utf8")).not.toMatch(/[^\r]\n|\r[^\n]/);
  });

  it("adds Cc and threading headers when given", () => {
    const { headers } = headersOf(
      buildMessage({ ...base, cc: ["c@z.com"], inReplyTo: "<orig@x.com>", references: ["<r1@x.com>", "<orig@x.com>"] }),
    );
    expect(headers.Cc).toBe("c@z.com");
    expect(headers["In-Reply-To"]).toBe("<orig@x.com>");
    expect(headers.References).toBe("<r1@x.com> <orig@x.com>");
    expect(headersOf(buildMessage({ ...base, references: "<one@x.com>" })).headers.References).toBe("<one@x.com>");
  });

  it("puts a display name on From, quoting or encoding as needed", () => {
    expect(headersOf(buildMessage({ ...base, fromName: "Troels" })).headers.From).toBe("Troels <me@example.com>");
    expect(headersOf(buildMessage({ ...base, fromName: "Abrahamsen, T." })).headers.From).toBe(
      '"Abrahamsen, T." <me@example.com>',
    );
    expect(headersOf(buildMessage({ ...base, fromName: "" })).headers.From).toBe("me@example.com");
    const encoded = headersOf(buildMessage({ ...base, fromName: "Trøls" })).headers.From;
    expect(encoded).toBe(`=?utf-8?B?${Buffer.from("Trøls").toString("base64")}?= <me@example.com>`);
  });

  it("RFC 2047-encodes a non-ASCII subject and leaves ASCII alone", () => {
    const { headers } = headersOf(buildMessage({ ...base, subject: "Hæj på dig" }));
    expect(headers.Subject).toBe(`=?utf-8?B?${Buffer.from("Hæj på dig").toString("base64")}?=`);
  });

  it("keeps header lines under the RFC 5322 limit for a long non-ASCII subject", () => {
    const out = buildMessage({ ...base, subject: "ø".repeat(400) }).toString("utf8");
    for (const line of out.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
    const { headers } = headersOf(Buffer.from(out));
    const decoded = headers.Subject!.split(/\s+/)
      .map((w) => Buffer.from(/\?B\?(.*)\?=/.exec(w)![1]!, "base64").toString("utf8"))
      .join("");
    expect(decoded).toBe("ø".repeat(400));
  });

  it("normalises every line-break form in the body to CRLF and does not dot-stuff", () => {
    const { body } = headersOf(buildMessage({ ...base, body: "a\nb\r\nc\rd\r.\rx\n.hidden" }));
    expect(body).toBe("a\r\nb\r\nc\r\nd\r\n.\r\nx\r\n.hidden");
  });

  it("generates a Message-ID and Date when not given", () => {
    const { headers } = headersOf(buildMessage({ ...base, messageId: undefined, date: undefined }));
    expect(headers["Message-ID"]).toMatch(/^<[^@\s]+@example\.com>$/);
    expect(headers.Date).toMatch(/^\w{3}, \d{1,2} \w{3} \d{4} \d\d:\d\d:\d\d \+0000$/);
  });

  it("rejects line breaks in any header-bound value", () => {
    expect(() => buildMessage({ ...base, subject: "x\r\nBcc: evil@x.com" })).toThrow(/subject.*line break/);
    expect(() => buildMessage({ ...base, fromName: "a\nb" })).toThrow(/line break/);
    expect(() => buildMessage({ ...base, inReplyTo: "<a>\n<b>" })).toThrow(/line break/);
    expect(() => buildMessage({ ...base, references: ["<a>\r<b>"] })).toThrow(/References/);
    expect(() => buildMessage({ ...base, messageId: "<a>\n" })).toThrow(/Message-ID/);
    expect(() => buildMessage({ ...base, to: ["a@x.com\r\n"] })).toThrow();
  });

  it("requires at least one recipient and a valid from", () => {
    expect(() => buildMessage({ ...base, to: [] })).toThrow(/recipient/);
    expect(() => buildMessage({ ...base, from: "not-an-address" })).toThrow(/from/);
    expect(() => buildMessage({ ...base, cc: ["nope"] })).toThrow(/cc/);
  });

  it("caps to + cc at 50 recipients", () => {
    const many = Array.from({ length: 50 }, (_, i) => `u${i}@x.com`);
    expect(() => buildMessage({ ...base, to: many, cc: ["c@z.com"] })).toThrow(/50/);
    expect(() => buildMessage({ ...base, to: many.slice(0, 49), cc: ["c@z.com"] })).not.toThrow();
  });
});

describe("parseAddresses", () => {
  it("splits a comma list and trims", () => {
    expect(parseAddresses("a@x.com, b@y.com ,c@z.com")).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
  });
  it("rejects empty and malformed entries", () => {
    expect(() => parseAddresses("")).toThrow(/at least one/);
    expect(() => parseAddresses("a@x.com,")).toThrow(/email address/);
    expect(() => parseAddresses("Name <a@x.com>")).toThrow(/email address/);
    expect(() => parseAddresses("a@x")).toThrow(/email address/);
    expect(() => parseAddresses("a@x.com\r\nb@y.com")).toThrow(/email address/);
    expect(() => parseAddresses(undefined, "to")).toThrow(/to must be a string/);
  });
  it("caps the list at 50", () => {
    const list = Array.from({ length: 51 }, (_, i) => `u${i}@x.com`).join(",");
    expect(() => parseAddresses(list)).toThrow(/50/);
    expect(parseAddresses(list.split(",").slice(0, 50).join(","))).toHaveLength(50);
  });
});

describe("assertHeaderSafe", () => {
  it("names the field and rejects CR, LF and NUL", () => {
    expect(() => assertHeaderSafe("ok", "subject")).not.toThrow();
    expect(() => assertHeaderSafe("a\rb", "subject")).toThrow(/subject/);
    expect(() => assertHeaderSafe("a\nb", "subject")).toThrow(/subject/);
    expect(() => assertHeaderSafe("a\0b", "subject")).toThrow(/subject/);
    expect(() => assertHeaderSafe(42, "subject")).toThrow(/subject/);
  });
});

describe("isAddress", () => {
  it("accepts one bare address and nothing else", () => {
    expect(isAddress("a@x.com")).toBe(true);
    expect(isAddress("a@x")).toBe(false);
    expect(isAddress("Name <a@x.com>")).toBe(false);
    expect(isAddress("a@x.com,b@y.com")).toBe(false);
    expect(isAddress(42)).toBe(false);
  });
});

describe("encodeHeaderWord / rfc5322Date / normalizeLineBreaks", () => {
  it("leaves ASCII alone and folds long non-ASCII text into many words", () => {
    expect(encodeHeaderWord("plain")).toBe("plain");
    const words = encodeHeaderWord("æ".repeat(100)).split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
  });
  it("spells the zone +0000", () => {
    expect(rfc5322Date(new Date("2026-08-21T10:00:00Z"))).toBe("Fri, 21 Aug 2026 10:00:00 +0000");
  });
  it("turns every line-break form into CRLF", () => {
    expect(normalizeLineBreaks("a\nb\rc\r\nd")).toBe("a\r\nb\r\nc\r\nd");
  });
});

describe("makeMessageId", () => {
  it("is unique and angle-bracketed on the given domain", () => {
    const a = makeMessageId("example.com");
    const b = makeMessageId("example.com");
    expect(a).toMatch(/^<[A-Za-z0-9.\-]+@example\.com>$/);
    expect(a).not.toBe(b);
  });
});

describe("buildMessage with attachments", () => {
  const base = {
    from: "me@example.com",
    fromName: "Mé Self",
    to: ["a@example.com"],
    cc: ["c@example.com"],
    bcc: ["b@example.com"],
    subject: "Hej ærlig talt",
    body: "line one\nline two æøå\r\n",
    inReplyTo: "<x@example.com>",
    references: ["<w@example.com>", "<x@example.com>"],
    messageId: "<fixed@example.com>",
    date: new Date("2026-11-13T12:00:00Z"),
  };
  /** buildMessage's output for `base` as it was before attachments existed. */
  const GOLDEN =
    "From: =?utf-8?B?TcOpIFNlbGY=?= <me@example.com>\r\nTo: a@example.com\r\nCc: c@example.com\r\nBcc: b@example.com\r\nSubject: =?utf-8?B?SGVqIMOmcmxpZyB0YWx0?=\r\nDate: Fri, 13 Nov 2026 12:00:00 +0000\r\nMessage-ID: <fixed@example.com>\r\nIn-Reply-To: <x@example.com>\r\nReferences: <w@example.com> <x@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nline one\r\nline two æøå\r\n";
  const pdf = { filename: "report.pdf", mimeType: "application/pdf", bytes: new Uint8Array(crypto.randomBytes(1000)) };

  it("is byte-for-byte unchanged without attachments, or with an empty list", () => {
    expect(buildMessage(base).toString("utf8")).toBe(GOLDEN);
    expect(buildMessage({ ...base, attachments: [] }).toString("utf8")).toBe(GOLDEN);
  });

  it("builds multipart/mixed: the same headers, the text first and unchanged, then each file in order", () => {
    const png = { filename: "pixel.png", mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]) };
    const raw = buildMessage({ ...base, attachments: [pdf, png] });
    const msg = parseMessage(raw);
    const goldenHeaders = GOLDEN.slice(0, GOLDEN.indexOf("MIME-Version"));
    expect(raw.toString("utf8").startsWith(`${goldenHeaders}MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="`)).toBe(true);
    expect(msg.contentType).toBe("multipart/mixed");
    expect(msg.headers["content-transfer-encoding"]).toBeUndefined();
    expect(msg.parts).toHaveLength(3);
    const [text, first, second] = msg.parts;
    expect(text!.rawHeader).toBe("Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit");
    expect(text!.rawBody).toBe(normalizeLineBreaks(base.body));
    expect(first!.contentType).toBe("application/pdf");
    expect(first!.params["name"]).toBe("report.pdf");
    expect(first!.disposition).toBe("attachment");
    expect(first!.dispositionParams["filename"]).toBe("report.pdf");
    expect(first!.encoding).toBe("base64");
    expect(Buffer.compare(first!.bytes, Buffer.from(pdf.bytes))).toBe(0);
    expect(second!.contentType).toBe("image/png");
    expect(second!.dispositionParams["filename"]).toBe("pixel.png");
    expect(Buffer.compare(second!.bytes, Buffer.from(png.bytes))).toBe(0);
  });

  it("writes base64 in lines of 76 characters", () => {
    const msg = parseMessage(buildMessage({ ...base, attachments: [pdf] }));
    const lines = msg.parts[1]!.rawBody.split("\r\n");
    expect(lines.slice(0, -1).every((line) => line.length === 76)).toBe(true);
    expect(lines.at(-1)!.length).toBeLessThanOrEqual(76);
    expect(lines.at(-1)!.length).toBeGreaterThan(0);
  });

  it("keeps the Bcc header off when bcc is not given (the send shape)", () => {
    const { bcc: _bcc, ...sent } = base;
    const raw = buildMessage({ ...sent, attachments: [pdf] }).toString("utf8");
    expect(raw).not.toMatch(/^Bcc:/m);
    expect(raw).toContain("In-Reply-To: <x@example.com>\r\n");
    expect(raw).toContain("References: <w@example.com> <x@example.com>\r\n");
  });

  it("picks a boundary that does not occur in the body", () => {
    // A body that quotes the boundary prefix many times over still cannot
    // collide: the boundary carries 128 random bits and is checked anyway.
    const body = Array.from({ length: 50 }, () => "--=_yap_ =_yap_").join("\n");
    const raw = buildMessage({ ...base, body, attachments: [pdf] });
    const msg = parseMessage(raw);
    expect(msg.boundary).toMatch(/^=_yap_[0-9a-f]{32}$/);
    expect(msg.parts[0]!.rawBody).toBe(normalizeLineBreaks(body));
    expect(msg.parts[0]!.rawBody).not.toContain(msg.boundary);
  });

  it("round-trips a non-ASCII filename (RFC 2231 on filename, RFC 2047 on name)", () => {
    const filename = "Stemmeprøve – Mie æøå 🎙.mp3";
    const raw = buildMessage({ ...base, attachments: [{ ...pdf, filename, mimeType: "audio/mpeg" }] });
    const part = parseMessage(raw).parts[1]!;
    expect(part.dispositionParams["filename"]).toBe(filename);
    expect(part.params["name"]).toBe(filename);
    expect(part.rawHeader).toContain("filename*=utf-8''");
    expect(part.rawHeader).toContain('name="=?utf-8?B?');
    expect(/^[\x20-\x7e\r\n\t]*$/.test(part.rawHeader)).toBe(true);
  });

  it("round-trips names with quotes, backslashes, semicolons and control characters without breaking the header", () => {
    for (const filename of ['say "hi"; then.txt', "back\\slash.txt", 'a";filename="evil.exe', "tab\there.txt", "bell\x07\x7f.txt", "plain; semi.txt"]) {
      const raw = buildMessage({ ...base, attachments: [{ ...pdf, filename }] });
      const part = parseMessage(raw).parts[1]!;
      expect(part.dispositionParams["filename"], filename).toBe(filename);
      expect(part.params["name"], filename).toBe(filename);
      expect(part.disposition).toBe("attachment");
      expect(Object.keys(part.dispositionParams)).toEqual(["filename"]);
    }
  });

  it("keeps every header line under 998 octets for a very long name", () => {
    for (const filename of [`${"ø".repeat(400)}.txt`, `${"a".repeat(900)}.txt`]) {
      const raw = buildMessage({ ...base, attachments: [{ ...pdf, filename }] });
      expect(physicalLines(raw).every((line) => Buffer.byteLength(line) <= 998)).toBe(true);
      const part = parseMessage(raw).parts[1]!;
      expect(part.dispositionParams["filename"]).toBe(filename);
      expect(part.params["name"]).toBe(filename);
    }
    // 400 × "ø" is 2400 encoded characters: too long for one line, so continued.
    const continued = buildMessage({ ...base, attachments: [{ ...pdf, filename: `${"ø".repeat(400)}.txt` }] }).toString("utf8");
    expect(continued).toContain("filename*0*=utf-8''");
    expect(continued).toContain("filename*2*=");
  });

  it("refuses a filename or mime type with CR, LF or NUL, naming the field", () => {
    expect(() => buildMessage({ ...base, attachments: [{ ...pdf, filename: "a\r\nBcc: x@example.com" }] })).toThrow(/attachment filename must not contain a line break/);
    expect(() => buildMessage({ ...base, attachments: [{ ...pdf, filename: "a\nb" }] })).toThrow(/attachment filename/);
    expect(() => buildMessage({ ...base, attachments: [{ ...pdf, filename: "a\0b" }] })).toThrow(/attachment filename/);
    expect(() => buildMessage({ ...base, attachments: [{ ...pdf, mimeType: "text/plain\r\nX-Evil: 1" }] })).toThrow(/attachment mime type must not contain a line break/);
  });

  it("falls back to application/octet-stream for a missing or invalid mime type, and drops parameters", () => {
    const typeOf = (mimeType: string) => parseMessage(buildMessage({ ...base, attachments: [{ ...pdf, mimeType }] })).parts[1]!.contentType;
    expect(typeOf("")).toBe("application/octet-stream");
    expect(typeOf("not a type")).toBe("application/octet-stream");
    expect(typeOf('text/plain"; x="y')).toBe("application/octet-stream");
    expect(typeOf("Text/Plain; charset=utf-8")).toBe("text/plain");
    expect(typeOf("audio/mpeg")).toBe("audio/mpeg");
  });

  it("names an empty filename 'attachment'", () => {
    const part = parseMessage(buildMessage({ ...base, attachments: [{ ...pdf, filename: "" }] })).parts[1]!;
    expect(part.dispositionParams["filename"]).toBe("attachment");
  });

  it("normalises once (normalizeAttachment) and describes what went on (attachmentSummary)", () => {
    const normalized = [{ ...pdf, mimeType: "Text/Plain; charset=utf-8" }, { ...pdf, filename: "", mimeType: "" }].map(normalizeAttachment);
    expect(() => normalizeAttachment({ ...pdf, filename: "a\r\nb" })).toThrow(/attachment filename/);
    expect(attachmentSummary(normalized)).toEqual([
      { name: "report.pdf", mime_type: "text/plain", size: 1000 },
      { name: "attachment", mime_type: "application/octet-stream", size: 1000 },
    ]);
  });
});
