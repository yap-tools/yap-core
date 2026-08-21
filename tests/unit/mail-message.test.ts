import { describe, expect, it } from "vitest";

import {
  assertHeaderSafe,
  buildMessage,
  encodeHeaderWord,
  isAddress,
  makeMessageId,
  normalizeLineBreaks,
  parseAddresses,
  rfc5322Date,
} from "../../src/core/drivers/mail/message.js";

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
