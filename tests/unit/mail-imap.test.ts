import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedAuth } from "../../src/core/drivers/mail/auth.js";
import { imapConnect, quote, type ImapClient, type ImapConnectConfig, type ImapDeps } from "../../src/core/drivers/mail/imap.js";
import { openLine, ProtocolError } from "../../src/core/drivers/mail/net.js";
import { createCtx, createFakeEgress } from "../helpers/mail/egress.js";
import { simpleMessage, startImapMock, type ImapMock, type ImapMockOptions, type MockMailboxSeed } from "../helpers/mail/imap-mock.js";
import { fakeCtx, fakeOpenLine, fixtureCert, fixtureKey, type FakeCtx } from "../helpers/mail/line.js";

const password = { user: "troels", pass: "s3cret-pw" };
const passwordAuth = async (): Promise<ResolvedAuth> => ({ kind: "password", ...password });
const xoauthAuth = async (): Promise<ResolvedAuth> => ({ kind: "xoauth2", user: "troels", token: "ya29.token" });
const xoauth2Payload = (user: string, token: string): string => Buffer.from(`user=${user}\x01auth=Bearer ${token}\x01\x01`).toString("base64");

const servers: ImapMock[] = [];
afterEach(async () => {
  for (;;) {
    const s = servers.pop();
    if (!s) break;
    await s.close();
  }
});

async function mock(opts?: ImapMockOptions): Promise<ImapMock> {
  const s = await startImapMock(opts);
  servers.push(s);
  return s;
}

function config(server: ImapMock, extra: Partial<ImapConnectConfig> = {}): ImapConnectConfig {
  return { ...password, imap: { host: server.host, port: server.port, security: "none" }, allow_plaintext_auth: true, ...extra };
}

interface ConnectOptions {
  ctx?: FakeCtx;
  auth?: ImapDeps["resolveAuth"];
  cfg?: Partial<ImapConnectConfig>;
}

async function connect(server: ImapMock, { ctx = fakeCtx(), auth = passwordAuth, cfg = {} }: ConnectOptions = {}): Promise<{ client: ImapClient; ctx: FakeCtx }> {
  const client = await imapConnect(ctx, config(server, cfg), { openLine: fakeOpenLine, resolveAuth: auth, xoauth2Payload });
  return { client, ctx };
}

const seeded = (): MockMailboxSeed[] => [
  {
    name: "INBOX",
    attributes: ["\\HasChildren"],
    uidvalidity: 4242,
    messages: [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: new Date(2025, 0, 10, 9, 0, 0),
        raw: simpleMessage({ subject: "First", from: "Alice <alice@example.com>", messageId: "<one@example.com>" }),
      },
      {
        uid: 2,
        flags: [],
        internalDate: new Date(2025, 1, 20, 9, 0, 0),
        raw: simpleMessage({
          subject: 'Say "hi" to =?UTF-8?Q?M=C3=BCnchen?=',
          from: "=?UTF-8?B?SsO8cmdlbg==?= <j@example.com>",
          to: "bob@example.com, Carol <carol@example.com>",
          messageId: "<two@example.com>",
        }),
      },
      {
        uid: 5,
        flags: ["\\Flagged"],
        internalDate: new Date(2025, 2, 5, 9, 0, 0),
        raw: simpleMessage({ subject: "Third", from: "Dave <dave@example.com>", body: "0123456789abcdef", messageId: "<five@example.com>" }),
      },
    ],
  },
  { name: "INBOX/Drafts", attributes: ["\\HasNoChildren", "\\Drafts"], uidvalidity: 7, messages: [] },
  { name: "Entw&APw-rfe", attributes: ["\\HasNoChildren"], uidvalidity: 8, messages: [] },
];

describe("imapConnect: greeting, capabilities, authentication", () => {
  it("authenticates with AUTHENTICATE PLAIN when advertised and redacts the password from logs", async () => {
    const server = await mock();
    const { client, ctx } = await connect(server);
    expect(server.auth).toEqual([{ mechanism: "PLAIN", user: "troels", pass: "s3cret-pw", payload: expect.any(String) as string }]);
    expect(server.commands.some((c) => /^A\d+ AUTHENTICATE PLAIN$/.test(c))).toBe(true);
    expect(client.capabilities.has("IMAP4REV1")).toBe(true);
    expect(client.capabilities.has("UIDPLUS")).toBe(true);
    const joined = ctx.logs.join("\n");
    expect(joined).not.toContain("s3cret-pw");
    expect(joined).not.toContain(server.auth[0]?.payload);
    expect(joined).toMatch(/AUTHENTICATE PLAIN/);
    await client.logout();
  });

  it("falls back to LOGIN when AUTH=PLAIN is not advertised, with the password quoted", async () => {
    const server = await mock({ noAuthPlain: true });
    const { client, ctx } = await connect(server, { auth: async () => ({ kind: "password", user: 'tr"oels', pass: "p\\ss" }) });
    expect(server.auth).toEqual([{ mechanism: "LOGIN", user: 'tr"oels', pass: "p\\ss" }]);
    expect(server.commands).toContainEqual(expect.stringMatching(/^A\d+ LOGIN "tr\\"oels" "p\\\\ss"$/));
    expect(ctx.logs.join("\n")).not.toContain("p\\ss");
    await client.logout();
  });

  it("authenticates with XOAUTH2 through the + challenge", async () => {
    const server = await mock();
    const { client } = await connect(server, { auth: xoauthAuth });
    expect(server.auth).toEqual([{ mechanism: "XOAUTH2", user: "troels", token: "ya29.token", payload: xoauth2Payload("troels", "ya29.token") }]);
    await client.logout();
  });

  it("answers the XOAUTH2 error challenge with an empty line and surfaces the NO", async () => {
    const server = await mock({ authFail: true });
    await expect(connect(server, { auth: xoauthAuth })).rejects.toThrow(/authentication failed.*Invalid credentials/i);
    expect(server.commands).toContainEqual("(auth)");
  });

  it("surfaces a NO to a bad password as an authentication failure", async () => {
    const server = await mock({ authFail: true });
    await expect(connect(server)).rejects.toThrow(/authentication failed/i);
  });

  it("refuses to send credentials when LOGINDISABLED is advertised", async () => {
    const server = await mock({ loginDisabled: true });
    await expect(connect(server)).rejects.toThrow(/LOGINDISABLED/);
    expect(server.auth).toEqual([]);
    expect(server.commands.filter((c) => /LOGIN|AUTHENTICATE/.test(c))).toEqual([]);
  });

  it("refuses to send credentials over plaintext unless allow_plaintext_auth is true", async () => {
    const server = await mock();
    await expect(connect(server, { cfg: { allow_plaintext_auth: false } })).rejects.toThrow(/plaintext/i);
    expect(server.auth).toEqual([]);
  });

  it("skips authentication after a PREAUTH greeting", async () => {
    const server = await mock({ preauth: true });
    const { client } = await connect(server);
    expect(server.auth).toEqual([]);
    expect(await client.list()).toHaveLength(1);
    await client.logout();
  });

  it("fails on a BYE greeting", async () => {
    const server = await mock({ greetingBye: true });
    await expect(connect(server)).rejects.toThrow(/BYE.*shutting down/);
  });

  it("upgrades with STARTTLS when configured and re-reads capabilities", async () => {
    const server = await mock({ tls: { key: fixtureKey(), cert: fixtureCert() }, loginDisabled: true });
    const { client, ctx } = await connect(server, {
      cfg: { imap: { host: server.host, port: server.port, security: "starttls" }, allow_plaintext_auth: false },
    });
    expect(server.commands.findIndex((c) => /STARTTLS$/.test(c))).toBeGreaterThanOrEqual(0);
    // LOGINDISABLED was advertised only before the upgrade; the client must
    // have refreshed capabilities and authenticated.
    expect(client.capabilities.has("LOGINDISABLED")).toBe(false);
    expect(client.capabilities.has("STARTTLS")).toBe(false);
    expect(server.auth).toHaveLength(1);
    expect(ctx.logs.join("\n")).toMatch(/STARTTLS/);
    await client.logout();
  });

  it("fails when STARTTLS is required but not advertised, without sending credentials", async () => {
    const server = await mock();
    await expect(connect(server, { cfg: { imap: { host: server.host, port: server.port, security: "starttls" } } })).rejects.toThrow(/STARTTLS/);
    expect(server.auth).toEqual([]);
  });

  it("talks implicit TLS when security is tls", async () => {
    // The mock only listens in plaintext; a TLS handshake against it fails,
    // and that failure must surface rather than hang.
    const server = await mock();
    await expect(connect(server, { cfg: { imap: { host: server.host, port: server.port, security: "tls" } } })).rejects.toThrow();
  });
});

describe("imapConnect: mailbox commands", () => {
  it("lists folders with decoded names, raw names, delimiter and attributes", async () => {
    const server = await mock({ mailboxes: seeded() });
    const { client } = await connect(server);
    const folders = await client.list();
    expect(folders).toEqual([
      { name: "INBOX", raw: "INBOX", delimiter: "/", attributes: ["\\HasChildren"] },
      { name: "INBOX/Drafts", raw: "INBOX/Drafts", delimiter: "/", attributes: ["\\HasNoChildren", "\\Drafts"] },
      { name: "Entwürfe", raw: "Entw&APw-rfe", delimiter: "/", attributes: ["\\HasNoChildren"] },
    ]);
    expect(server.commands).toContainEqual(expect.stringMatching(/^A\d+ LIST "" "\*"$/));
    await client.logout();
  });

  it("selects and examines, encoding the folder name and reporting exists/uidvalidity/flags", async () => {
    const server = await mock({ mailboxes: seeded() });
    const { client } = await connect(server);
    const rw = await client.select("INBOX");
    expect(rw).toMatchObject({ exists: 3, uidvalidity: 4242, readOnly: false });
    expect(rw.flags).toContain("\\Seen");
    const ro = await client.select("Entwürfe", { readOnly: true });
    expect(ro).toMatchObject({ exists: 0, uidvalidity: 8, readOnly: true });
    expect(server.commands).toContainEqual(expect.stringMatching(/^A\d+ SELECT "INBOX"$/));
    expect(server.commands).toContainEqual(expect.stringMatching(/^A\d+ EXAMINE "Entw&APw-rfe"$/));
    const err = await client.select("Nope").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).message).toMatch(/folder "Nope" not found/);
    expect((err as ProtocolError)["agent"]).toBe("not_found");
    await client.logout();
  });

  it("searches with the criteria as given and returns ascending numeric uids", async () => {
    const server = await mock({ mailboxes: seeded() });
    const { client } = await connect(server);
    await client.select("INBOX");
    expect(await client.search(["ALL"])).toEqual([1, 2, 5]);
    expect(await client.search(["UNSEEN"])).toEqual([2, 5]);
    expect(await client.search(["FROM", '"alice"'])).toEqual([1]);
    expect(await client.search(["SINCE", "1-Feb-2025", "BEFORE", "1-Mar-2025"])).toEqual([2]);
    expect(await client.search(["SUBJECT", '"nomatch"'])).toEqual([]);
    expect(server.commands).toContainEqual(expect.stringMatching(/^A\d+ UID SEARCH SINCE 1-Feb-2025 BEFORE 1-Mar-2025$/));
    await client.logout();
  });

  it("sends non-ASCII criteria as literals with CHARSET UTF-8", async () => {
    const server = await mock({ mailboxes: seeded() });
    const { client } = await connect(server);
    await client.select("INBOX");
    const uids = await client.search(["SUBJECT", { literal: "München" }], { charset: "UTF-8" });
    expect(uids).toEqual([]); // the mock's raw subject holds the encoded word, not the text
    const i = server.commands.findIndex((c) => /UID SEARCH CHARSET UTF-8 SUBJECT \{8\}$/.test(c));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(server.commands[i + 1]).toBe("(+8 bytes)");
    expect(server.literals[0]?.toString("utf8")).toBe("München");
    await client.logout();
  });

  it("turns NO [BADCHARSET] into a clear error tagged invalid_request", async () => {
    const server = await mock({ mailboxes: seeded(), badCharset: true });
    const { client } = await connect(server);
    await client.select("INBOX");
    const err = await client.search(["SUBJECT", { literal: "Grüße" }], { charset: "UTF-8" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).message).toMatch(/cannot search non-ASCII/);
    expect((err as ProtocolError)["agent"]).toBe("invalid_request");
    await client.logout();
  });

  it("fetches summaries for several uids in one command, decoding envelopes (incl. literal subjects)", async () => {
    const server = await mock({ mailboxes: seeded() });
    const { client } = await connect(server);
    await client.select("INBOX", { readOnly: true });
    const rows = await client.fetchSummaries([5, 1, 2, 2]);
    expect(rows.map((r) => r.uid)).toEqual([1, 2, 5]);
    expect(rows[0]).toMatchObject({
      uid: 1,
      flags: ["\\Seen"],
      envelope: { subject: "First", from: ["Alice <alice@example.com>"], messageId: "<one@example.com>" },
    });
    expect(rows[0]?.internalDate).toBeInstanceOf(Date);
    expect(rows[0]?.internalDate?.getTime()).toBe(new Date(2025, 0, 10, 9, 0, 0).getTime());
    expect(rows[0]?.size).toBeGreaterThan(100);
    expect(rows[1]?.envelope).toMatchObject({
      subject: 'Say "hi" to München',
      from: ["Jürgen <j@example.com>"],
      to: ["bob@example.com", "Carol <carol@example.com>"],
    });
    expect(server.commands).toContainEqual(expect.stringMatching(/^A\d+ UID FETCH 1:2,5 \(UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE\)$/));
    expect(await client.fetchSummaries([])).toEqual([]);
    await client.logout();
  });

  it("splits a large uid set into FETCHes of at most 100 uids", async () => {
    const messages = Array.from({ length: 130 }, (_, i) => ({ uid: i + 1, raw: simpleMessage({ subject: `m${i + 1}` }) }));
    const server = await mock({ mailboxes: [{ name: "INBOX", messages }] });
    const { client } = await connect(server);
    await client.select("INBOX");
    const rows = await client.fetchSummaries(messages.map((m) => m.uid));
    expect(rows).toHaveLength(130);
    const fetches = server.commands.filter((c) => /UID FETCH/.test(c));
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).toMatch(/UID FETCH 1:100 /);
    expect(fetches[1]).toMatch(/UID FETCH 101:130 /);
    await client.logout();
  });

  it("fetches selected headers, unfolded and RFC 2047 decoded, keyed in lowercase", async () => {
    const raw = simpleMessage({
      subject: "=?UTF-8?Q?Gr=C3=BC=C3=9Fe?=\r\n =?UTF-8?Q?_aus_M=C3=BCnchen?=",
      messageId: "<mid@example.com>",
      extraHeaders: "In-Reply-To: <parent@example.com>\r\nReferences: <root@example.com>\r\n <parent@example.com>",
    });
    const server = await mock({ mailboxes: [{ name: "INBOX", messages: [{ uid: 3, raw }] }] });
    const { client } = await connect(server);
    await client.select("INBOX");
    const h = await client.fetchHeaders(3, ["Message-ID", "In-Reply-To", "References", "Subject", "X-Missing"]);
    expect(h).toEqual({
      "message-id": "<mid@example.com>",
      "in-reply-to": "<parent@example.com>",
      references: "<root@example.com> <parent@example.com>",
      subject: "Grüße aus München",
    });
    expect(server.commands).toContainEqual(
      expect.stringMatching(/UID FETCH 3 \(UID BODY.PEEK\[HEADER.FIELDS \(Message-ID In-Reply-To References Subject X-Missing\)\]\)$/),
    );
    const err = await client.fetchHeaders(99, ["Subject"]).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as ProtocolError).message).toMatch(/not found/);
    expect((err as ProtocolError)["agent"]).toBe("not_found");
    await client.logout();
  });

  it("fetches the body structure as a tree", async () => {
    const raw = [
      "From: a@example.com",
      "To: b@example.com",
      "Subject: Multi",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="XYZ"',
      "",
      "--XYZ",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hello there",
      "--XYZ",
      'Content-Type: application/pdf; name="a.pdf"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="a.pdf"',
      "",
      "JVBERi0=",
      "--XYZ--",
      "",
    ].join("\r\n");
    const gmail =
      '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 29 1 NIL NIL NIL)("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 50 1 NIL NIL NIL) "ALTERNATIVE" ("BOUNDARY" "000a") NIL NIL)';
    const server = await mock({
      mailboxes: [
        {
          name: "INBOX",
          messages: [
            { uid: 1, raw },
            { uid: 2, raw: simpleMessage(), bodystructure: gmail },
          ],
        },
      ],
    });
    const { client } = await connect(server);
    await client.select("INBOX");
    const t = await client.fetchStructure(1);
    expect(t).toMatchObject({ type: "multipart", subtype: "mixed", part: "" });
    expect(t.children[0]).toMatchObject({ type: "text", subtype: "plain", params: { charset: "utf-8" }, part: "1", size: 11 });
    expect(t.children[1]).toMatchObject({
      type: "application",
      subtype: "pdf",
      encoding: "base64",
      disposition: "attachment",
      dispositionParams: { filename: "a.pdf" },
      part: "2",
    });
    const g = await client.fetchStructure(2);
    expect(g.children.map((c) => c.subtype)).toEqual(["plain", "html"]);
    await client.logout();
  });

  it("fetches a section with a byte cap and reports truncation", async () => {
    const server = await mock({ mailboxes: seeded() });
    const { client } = await connect(server);
    await client.select("INBOX");
    const full = await client.fetchSection(5, "1", { maxBytes: 1000 });
    expect(full.buffer.toString()).toBe("0123456789abcdef\r\n");
    expect(full.truncated).toBe(false);
    const cut = await client.fetchSection(5, "1", { maxBytes: 10 });
    expect(cut.buffer.toString()).toBe("0123456789");
    expect(cut.truncated).toBe(true);
    // with the size known from the structure, an exact fit is not a truncation
    const exact = await client.fetchSection(5, "1", { maxBytes: 18, size: 18 });
    expect(exact.truncated).toBe(false);
    expect(server.commands).toContainEqual(expect.stringMatching(/UID FETCH 5 \(UID BODY.PEEK\[1\]<0.10>\)$/));
    const header = await client.fetchSection(5, "HEADER", { maxBytes: 4096 });
    expect(header.buffer.toString()).toMatch(/^From: /);
    await client.logout();
  });

  it("stores flags and returns the resulting flag list", async () => {
    const server = await mock({ mailboxes: seeded() });
    const { client } = await connect(server);
    await client.select("INBOX");
    expect(await client.store(2, "+FLAGS", ["\\Seen"])).toEqual(["\\Seen"]);
    expect(await client.store(2, "+FLAGS", ["\\Flagged"])).toEqual(["\\Seen", "\\Flagged"]);
    expect(await client.store(2, "-FLAGS", ["\\Seen"])).toEqual(["\\Flagged"]);
    expect(server.commands).toContainEqual(expect.stringMatching(/UID STORE 2 \+FLAGS \(\\Seen\)$/));
    expect(server.mailbox("INBOX")?.messages[1]?.flags).toEqual(["\\Flagged"]);
    await expect(client.store(99, "+FLAGS", ["\\Seen"])).rejects.toThrow(/not found/);
    await client.logout();
  });

  it("appends a message with flags and returns the APPENDUID uid", async () => {
    const server = await mock({ mailboxes: seeded() });
    const { client, ctx } = await connect(server);
    const msg = Buffer.from("From: a@example.com\r\nSubject: Draft\r\n\r\nBody\r\n");
    const res = await client.append("Entwürfe", msg, ["\\Draft"]);
    expect(res).toEqual({ uid: 1 });
    const i = server.commands.findIndex((c) => /APPEND "Entw&APw-rfe" \(\\Draft\) \{\d+\}$/.test(c));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(server.literals.at(-1)?.equals(msg)).toBe(true);
    expect(server.mailbox("Entw&APw-rfe")?.messages[0]).toMatchObject({ uid: 1, flags: ["\\Draft"] });
    expect(ctx.logs.join("\n")).not.toContain("Body");
    await client.logout();
  });

  it("appends without UIDPLUS and reports uid null", async () => {
    const server = await mock({ mailboxes: seeded(), noUidplus: true });
    const { client } = await connect(server);
    expect(await client.append("INBOX/Drafts", Buffer.from("Subject: x\r\n\r\ny\r\n"), [])).toEqual({ uid: null });
    await client.logout();
  });

  it("logs out: LOGOUT, BYE, socket closed; a second logout is a no-op", async () => {
    const server = await mock();
    const { client } = await connect(server);
    await client.logout();
    await client.logout();
    expect(server.commands.at(-1)).toMatch(/LOGOUT$/);
    await expect(client.list()).rejects.toThrow(/closed/i);
  });
});

describe("imapConnect: through the real net.ts openLine", () => {
  it("connects via ctx.egress, sends literals with writeRaw, and reads literals back", async () => {
    const server = await mock({ mailboxes: seeded() });
    const ctx = createCtx(createFakeEgress());
    const client = await imapConnect(ctx, config(server), { openLine, resolveAuth: passwordAuth, xoauth2Payload });
    await client.select("INBOX");
    const rows = await client.fetchSummaries([2]);
    expect(rows[0]?.envelope?.subject).toBe('Say "hi" to München');
    expect(await client.append("INBOX/Drafts", Buffer.from("Subject: d\r\n\r\nx\r\n"), ["\\Draft"])).toEqual({ uid: 1 });
    await client.logout();
  });

  it("fails without credentials when the server is not PREAUTH", async () => {
    const server = await mock();
    const ctx = createCtx(createFakeEgress());
    await expect(imapConnect(ctx, config(server), { openLine, resolveAuth: async () => null, xoauth2Payload })).rejects.toThrow(/no credentials/);
  });
});

describe("quote", () => {
  it("escapes quotes and backslashes", () => {
    expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
  it("refuses CR, LF, and NUL rather than splitting the command", () => {
    for (const bad of ["a\rb", "a\nb", "a\0b"]) expect(() => quote(bad)).toThrow(/line break|NUL/);
  });
});

describe("imapConnect: failure modes", () => {
  it("rejects a command when the signal aborts mid-flight", async () => {
    const server = await mock({ slowCommand: "NOOP" });
    const ac = new AbortController();
    const { client } = await connect(server, { ctx: fakeCtx({ signal: ac.signal }) });
    const pending = client.noop();
    setTimeout(() => ac.abort(new Error("budget exhausted")), 30);
    await expect(pending).rejects.toThrow(/budget exhausted/);
  });

  it("surfaces a server BYE mid-session as a protocol error", async () => {
    const server = await mock({ byeOn: "NOOP" });
    const { client } = await connect(server);
    await expect(client.noop()).rejects.toThrow(/BYE.*closed by server/);
  });

  it("tolerates untagged EXISTS/EXPUNGE noise between commands", async () => {
    const server = await mock({ mailboxes: seeded() });
    const { client } = await connect(server);
    await client.select("INBOX");
    // SELECT already emits EXISTS/RECENT/FLAGS; a following SEARCH must not
    // be confused by them.
    expect(await client.search(["ALL"])).toEqual([1, 2, 5]);
    await client.logout();
  });

  it("wraps a NO/BAD on any command in a ProtocolError carrying the reply", async () => {
    const server = await mock({ mailboxes: seeded() });
    const { client } = await connect(server);
    const err = await client.search(["ALL"]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProtocolError);
    const pe = err as ProtocolError;
    expect(pe.name).toBe("ProtocolError");
    expect(pe.reply).toMatch(/NO Select a mailbox first/);
    expect(pe.step).toBe("UID SEARCH");
    await client.logout();
  });
});
