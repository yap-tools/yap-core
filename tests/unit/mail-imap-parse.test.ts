import { describe, expect, it } from "vitest";

import {
  attachmentParts,
  parseBodyStructure,
  parseEnvelope,
  parseResponse,
  textParts,
  tokenize,
  Tokenizer,
  utf7Decode,
  utf7Encode,
  type Token,
} from "../../src/core/drivers/mail/imap-parse.js";

/** A token that must be a list; throws otherwise so the test fails clearly. */
function list(t: Token | undefined): Token[] {
  if (!Array.isArray(t)) throw new Error(`expected a list token, got ${JSON.stringify(t)}`);
  return t;
}

function buf(t: Token | undefined): Buffer {
  if (!Buffer.isBuffer(t)) throw new Error(`expected a literal token, got ${JSON.stringify(t)}`);
  return t;
}

describe("tokenize", () => {
  it("splits atoms, numbers (as strings), NIL and quoted strings", () => {
    expect(tokenize("* 3 EXISTS")).toEqual(["*", "3", "EXISTS"]);
    expect(tokenize('* LIST (\\HasNoChildren \\Drafts) "/" "INBOX/Drafts"')).toEqual([
      "*",
      "LIST",
      ["\\HasNoChildren", "\\Drafts"],
      "/",
      "INBOX/Drafts",
    ]);
    expect(tokenize('* X NIL "NIL" nil')).toEqual(["*", "X", null, "NIL", null]);
  });

  it('unescapes \\" and \\\\ inside quoted strings', () => {
    expect(tokenize('* X "a \\"quoted\\" back\\\\slash"')).toEqual(["*", "X", 'a "quoted" back\\slash']);
  });

  it("nests parenthesised lists and keeps empty lists", () => {
    expect(tokenize("* X (a (b (c)) () d)")).toEqual(["*", "X", ["a", ["b", ["c"]], [], "d"]]);
  });

  it("keeps bracket groups as section/response-code tokens", () => {
    expect(tokenize('* 1 FETCH (UID 5 BODY[HEADER.FIELDS (FROM SUBJECT)] "x")')).toEqual([
      "*",
      "1",
      "FETCH",
      ["UID", "5", "BODY", { bracket: ["HEADER.FIELDS", ["FROM", "SUBJECT"]] }, "x"],
    ]);
    expect(tokenize("* 1 FETCH (BODY[1]<0> {4}")).toEqual(["*", "1", "FETCH", ["BODY", { bracket: ["1"] }, "<0>", { literal: 4 }]]);
  });

  it("turns the rest of a status line into a text token, after an optional response code", () => {
    expect(tokenize("A1 OK [READ-WRITE] SELECT completed.")).toEqual(["A1", "OK", { bracket: ["READ-WRITE"] }, { text: "SELECT completed." }]);
    expect(tokenize("* OK [PERMANENTFLAGS (\\Seen \\*)] Flags permitted.")).toEqual([
      "*",
      "OK",
      { bracket: ["PERMANENTFLAGS", ["\\Seen", "\\*"]] },
      { text: "Flags permitted." },
    ]);
    expect(tokenize("* NO [BADCHARSET (US-ASCII)] bad")).toEqual(["*", "NO", { bracket: ["BADCHARSET", ["US-ASCII"]] }, { text: "bad" }]);
    expect(tokenize('* BYE Autologout; idle for too long (and [brackets] "quotes")')).toEqual([
      "*",
      "BYE",
      { text: 'Autologout; idle for too long (and [brackets] "quotes")' },
    ]);
    expect(tokenize("+ eyJzdGF0dXMiOiI0MDAifQ==")).toEqual(["+", { text: "eyJzdGF0dXMiOiI0MDAifQ==" }]);
    expect(tokenize("+")).toEqual(["+", { text: "" }]);
  });

  it("rejects garbage: unbalanced parens, unterminated quotes, a literal not at end of line", () => {
    expect(() => tokenize("* X (a")).toThrow(/unbalanced/i);
    expect(() => tokenize("* X a)")).toThrow(/unbalanced/i);
    expect(() => tokenize('* X "abc')).toThrow(/unterminated/i);
    expect(() => tokenize("* X {3} abc")).toThrow(/literal/i);
  });
});

describe("Tokenizer (multi-line with literals)", () => {
  it("pauses at a literal marker, takes the bytes, and resumes on the continuation line", () => {
    const t = new Tokenizer();
    expect(t.feed("* 1 FETCH (UID 5 BODY[1] {5}")).toEqual({ literal: 5 });
    t.feedLiteral(Buffer.from("hello"));
    expect(t.feed(" FLAGS (\\Seen))")).toEqual({ done: true });
    const items = list(t.tokens[3]);
    expect(items[0]).toBe("UID");
    expect(items[3]).toEqual({ bracket: ["1"] });
    expect(Buffer.isBuffer(items[4])).toBe(true);
    expect(buf(items[4]).toString()).toBe("hello");
    expect(items[5]).toBe("FLAGS");
    expect(items[6]).toEqual(["\\Seen"]);
  });

  it("handles several literals in one response", () => {
    const t = new Tokenizer();
    expect(t.feed('* 2 FETCH (ENVELOPE ("date" {3}')).toEqual({ literal: 3 });
    t.feedLiteral(Buffer.from("abc"));
    expect(t.feed(" NIL) BODY[] {2}")).toEqual({ literal: 2 });
    t.feedLiteral(Buffer.from("xy"));
    expect(t.feed(")")).toEqual({ done: true });
    const items = list(t.tokens[3]);
    const envelope = list(items[1]);
    expect(buf(envelope[1]).toString()).toBe("abc");
    expect(envelope[2]).toBe(null);
    expect(buf(items[4]).toString()).toBe("xy");
  });
});

describe("parseResponse", () => {
  it("parses tagged and untagged status responses with codes", () => {
    expect(parseResponse(tokenize("A1 OK [READ-WRITE] SELECT completed."))).toEqual({
      tag: "A1",
      type: "OK",
      code: "READ-WRITE",
      codeArgs: [],
      text: "SELECT completed.",
      data: [],
    });
    expect(parseResponse(tokenize("* OK [UIDVALIDITY 1234] UIDs valid"))).toMatchObject({
      tag: "*",
      type: "OK",
      code: "UIDVALIDITY",
      codeArgs: ["1234"],
      text: "UIDs valid",
    });
    expect(parseResponse(tokenize("* NO [BADCHARSET (US-ASCII)] nope"))).toMatchObject({
      type: "NO",
      code: "BADCHARSET",
      codeArgs: [["US-ASCII"]],
    });
    expect(parseResponse(tokenize("A2 BAD Parse error"))).toMatchObject({
      tag: "A2",
      type: "BAD",
      code: undefined,
      text: "Parse error",
    });
  });

  it("parses numbered untagged data (EXISTS, EXPUNGE, FETCH)", () => {
    expect(parseResponse(tokenize("* 17 EXISTS"))).toMatchObject({ tag: "*", type: "EXISTS", number: 17, data: [] });
    expect(parseResponse(tokenize("* 3 FETCH (UID 9 FLAGS (\\Seen))"))).toMatchObject({
      type: "FETCH",
      number: 3,
      data: [["UID", "9", "FLAGS", ["\\Seen"]]],
    });
  });

  it("parses plain untagged data and continuations", () => {
    expect(parseResponse(tokenize("* SEARCH 4 2 9"))).toMatchObject({ type: "SEARCH", data: ["4", "2", "9"] });
    expect(parseResponse(tokenize("* CAPABILITY IMAP4rev1 AUTH=PLAIN"))).toMatchObject({
      type: "CAPABILITY",
      data: ["IMAP4rev1", "AUTH=PLAIN"],
    });
    expect(parseResponse(tokenize("+ go ahead"))).toEqual({ tag: "+", type: "CONTINUE", text: "go ahead", data: [] });
  });
});

describe("modified UTF-7", () => {
  const cases: Array<[string, string]> = [
    ["INBOX", "INBOX"],
    ["Entwürfe", "Entw&APw-rfe"],
    ["Tom & Jerry", "Tom &- Jerry"],
    ["&", "&-"],
    ["日本語", "&ZeVnLIqe-"],
    ["Émoji 😀", "&AMk-moji &2D3eAA-"],
    ["a&b&c", "a&-b&-c"],
    ["~peter/mail/台北/日本語", "~peter/mail/&U,BTFw-/&ZeVnLIqe-"],
  ];
  for (const [plain, encoded] of cases) {
    it(`round-trips ${JSON.stringify(plain)}`, () => {
      expect(utf7Encode(plain)).toBe(encoded);
      expect(utf7Decode(encoded)).toBe(plain);
    });
  }
  it("leaves malformed shifts alone rather than throwing", () => {
    expect(utf7Decode("broken&")).toBe("broken&");
  });
});

describe("parseEnvelope", () => {
  const env: Token[] = [
    "Mon, 7 Feb 1994 21:52:25 -0800 (PST)",
    "=?UTF-8?Q?Gr=C3=BC=C3=9Fe?= from =?ISO-8859-1?Q?M=FCnchen?=",
    [["Terry Gray", null, "gray", "cac.washington.edu"]],
    [["Terry Gray", null, "gray", "cac.washington.edu"]],
    [[null, null, "gray", "cac.washington.edu"]],
    [
      ["=?UTF-8?B?SsO8cmdlbg==?=", null, "imap", "cac.washington.edu"],
      [null, null, "minutes", "CNRI.Reston.VA.US"],
    ],
    [["John Klensin", null, "KLENSIN", "MIT.EDU"]],
    null,
    "<abc@example.com>",
    "<B27397-0100000@cac.washington.edu>",
  ];

  it("maps the ten fields and renders addresses as Name <addr> with RFC 2047 decoded", () => {
    expect(parseEnvelope(env)).toEqual({
      date: "Mon, 7 Feb 1994 21:52:25 -0800 (PST)",
      subject: "Grüße from München",
      from: ["Terry Gray <gray@cac.washington.edu>"],
      sender: ["Terry Gray <gray@cac.washington.edu>"],
      replyTo: ["gray@cac.washington.edu"],
      to: ["Jürgen <imap@cac.washington.edu>", "minutes@CNRI.Reston.VA.US"],
      cc: ["John Klensin <KLENSIN@MIT.EDU>"],
      bcc: [],
      inReplyTo: "<abc@example.com>",
      messageId: "<B27397-0100000@cac.washington.edu>",
    });
  });

  it("skips RFC 2822 group markers and tolerates NIL everywhere", () => {
    const e = parseEnvelope([
      null,
      null,
      [
        [null, null, "undisclosed", null],
        [null, null, null, null],
      ],
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(e).toEqual({
      date: null,
      subject: null,
      from: [],
      sender: [],
      replyTo: [],
      to: [],
      cc: [],
      bcc: [],
      inReplyTo: null,
      messageId: null,
    });
  });

  it("accepts literal (Buffer) fields", () => {
    const e = parseEnvelope([
      null,
      Buffer.from("Hi"),
      [[Buffer.from("A"), null, Buffer.from("a"), Buffer.from("x.org")]],
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(e.subject).toBe("Hi");
    expect(e.from).toEqual(["A <a@x.org>"]);
  });
});

describe("parseBodyStructure", () => {
  const ts = (s: string): Token | undefined => tokenize("* X " + s)[2];

  it("parses a simple text/plain body (with the text-specific lines field and extensions)", () => {
    const t = parseBodyStructure(ts('("TEXT" "PLAIN" ("CHARSET" "US-ASCII") NIL NIL "7BIT" 3028 92 NIL NIL NIL NIL)'));
    expect(t).toMatchObject({
      type: "text",
      subtype: "plain",
      params: { charset: "US-ASCII" },
      id: null,
      description: null,
      encoding: "7bit",
      size: 3028,
      lines: 92,
      disposition: null,
      dispositionParams: {},
      children: [],
      part: "1",
    });
  });

  it("parses multipart/alternative", () => {
    const t = parseBodyStructure(
      ts(
        '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 12 1 NIL NIL NIL NIL)' +
          '("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 40 1 NIL NIL NIL NIL)' +
          ' "ALTERNATIVE" ("BOUNDARY" "b1") NIL NIL NIL)',
      ),
    );
    expect(t.type).toBe("multipart");
    expect(t.subtype).toBe("alternative");
    expect(t.params).toEqual({ boundary: "b1" });
    expect(t.part).toBe("");
    expect(t.children.map((c) => [c.part, c.subtype])).toEqual([
      ["1", "plain"],
      ["2", "html"],
    ]);
  });

  it("parses multipart/mixed with an attachment and its disposition params", () => {
    const t = parseBodyStructure(
      ts(
        '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 5 1 NIL NIL NIL NIL)' +
          '("APPLICATION" "PDF" ("NAME" "report.pdf") NIL NIL "BASE64" 123456 NIL ("ATTACHMENT" ("FILENAME" "report.pdf" "SIZE" "90000")) NIL NIL)' +
          ' "MIXED" ("BOUNDARY" "b2") NIL NIL NIL)',
      ),
    );
    const pdf = t.children[1];
    expect(pdf).toMatchObject({
      type: "application",
      subtype: "pdf",
      params: { name: "report.pdf" },
      encoding: "base64",
      size: 123456,
      disposition: "attachment",
      dispositionParams: { filename: "report.pdf", size: "90000" },
      part: "2",
    });
    expect(attachmentParts(t).map((p) => p.part)).toEqual(["2"]);
    expect(textParts(t).map((p) => p.part)).toEqual(["1"]);
  });

  it("parses multipart/related nested inside alternative, with inline images", () => {
    const t = parseBodyStructure(
      ts(
        '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 10 1 NIL NIL NIL NIL)' +
          '(("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 200 5 NIL NIL NIL NIL)' +
          '("IMAGE" "PNG" ("NAME" "logo.png") "<logo@cid>" NIL "BASE64" 4000 NIL ("INLINE" ("FILENAME" "logo.png")) NIL NIL)' +
          ' "RELATED" ("BOUNDARY" "b3" "TYPE" "text/html") NIL NIL NIL)' +
          ' "ALTERNATIVE" ("BOUNDARY" "b4") NIL NIL NIL)',
      ),
    );
    const related = t.children[1];
    expect(related).toMatchObject({ type: "multipart", subtype: "related", part: "2", params: { boundary: "b3", type: "text/html" } });
    expect(related?.children[0]).toMatchObject({ subtype: "html", part: "2.1" });
    expect(related?.children[1]).toMatchObject({ type: "image", id: "<logo@cid>", disposition: "inline", part: "2.2" });
    expect(textParts(t).map((p) => p.part)).toEqual(["1", "2.1"]);
    // inline images with a filename count as attachments for listing purposes
    expect(attachmentParts(t).map((p) => p.part)).toEqual(["2.2"]);
  });

  it("parses a message/rfc822 part with its envelope and embedded body", () => {
    const t = parseBodyStructure(
      ts(
        '(("TEXT" "PLAIN" ("CHARSET" "US-ASCII") NIL NIL "7BIT" 10 1 NIL NIL NIL NIL)' +
          '("MESSAGE" "RFC822" ("NAME" "fwd.eml") NIL NIL "7BIT" 5000' +
          ' ("Tue, 1 Jan 2020 00:00:00 +0000" "Fwd" (("A" NIL "a" "x.org")) NIL NIL NIL NIL NIL NIL "<m@x.org>")' +
          ' (("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 20 2 NIL NIL NIL NIL)("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 30 2 NIL NIL NIL NIL) "ALTERNATIVE" ("BOUNDARY" "inner") NIL NIL NIL)' +
          ' 120 NIL ("ATTACHMENT" ("FILENAME" "fwd.eml")) NIL NIL)' +
          ' "MIXED" ("BOUNDARY" "outer") NIL NIL NIL)',
      ),
    );
    const msg = t.children[1];
    expect(msg).toMatchObject({ type: "message", subtype: "rfc822", size: 5000, lines: 120, disposition: "attachment", part: "2" });
    expect(msg?.envelope).toMatchObject({ subject: "Fwd", from: ["A <a@x.org>"], messageId: "<m@x.org>" });
    expect(msg?.children[0]).toMatchObject({ type: "multipart", subtype: "alternative", part: "2" });
    expect(msg?.children[0]?.children.map((c) => c.part)).toEqual(["2.1", "2.2"]);
    // the forwarded message's text is not the message's own text
    expect(textParts(t).map((p) => p.part)).toEqual(["1"]);
    expect(attachmentParts(t).map((p) => p.dispositionParams["filename"])).toEqual(["fwd.eml"]);
  });

  it("parses a Gmail-style structure with extension data and RFC 2047 filenames", () => {
    const t = parseBodyStructure(
      ts(
        '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 29 1 NIL NIL NIL)' +
          '("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 50 1 NIL NIL NIL)' +
          '("APPLICATION" "OCTET-STREAM" ("NAME" "=?UTF-8?Q?Entw=C3=BCrfe.txt?=") NIL NIL "BASE64" 100 NIL ("ATTACHMENT" ("FILENAME" "=?UTF-8?Q?Entw=C3=BCrfe.txt?=")) NIL)' +
          ' "MIXED" ("BOUNDARY" "000000000000a") NIL NIL)',
      ),
    );
    expect(t.children).toHaveLength(3);
    expect(t.children[2]?.dispositionParams["filename"]).toBe("Entwürfe.txt");
    expect(t.children[2]?.params["name"]).toBe("Entwürfe.txt");
  });

  it("treats a single-part message/rfc822 body as part 1 of the part", () => {
    const t = parseBodyStructure(
      ts(
        '("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 500 (NIL "s" NIL NIL NIL NIL NIL NIL NIL NIL) ("TEXT" "PLAIN" NIL NIL NIL "7BIT" 10 1 NIL NIL NIL NIL) 10 NIL NIL NIL NIL)',
      ),
    );
    expect(t.part).toBe("1");
    expect(t.children[0]).toMatchObject({ type: "text", part: "1.1" });
  });

  it("numbers the children of a nested multipart in first position 1.1, 1.2", () => {
    const t = parseBodyStructure(
      ts(
        '((("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 13 0 NIL NIL NIL NIL)("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "7BIT" 19 0 NIL NIL NIL NIL) "ALTERNATIVE" ("BOUNDARY" "B2") NIL NIL NIL)("APPLICATION" "PDF" ("NAME" "r.pdf") NIL NIL "BASE64" 12 NIL NIL NIL NIL) "MIXED" ("BOUNDARY" "B1") NIL NIL NIL)',
      ),
    );
    expect(t.part).toBe("");
    expect(t.children[0]?.part).toBe("1");
    expect(t.children[0]?.children.map((c) => c.part)).toEqual(["1.1", "1.2"]);
    expect(t.children[1]?.part).toBe("2");
  });

  it("rejects shapes that are not a body", () => {
    expect(() => parseBodyStructure("nope")).toThrow(/BODYSTRUCTURE/);
    expect(() => parseBodyStructure(["TEXT"])).toThrow(/BODYSTRUCTURE/);
  });
});
