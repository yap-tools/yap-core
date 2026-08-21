/**
 * The mail driver's six actions against the in-process IMAP and SMTP mocks:
 * what each returns, what goes on the wire, and — the part that matters most
 * for a built-in — which failures reach an agent. A `YapError` is shown to
 * the agent verbatim by the runs layer; anything else collapses to "run
 * failed", so every case here asserts not just the message but the class.
 */
import { afterEach, describe, expect, it } from "vitest";

import { normalizeMailConfig } from "../../src/core/drivers/mail/config.js";
import { createMailDriver } from "../../src/core/drivers/mail/index.js";
import { YapError } from "../../src/core/errors.js";
import { createCtx, createFakeEgress } from "../helpers/mail/egress.js";
import { simpleMessage, startImapMock, utf7Encode, type ImapMock, type ImapMockOptions, type MockMailboxSeed } from "../helpers/mail/imap-mock.js";
import { startMockSmtp, type MockSmtp, type MockSmtpOptions } from "../helpers/smtp.js";

const driver = createMailDriver();
const PASS = "s3cret-pw-xyz";
const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function imapMock(opts?: ImapMockOptions): Promise<ImapMock> {
  const s = await startImapMock(opts);
  servers.push(s);
  return s;
}
async function smtpMock(opts?: MockSmtpOptions): Promise<MockSmtp> {
  const s = await startMockSmtp(opts);
  servers.push(s);
  return s;
}

type Config = Record<string, unknown>;

function config({ imap, smtp, ...extra }: { imap?: ImapMock; smtp?: MockSmtp } & Config = {}): Config {
  return {
    user: "troels",
    pass: PASS,
    from: "troels@example.com",
    name: "Troels",
    allow_plaintext_auth: true,
    ...(imap ? { imap: { host: "imap.example.test", port: imap.port, security: "none" } } : {}),
    ...(smtp ? { smtp: { host: "smtp.example.test", port: smtp.port, security: "none" } } : {}),
    ...extra,
  };
}

/** Run results are driver-shaped JSON; the assertions spell out the shape. */
type Result = any;

async function run(cfg: Config, action: string, params: Record<string, string> = {}): Promise<{ result: Result; ctx: ReturnType<typeof createCtx> }> {
  const ctx = createCtx(createFakeEgress());
  ctx.config = cfg;
  ctx.action = action;
  ctx.params = params;
  const result = await driver.run(ctx);
  return { result, ctx };
}

const msg = simpleMessage;

/** The rejection of a run, for asserting on its class and code. */
async function failure(cfg: Config, action: string, params?: Record<string, string>): Promise<Error> {
  let error: Error | undefined;
  await run(cfg, action, params).catch((e: Error) => (error = e));
  expect(error, `${action} should have failed`).toBeDefined();
  return error!;
}
/** `{agentSafe, code}` the way the external driver's tests phrased it: a
 * YapError is what the runner shows, and its code is the verdict. */
const agentSafe = (e: Error): { agentSafe: boolean | undefined; code: string | undefined } =>
  e instanceof YapError ? { agentSafe: true, code: e.code } : { agentSafe: undefined, code: undefined };

function seededInbox(): MockMailboxSeed {
  return {
    name: "INBOX",
    attributes: ["\\HasNoChildren"],
    uidvalidity: 77,
    messages: [
      { uid: 1, flags: ["\\Seen"], internalDate: new Date(2025, 0, 10, 9, 0, 0), raw: msg({ subject: "First", from: "Alice <alice@example.com>", messageId: "<one@example.com>", body: "first body" }) },
      { uid: 2, flags: [], internalDate: new Date(2025, 1, 20, 9, 0, 0), raw: msg({ subject: "Second", from: "Bob <bob@example.com>", to: "troels@example.com, Carol <carol@example.com>", messageId: "<two@example.com>", body: "second body" }) },
      { uid: 3, flags: [], internalDate: new Date(2025, 2, 5, 9, 0, 0), raw: msg({ subject: "Third", from: "Alice <alice@example.com>", messageId: "<three@example.com>", body: "third body" }) },
    ],
  };
}

function mailboxes(extra: MockMailboxSeed[] = []): MockMailboxSeed[] {
  return [seededInbox(), ...extra];
}

describe("definition", () => {
  it("declares the mail driver with six actions and their params", () => {
    expect(driver.name).toBe("mail");
    expect(driver.api).toBe(1);
    expect(driver.egress).toBe(true);
    expect(Object.keys(driver.actions).sort()).toEqual(["draft", "folders", "mark", "read", "search", "send"]);
    for (const [name, spec] of Object.entries(driver.actions)) {
      expect(spec.description, name).toBeTypeOf("string");
      expect(Array.isArray(spec.params), name).toBe(true);
      expect(Number.isInteger(spec.timeoutMs) && spec.timeoutMs > 0, name).toBe(true);
    }
    expect(driver.actions["send"]!.params!.filter((p) => p.required).map((p) => p.name)).toEqual(["body"]);
    expect(driver.actions["read"]!.params!.find((p) => p.name === "uid")!.required).toBe(true);
    expect(driver.actions["mark"]!.params!.map((p) => p.name)).toEqual(["uid", "flag", "folder"]);
    expect(driver.configDoc).toContain("allow_plaintext_auth");
  });
});

describe("validateConfig", () => {
  const base = { user: "u", pass: "p", from: "a@b.example", imap: { host: "h", port: 993 } };
  it("accepts a minimal config and fills defaults", () => {
    expect(() => driver.validateConfig(base)).not.toThrow();
    const c = normalizeMailConfig(base);
    expect(c.imap?.security).toBe("tls");
    expect(c.save_sent).toBe(false);
    expect(c.allow_plaintext_auth).toBe(false);
  });
  it("defaults security by port", () => {
    expect(normalizeMailConfig({ ...base, imap: { host: "h", port: 143 } }).imap?.security).toBe("starttls");
    expect(normalizeMailConfig({ ...base, smtp: { host: "h", port: 587 } }).smtp?.security).toBe("starttls");
    expect(normalizeMailConfig({ ...base, smtp: { host: "h", port: 465 } }).smtp?.security).toBe("tls");
    expect(normalizeMailConfig({ ...base, smtp: { host: "h", port: 2525 } }).smtp?.security).toBe("tls");
  });
  it.each<[unknown, RegExp]>([
    [{ ...base, user: undefined }, /user/],
    [{ ...base, pass: undefined }, /pass or oauth2/],
    [{ ...base, oauth2: { client_id: "a", client_secret: "b", refresh_token: "c", token_url: "https://x.example/t" } }, /pass or oauth2/],
    [{ ...base, pass: undefined, oauth2: { client_id: "a", client_secret: "b", refresh_token: "c", token_url: "http://x.example/t" } }, /oauth2.token_url/],
    [{ ...base, pass: undefined, oauth2: { client_id: "a", client_secret: "b", token_url: "https://x.example/t" } }, /oauth2.refresh_token/],
    [{ ...base, from: "nope" }, /from/],
    [{ ...base, name: "a\r\nBcc: x@y.example" }, /name/],
    [{ ...base, imap: undefined }, /imap or smtp/],
    [{ ...base, imap: { host: "h", port: 70000 } }, /imap.port/],
    [{ ...base, imap: { host: "h", port: 993, security: "ssl" } }, /imap.security/],
    [{ ...base, smtp: { port: 25 } }, /smtp.host/],
    [{ ...base, allow_plaintext_auth: "yes" }, /allow_plaintext_auth/],
    [{ ...base, drafts_folder: "" }, /drafts_folder/],
    [{ ...base, drafts_folder: "Drafts\r\n" }, /drafts_folder/],
    [{ ...base, sent_folder: "Sent\0" }, /sent_folder/],
    [{ ...base, imap: undefined, smtp: { host: "h", port: 587 }, save_sent: true }, /save_sent/],
    ["nope", /config must be an object/],
  ])("rejects %j", (cfg, re) => {
    expect(() => driver.validateConfig(cfg)).toThrow(re);
  });
  it("accepts an oauth2 config", () => {
    const c = normalizeMailConfig({ ...base, pass: undefined, oauth2: { client_id: "a", client_secret: "b", refresh_token: "c", token_url: "https://x.example/t" } });
    expect(c.oauth2?.client_id).toBe("a");
    expect(c.pass).toBeUndefined();
  });
});

describe("folders", () => {
  it("lists folders with decoded names, special-use, and message counts", async () => {
    const imap = await imapMock({
      mailboxes: mailboxes([
        { name: "Drafts", attributes: ["\\Drafts", "\\HasNoChildren"], messages: [] },
        { name: "Sent", attributes: ["\\Sent"], messages: [] },
        { name: "Archive", attributes: ["\\HasChildren", "\\Noselect"], messages: [] },
        { name: "Archive/Bl&AOU-b&AOY-r", attributes: ["\\HasNoChildren"], messages: [] },
      ]),
    });
    const { result } = await run(config({ imap }), "folders");
    expect(result.folders).toEqual([
      { name: "INBOX", messages: 3 },
      { name: "Drafts", special_use: "drafts", messages: 0 },
      { name: "Sent", special_use: "sent", messages: 0 },
      { name: "Archive" },
      { name: "Archive/Blåbær", messages: 0 },
    ]);
  });
  it("fails clearly when imap is not configured", async () => {
    const smtp = await smtpMock();
    await expect(run(config({ smtp }), "folders")).rejects.toThrow(/requires an imap block/);
  });
});

describe("search", () => {
  it("returns newest-first summaries with folder and uidvalidity", async () => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    const { result } = await run(config({ imap }), "search");
    expect(result.folder).toBe("INBOX");
    expect(result.uidvalidity).toBe(77);
    expect(result.total).toBe(3);
    expect(result.messages.map((m: Result) => m.uid)).toEqual([3, 2, 1]);
    expect(result.messages[1]).toEqual({
      uid: 2,
      date: new Date(2025, 1, 20, 9, 0, 0).toISOString(),
      from: "Bob <bob@example.com>",
      to: "troels@example.com, Carol <carol@example.com>",
      subject: "Second",
      flags: [],
      size: expect.any(Number),
    });
    expect(imap.commands.some((c) => /UID SEARCH ALL$/.test(c))).toBe(true);
  });
  it("applies limit after sorting newest-first", async () => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    const { result } = await run(config({ imap }), "search", { limit: "2" });
    expect(result.total).toBe(3);
    expect(result.messages.map((m: Result) => m.uid)).toEqual([3, 2]);
  });
  it("caps limit at 100 and rejects garbage", async () => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    const { result } = await run(config({ imap }), "search", { limit: "5000" });
    expect(result.messages.length).toBe(3);
    await expect(run(config({ imap }), "search", { limit: "ten" })).rejects.toThrow(/limit/);
    await expect(run(config({ imap }), "search", { limit: "0" })).rejects.toThrow(/limit/);
  });
  it("converts since/before to IMAP dates and sends unseen", async () => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    const { result } = await run(config({ imap }), "search", { since: "2025-02-01", before: "2025-03-01", unseen: "true" });
    expect(result.messages.map((m: Result) => m.uid)).toEqual([2]);
    const line = imap.commands.find((c) => c.includes("UID SEARCH"));
    expect(line).toMatch(/UID SEARCH UNSEEN SINCE 1-Feb-2025 BEFORE 1-Mar-2025$/);
  });
  it.each(["2025-13-01", "2025-02-30", "01-02-2025", "yesterday"])("rejects invalid date %s", async (since) => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    await expect(run(config({ imap }), "search", { since })).rejects.toThrow(/since must be a date/);
  });
  it("builds FROM/TO/SUBJECT/TEXT criteria as quoted strings", async () => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    const { result } = await run(config({ imap }), "search", { from: "alice", subject: "Third", query: "third" });
    expect(result.messages.map((m: Result) => m.uid)).toEqual([3]);
    const line = imap.commands.find((c) => c.includes("UID SEARCH"));
    expect(line).toMatch(/ UID SEARCH FROM "alice" SUBJECT "Third" TEXT "third"$/);
  });
  it("sends a non-ASCII criterion as a UTF-8 literal", async () => {
    const imap = await imapMock({
      mailboxes: [{ ...seededInbox(), messages: [{ uid: 9, flags: [], internalDate: new Date(), raw: msg({ subject: "=?UTF-8?B?QmzDpWLDpnI=?=", body: "blåbær" }) }] }],
    });
    const { result } = await run(config({ imap }), "search", { query: "blåbær" });
    expect(result.messages.map((m: Result) => m.uid)).toEqual([9]);
    const line = imap.commands.find((c) => c.includes("UID SEARCH"));
    expect(line).toMatch(/UID SEARCH CHARSET UTF-8 TEXT \{\d+\}$/);
    expect(imap.literals.some((l) => l.toString("utf8") === "blåbær")).toBe(true);
  });
  it("refuses two non-ASCII free-text criteria with a clear error", async () => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    await expect(run(config({ imap }), "search", { from: "jürgen", subject: "blåbær" })).rejects.toThrow(/only one .* non-ASCII/);
  });
  it("reports BADCHARSET plainly", async () => {
    const imap = await imapMock({ mailboxes: mailboxes(), badCharset: true });
    await expect(run(config({ imap }), "search", { subject: "blåbær" })).rejects.toThrow(/cannot search non-ASCII/);
  });
  it("truncates long summary fields to 512 chars", async () => {
    const long = "x".repeat(700);
    const imap = await imapMock({
      mailboxes: [{ ...seededInbox(), messages: [{ uid: 1, flags: [], internalDate: new Date(), raw: msg({ subject: long }) }] }],
    });
    const { result } = await run(config({ imap }), "search");
    expect(result.messages[0].subject.length).toBe(512);
  });
  it("searches another folder", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([{ name: "Archive", messages: [{ uid: 5, flags: [], internalDate: new Date(), raw: msg({ subject: "Old" }) }] }]) });
    const { result } = await run(config({ imap }), "search", { folder: "Archive" });
    expect(result.folder).toBe("Archive");
    expect(result.messages.map((m: Result) => m.subject)).toEqual(["Old"]);
  });
});

describe("read", () => {
  it("reads a plain message with headers and never sets \\Seen", async () => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    const { result } = await run(config({ imap }), "read", { uid: "2" });
    expect(result).toMatchObject({
      uid: 2,
      folder: "INBOX",
      uidvalidity: 77,
      message_id: "<two@example.com>",
      from: "Bob <bob@example.com>",
      to: "troels@example.com, Carol <carol@example.com>",
      subject: "Second",
      text: "second body",
      truncated: false,
      attachments: [],
    });
    expect(result.in_reply_to).toBeNull();
    expect(result.cc).toBeNull();
    expect(imap.mailbox("INBOX")!.messages[1]!.flags).toEqual([]);
    expect(imap.commands.some((c) => /^A\d+ EXAMINE/.test(c))).toBe(true);
    expect(imap.commands.filter((c) => /BODY\[/.test(c) && !/BODY\.PEEK\[/.test(c))).toEqual([]);
    expect(imap.commands.some((c) => /BODY\.PEEK\[1\]<0\.\d+>/.test(c))).toBe(true);
  });
  it("converts html to text when no plain part exists", async () => {
    const raw = msg({ contentType: "text/html; charset=utf-8", body: '<p>Hello <b>there</b></p><p>See <a href="https://x.example/">this</a>.</p>' });
    const imap = await imapMock({ mailboxes: [{ ...seededInbox(), messages: [{ uid: 1, flags: [], internalDate: new Date(), raw }] }] });
    const { result } = await run(config({ imap }), "read", { uid: "1" });
    expect(result.text).toMatch(/Hello there/);
    expect(result.text).toMatch(/this \[https:\/\/x\.example\/\]/);
    expect(result.text).not.toMatch(/<p>/);
  });
  it("decodes base64 with a non-UTF-8 charset", async () => {
    const latin1 = Buffer.from("Blåbær på ø", "latin1").toString("base64");
    const raw = msg({ contentType: "text/plain; charset=iso-8859-1", extraHeaders: "Content-Transfer-Encoding: base64", body: latin1 });
    const imap = await imapMock({ mailboxes: [{ ...seededInbox(), messages: [{ uid: 1, flags: [], internalDate: new Date(), raw }] }] });
    const { result } = await run(config({ imap }), "read", { uid: "1" });
    expect(result.text).toBe("Blåbær på ø");
  });
  it("decodes quoted-printable", async () => {
    const raw = msg({ extraHeaders: "Content-Transfer-Encoding: quoted-printable", body: "Bl=C3=A5b=C3=A6r" });
    const imap = await imapMock({ mailboxes: [{ ...seededInbox(), messages: [{ uid: 1, flags: [], internalDate: new Date(), raw }] }] });
    const { result } = await run(config({ imap }), "read", { uid: "1" });
    expect(result.text).toBe("Blåbær");
  });
  it("truncates to max_chars and says so", async () => {
    const raw = msg({ body: "abcdefghij".repeat(100) });
    const imap = await imapMock({ mailboxes: [{ ...seededInbox(), messages: [{ uid: 1, flags: [], internalDate: new Date(), raw }] }] });
    const { result } = await run(config({ imap }), "read", { uid: "1", max_chars: "25" });
    expect(result.text).toBe("abcdefghijabcdefghijabcde");
    expect(result.truncated).toBe(true);
    await expect(run(config({ imap }), "read", { uid: "1", max_chars: "-3" })).rejects.toThrow(/max_chars/);
  });
  it("prefers the plain part of a multipart message and lists attachments", async () => {
    const raw = [
      "From: Alice <alice@example.com>",
      "To: troels@example.com",
      "Cc: carol@example.com",
      "Subject: Report",
      "Date: Mon, 3 Mar 2025 10:00:00 +0000",
      "Message-ID: <rep@example.com>",
      "In-Reply-To: <orig@example.com>",
      "References: <root@example.com> <orig@example.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="B1"',
      "",
      "--B1",
      'Content-Type: multipart/alternative; boundary="B2"',
      "",
      "--B2",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "plain version",
      "--B2",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>html version</p>",
      "--B2--",
      "--B1",
      'Content-Type: application/pdf; name="report.pdf"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="report.pdf"',
      "",
      "JVBERi0xLjQK",
      "--B1--",
      "",
    ].join("\r\n");
    const imap = await imapMock({ mailboxes: [{ ...seededInbox(), messages: [{ uid: 4, flags: [], internalDate: new Date(), raw }] }] });
    const { result } = await run(config({ imap }), "read", { uid: "4" });
    expect(result.text).toBe("plain version");
    expect(result.cc).toBe("carol@example.com");
    expect(result.in_reply_to).toBe("<orig@example.com>");
    expect(result.references).toBe("<root@example.com> <orig@example.com>");
    expect(result.attachments).toEqual([{ filename: "report.pdf", content_type: "application/pdf", size: expect.any(Number) }]);
    expect(imap.commands.some((c) => /BODY\.PEEK\[1\.1\]/.test(c))).toBe(true);
  });
  it("reports a missing uid as not found and rejects bad uids", async () => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    await expect(run(config({ imap }), "read", { uid: "99" })).rejects.toThrow(/not found/);
    await expect(run(config({ imap }), "read", { uid: "abc" })).rejects.toThrow(/uid must be a positive integer/);
    await expect(run(config({ imap }), "read", {})).rejects.toThrow(/uid/);
  });
});

describe("mark", () => {
  it.each<[string, string[]]>([
    ["seen", ["\\Seen"]],
    ["flagged", ["\\Flagged"]],
  ])("%s adds the flag", async (flag, expected) => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    const { result } = await run(config({ imap }), "mark", { uid: "2", flag });
    expect(result).toEqual({ uid: 2, flags: expected });
    expect(imap.mailbox("INBOX")!.messages[1]!.flags).toEqual(expected);
  });
  it("unseen / unflagged remove flags", async () => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    imap.mailbox("INBOX")!.messages[0]!.flags = ["\\Seen", "\\Flagged"];
    expect((await run(config({ imap }), "mark", { uid: "1", flag: "unseen" })).result.flags).toEqual(["\\Flagged"]);
    expect((await run(config({ imap }), "mark", { uid: "1", flag: "unflagged" })).result.flags).toEqual([]);
  });
  it("rejects unknown flags and missing messages", async () => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    await expect(run(config({ imap }), "mark", { uid: "1", flag: "starred" })).rejects.toThrow(/flag must be one of/);
    await expect(run(config({ imap }), "mark", { uid: "50", flag: "seen" })).rejects.toThrow(/not found/);
  });
});

describe("send", () => {
  it("sends a plain message and returns the message id", async () => {
    const smtp = await smtpMock();
    const { result } = await run(config({ smtp }), "send", { to: "bob@example.com", subject: "Hi", body: "Hello\nthere" });
    expect(result.accepted).toBe(true);
    expect(result.message_id).toMatch(/^<[^@]+@example\.com>$/);
    expect(Object.keys(result).sort()).toEqual(["accepted", "message_id"]);
    expect(smtp.messages).toHaveLength(1);
    const [m] = smtp.messages;
    expect(m!.from).toBe("troels@example.com");
    expect(m!.to).toEqual(["bob@example.com"]);
    expect(m!.data).toContain("From: Troels <troels@example.com>");
    expect(m!.data).toContain("Subject: Hi");
    expect(m!.data).toContain(`Message-ID: ${result.message_id}`);
    expect(m!.data).toContain("Hello\r\nthere");
  });
  it("sends to several recipients through `to` alone", async () => {
    const smtp = await smtpMock();
    await run(config({ smtp }), "send", { to: "a@example.com, b@example.com", subject: "Hi", body: "x" });
    expect(smtp.messages[0]!.to).toEqual(["a@example.com", "b@example.com"]);
  });
  it("has no recipient parameter other than `to` — what a pin on `to` relies on", async () => {
    // A second recipient-bearing parameter (cc, bcc) would let an agent aim
    // mail past a pinned `to`, so a supplied one is an unknown parameter to
    // the host and, if it ever reached the driver, is ignored on the wire.
    for (const action of ["send", "draft"]) {
      expect(driver.actions[action]!.params!.map((p) => p.name)).not.toContain("cc");
      expect(driver.actions[action]!.params!.map((p) => p.name)).not.toContain("bcc");
    }
    const smtp = await smtpMock();
    await run(config({ smtp }), "send", { to: "ops@example.com", cc: "attacker@example.com", subject: "Hi", body: "x" });
    expect(smtp.messages[0]!.to).toEqual(["ops@example.com"]);
    expect(smtp.messages[0]!.data).not.toContain("attacker@example.com");
  });
  it("works with a pinned-style fixed recipient and does not echo it", async () => {
    const smtp = await smtpMock();
    const { result } = await run(config({ smtp }), "send", { to: "ops@example.com", subject: "Alert", body: "disk full" });
    expect(JSON.stringify(result)).not.toContain("ops@example.com");
    expect(smtp.messages[0]!.to).toEqual(["ops@example.com"]);
  });
  it("requires a subject unless replying", async () => {
    const smtp = await smtpMock();
    await expect(run(config({ smtp }), "send", { to: "a@example.com", body: "x" })).rejects.toThrow(/subject/);
  });
  it("sends a reply to the original sender when `to` is omitted", async () => {
    const imap = await imapMock({
      mailboxes: [{ ...seededInbox(), messages: [{ uid: 2, flags: [], internalDate: new Date(), raw: msg({ subject: "Second", from: "Alice <alice@example.com>", messageId: "<two@example.com>" }) }] }],
    });
    const smtp = await smtpMock();
    const { result } = await run(config({ smtp, imap }), "send", { body: "thanks", reply_to_uid: "2" });
    expect(result.accepted).toBe(true);
    expect(smtp.messages[0]!.to).toEqual(["alice@example.com"]);
    expect(smtp.messages[0]!.data).toMatch(/^To: alice@example.com\r?$/m);
  });
  it("reports a folder that does not exist as not_found", async () => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    const err = await failure(config({ imap }), "search", { folder: "Inbx" });
    expect(err).toBeInstanceOf(YapError);
    expect(agentSafe(err)).toEqual({ agentSafe: true, code: "not_found" });
    expect(err.message).toMatch(/folder "Inbx" not found/);
  });
  it("threads a reply: In-Reply-To, References and Re:", async () => {
    const imap = await imapMock({
      mailboxes: [{ ...seededInbox(), messages: [{ uid: 2, flags: [], internalDate: new Date(), raw: msg({ subject: "Second", messageId: "<two@example.com>", extraHeaders: "References: <root@example.com>" }) }] }],
    });
    const smtp = await smtpMock();
    const { result } = await run(config({ smtp, imap }), "send", { to: "bob@example.com", body: "thanks", reply_to_uid: "2" });
    expect(result.accepted).toBe(true);
    const data = smtp.messages[0]!.data;
    expect(data).toContain("Subject: Re: Second");
    expect(data).toContain("In-Reply-To: <two@example.com>");
    expect(data).toContain("References: <root@example.com> <two@example.com>");
  });
  it("does not double the Re: prefix and keeps an explicit subject", async () => {
    const imap = await imapMock({
      mailboxes: [{ ...seededInbox(), messages: [{ uid: 2, flags: [], internalDate: new Date(), raw: msg({ subject: "RE: Second", messageId: "<two@example.com>" }) }] }],
    });
    const smtp = await smtpMock();
    await run(config({ smtp, imap }), "send", { to: "bob@example.com", body: "x", reply_to_uid: "2" });
    expect(smtp.messages[0]!.data).toContain("Subject: RE: Second");
    await run(config({ smtp, imap }), "send", { to: "bob@example.com", body: "x", reply_to_uid: "2", subject: "Other" });
    expect(smtp.messages[1]!.data).toContain("Subject: Other");
  });
  it("refuses a reply when imap is not configured", async () => {
    const smtp = await smtpMock();
    await expect(run(config({ smtp }), "send", { to: "a@example.com", body: "x", reply_to_uid: "2" })).rejects.toThrow(/reply_to_uid requires an imap block/);
  });
  it("appends a copy to the Sent folder when save_sent is on", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([{ name: "Sent Items", attributes: ["\\Sent"], messages: [] }]) });
    const smtp = await smtpMock();
    const { result } = await run(config({ smtp, imap, save_sent: true }), "send", { to: "bob@example.com", subject: "Hi", body: "x" });
    expect(result.accepted).toBe(true);
    const sent = imap.mailbox("Sent Items")!.messages;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.flags).toEqual(["\\Seen"]);
    expect(sent[0]!.raw).toContain(`Message-ID: ${result.message_id}`);
  });
  it("fails clearly when smtp is not configured", async () => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    await expect(run(config({ imap }), "send", { to: "a@example.com", subject: "s", body: "x" })).rejects.toThrow(/requires an smtp block/);
  });
  it("rejects header injection in subject and addresses", async () => {
    const smtp = await smtpMock();
    await expect(run(config({ smtp }), "send", { to: "a@example.com", subject: "Hi\r\nBcc: x@example.com", body: "x" })).rejects.toThrow(/subject must not contain a line break/);
    await expect(run(config({ smtp }), "send", { to: "a@example.com\r\nBcc: b@example.com", subject: "Hi", body: "x" })).rejects.toThrow(/to/);
    expect(smtp.messages).toHaveLength(0);
  });
  it("surfaces an RCPT rejection without sending", async () => {
    const smtp = await smtpMock({ rejectRcpt: ["nobody@example.com"] });
    await expect(run(config({ smtp }), "send", { to: "nobody@example.com", subject: "s", body: "x" })).rejects.toThrow(/refused a recipient/);
    expect(smtp.messages).toHaveLength(0);
  });
});

describe("draft", () => {
  const params = { to: "bob@example.com", subject: "Proposal", body: "Draft text" };
  it("lands in the \\Drafts folder with \\Draft and reports the APPENDUID", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([{ name: utf7Encode("Entwürfe"), attributes: ["\\Drafts"], messages: [] }]) });
    const { result } = await run(config({ imap }), "draft", params);
    expect(result).toEqual({ folder: "Entwürfe", uid: 1 });
    const drafts = imap.mailbox(utf7Encode("Entwürfe"))!.messages;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.flags).toEqual(["\\Draft"]);
    expect(drafts[0]!.raw).toContain("Subject: Proposal");
    expect(drafts[0]!.raw).toContain("To: bob@example.com");
  });
  it("reports uid null without UIDPLUS", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([{ name: "Drafts", attributes: ["\\Drafts"], messages: [] }]), noUidplus: true });
    const { result } = await run(config({ imap }), "draft", params);
    expect(result).toEqual({ folder: "Drafts", uid: null });
  });
  it("finds a folder named Drafts (last segment, case-insensitive) without the attribute", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([{ name: "INBOX/drafts", messages: [] }]) });
    const { result } = await run(config({ imap }), "draft", params);
    expect(result.folder).toBe("INBOX/drafts");
    expect(imap.mailbox("INBOX/drafts")!.messages).toHaveLength(1);
  });
  it("honours drafts_folder over discovery", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([{ name: "Drafts", attributes: ["\\Drafts"], messages: [] }, { name: "Proposals", messages: [] }]) });
    const { result } = await run(config({ imap, drafts_folder: "Proposals" }), "draft", params);
    expect(result.folder).toBe("Proposals");
    expect(imap.mailbox("Proposals")!.messages).toHaveLength(1);
    expect(imap.mailbox("Drafts")!.messages).toHaveLength(0);
  });
  it("asks for drafts_folder when nothing matches", async () => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    await expect(run(config({ imap }), "draft", params)).rejects.toThrow(/set drafts_folder/);
  });
  it("threads a drafted reply", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([{ name: "Drafts", attributes: ["\\Drafts"], messages: [] }]) });
    await run(config({ imap }), "draft", { to: "bob@example.com", body: "x", reply_to_uid: "3" });
    const raw = imap.mailbox("Drafts")!.messages[0]!.raw;
    expect(raw).toContain("Subject: Re: Third");
    expect(raw).toContain("In-Reply-To: <three@example.com>");
    expect(raw).toContain("References: <three@example.com>");
  });
  it("addresses a reply to the original sender when `to` is omitted", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([{ name: "Drafts", attributes: ["\\Drafts"], messages: [] }]) });
    await run(config({ imap }), "draft", { body: "x", reply_to_uid: "3" });
    const raw = imap.mailbox("Drafts")!.messages[0]!.raw;
    expect(raw).toMatch(/^To: alice@example.com\r?$/m);
  });
  it("prefers Reply-To over From for an addressless reply", async () => {
    const inbox: MockMailboxSeed = { name: "INBOX", messages: [{ uid: 9, flags: [], internalDate: new Date("2025-03-03T10:00:00Z"), raw: simpleMessage({ subject: "Ask", messageId: "<nine@example.com>", extraHeaders: "Reply-To: Desk <desk@example.com>\r\n" }) }] };
    const imap = await imapMock({ mailboxes: [inbox, { name: "Drafts", attributes: ["\\Drafts"], messages: [] }] });
    await run(config({ imap }), "draft", { body: "x", reply_to_uid: "9" });
    expect(imap.mailbox("Drafts")!.messages[0]!.raw).toMatch(/^To: desk@example.com\r?$/m);
  });
  it("requires `to` when not replying", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([{ name: "Drafts", attributes: ["\\Drafts"], messages: [] }]) });
    await expect(run(config({ imap }), "draft", { subject: "x", body: "x" })).rejects.toThrow(/to is required unless reply_to_uid/);
  });
  it("fails clearly when imap is not configured", async () => {
    const smtp = await smtpMock();
    await expect(run(config({ smtp }), "draft", params)).rejects.toThrow(/requires an imap block/);
  });
});

describe("run plumbing", () => {
  it("rejects an unknown action", async () => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    await expect(run(config({ imap }), "explode")).rejects.toThrow(/unknown action/);
  });
  it("never leaks the password or hosts into results", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([{ name: "Drafts", attributes: ["\\Drafts"], messages: [] }]) });
    const smtp = await smtpMock();
    const cfg = config({ imap, smtp });
    const runs: Array<[string, Record<string, string>]> = [
      ["folders", {}],
      ["search", {}],
      ["read", { uid: "1" }],
      ["mark", { uid: "1", flag: "flagged" }],
      ["send", { to: "bob@example.com", subject: "s", body: "b" }],
      ["draft", { to: "bob@example.com", subject: "s", body: "b" }],
    ];
    for (const [action, params] of runs) {
      const { result } = await run(cfg, action, params);
      const text = JSON.stringify(result);
      expect(text, action).not.toContain(PASS);
      expect(text, action).not.toContain("imap.example.test");
      expect(text, action).not.toContain("smtp.example.test");
    }
  });
  it("keeps the password out of an authentication error", async () => {
    const imap = await imapMock({ mailboxes: mailboxes(), authFail: true });
    const error = await failure(config({ imap }), "folders");
    expect(error.message).toMatch(/authentication failed/);
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(PASS);
  });
});

describe("agent-visible failures (YapError)", () => {
  const drafts = (): MockMailboxSeed[] => [{ name: "Drafts", attributes: ["\\Drafts"], messages: [] }];
  const INVALID = { agentSafe: true, code: "invalid_request" };
  const NOT_FOUND = { agentSafe: true, code: "not_found" };

  it("marks every parameter validation error agent-safe", async () => {
    const imap = await imapMock({ mailboxes: mailboxes(drafts()) });
    const smtp = await smtpMock();
    const cfg = config({ imap, smtp });
    const cases: Array<[string, Record<string, string>, RegExp]> = [
      ["read", {}, /uid is required/],
      ["read", { uid: "abc" }, /uid must be a positive integer/],
      ["read", { uid: "1", max_chars: "-3" }, /max_chars must be a positive integer/],
      ["read", { uid: "1", folder: "IN\r\nBOX" }, /folder must be a mailbox name/],
      ["search", { limit: "x" }, /limit must be a positive integer/],
      ["search", { since: "2025-02-30" }, /since must be a date/],
      ["search", { before: "yesterday" }, /before must be a date/],
      ["search", { subject: "a\r\nb" }, /subject must be a single line/],
      ["search", { from: "jürgen", subject: "blåbær" }, /only one .* non-ASCII/],
      ["search", { query: "x".repeat(1001) }, /query .*1000/],
      ["mark", { uid: "1", flag: "starred" }, /flag must be one of/],
      ["send", { to: "a@example.com", body: "x" }, /subject is required unless reply_to_uid/],
      ["send", { subject: "s", body: "x" }, /to is required unless reply_to_uid/],
      ["send", { to: "a@example.com", subject: "s" }, /body is required/],
      ["send", { to: "a@example.com", subject: "Hi\r\nBcc: x@example.com", body: "x" }, /subject must not contain a line break/],
      ["send", { to: "a@example.com\r\nBcc: b@example.com", subject: "Hi", body: "x" }, /to/],
      ["send", { to: "not-an-address", subject: "Hi", body: "x" }, /to/],
      ["send", { to: "a@example.com", subject: "s", body: "x", reply_to_uid: "zero" }, /reply_to_uid must be a positive integer/],
      ["send", { to: "a@example.com", subject: "s", body: "x".repeat(1024 * 1024 + 1) }, /body .*1 MiB/],
      ["draft", { to: "a@example.com", subject: "s", body: "é".repeat(600_000) }, /body .*1 MiB/],
    ];
    for (const [action, params, re] of cases) {
      const e = await failure(cfg, action, params);
      const label = `${action} ${JSON.stringify(params).slice(0, 60)}`;
      expect(e.message, label).toMatch(re);
      expect(e, label).toBeInstanceOf(YapError);
      expect(agentSafe(e), label).toEqual(INVALID);
    }
    expect(smtp.messages).toHaveLength(0);
  });

  it("accepts a body of exactly 1 MiB and a criterion of exactly 1000 chars", async () => {
    const imap = await imapMock({ mailboxes: mailboxes(drafts()) });
    await run(config({ imap }), "draft", { to: "a@example.com", subject: "s", body: "x".repeat(1024 * 1024) });
    const { result } = await run(config({ imap }), "search", { subject: "y".repeat(1000) });
    expect(result.messages).toEqual([]);
  });

  it("marks a missing block, an unknown action, and a missing folder agent-safe", async () => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    const smtp = await smtpMock();
    expect(agentSafe(await failure(config({ smtp }), "folders"))).toEqual(INVALID);
    expect(agentSafe(await failure(config({ imap }), "send", { to: "a@example.com", subject: "s", body: "x" }))).toEqual(INVALID);
    expect(agentSafe(await failure(config({ smtp }), "send", { body: "x", reply_to_uid: "1" }))).toEqual(INVALID);
    expect(agentSafe(await failure(config({ imap }), "explode"))).toEqual(INVALID);
    const e = await failure(config({ imap }), "draft", { to: "a@example.com", subject: "s", body: "x" });
    expect(e.message).toMatch(/no drafts folder found .* set drafts_folder/);
    expect(agentSafe(e)).toEqual(INVALID);
  });

  it("maps a missing message to not_found for read, mark, and reply", async () => {
    const imap = await imapMock({ mailboxes: mailboxes(drafts()) });
    const cases: Array<[string, Record<string, string>]> = [
      ["read", { uid: "99" }],
      ["mark", { uid: "99", flag: "seen" }],
      ["draft", { body: "x", reply_to_uid: "99" }],
    ];
    for (const [action, params] of cases) {
      const e = await failure(config({ imap }), action, params);
      expect(e.message, action).toMatch(/message 99 not found/);
      expect(agentSafe(e), action).toEqual(NOT_FOUND);
    }
  });

  it("marks BADCHARSET and a reply with no usable sender agent-safe", async () => {
    const imap = await imapMock({ mailboxes: mailboxes(), badCharset: true });
    expect(agentSafe(await failure(config({ imap }), "search", { subject: "blåbær" }))).toEqual(INVALID);
    const inbox: MockMailboxSeed = { name: "INBOX", messages: [{ uid: 9, flags: [], internalDate: new Date("2025-03-03T10:00:00Z"), raw: simpleMessage({ from: "undisclosed", subject: "Ask", messageId: "<nine@example.com>" }) }] };
    const imap2 = await imapMock({ mailboxes: [inbox, ...drafts()] });
    const e = await failure(config({ imap: imap2 }), "draft", { body: "x", reply_to_uid: "9" });
    expect(e.message).toMatch(/no usable Reply-To or From/);
    expect(agentSafe(e)).toEqual(INVALID);
  });

  it("reports a refused recipient without the address; the reply stays in the log", async () => {
    const smtp = await smtpMock({ rejectRcpt: ["nobody@example.com"] });
    const ctx = createCtx(createFakeEgress());
    Object.assign(ctx, { config: config({ smtp }), action: "send", params: { to: "nobody@example.com", subject: "s", body: "x" } });
    let error: Error | undefined;
    await driver.run(ctx).catch((e: Error) => (error = e));
    expect(error!.message).toBe("the server refused a recipient");
    expect(agentSafe(error!)).toEqual(INVALID);
    expect(JSON.stringify({ ...error, message: error!.message })).not.toContain("nobody@example.com");
    expect(ctx.logs.join("\n")).toMatch(/nobody@example.com.*550|550.*nobody@example.com/);
    expect(smtp.messages).toHaveLength(0);
  });

  it("does not mark protocol, authentication, or run-time config failures agent-safe", async () => {
    const authFail = await imapMock({ mailboxes: mailboxes(), authFail: true });
    const e1 = await failure(config({ imap: authFail }), "folders");
    expect(e1.message).toMatch(/authentication failed/);
    expect(e1).not.toBeInstanceOf(YapError);
    const bye = await imapMock({ mailboxes: mailboxes(), byeOn: "LIST" });
    const e2 = await failure(config({ imap: bye }), "folders");
    expect(e2).not.toBeInstanceOf(YapError);
    // A config that no longer normalises is the operator's problem: it must
    // collapse on the run row, not be shown to the agent as their mistake.
    const badConfig = await failure({ ...config({ imap: authFail }), from: "nope" }, "folders");
    expect(badConfig).not.toBeInstanceOf(YapError);
    expect(badConfig.message).toMatch(/from/);
  });
});

describe("validateConfigOnline", () => {
  it("authenticates against every configured block", async () => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    const smtp = await smtpMock({ requireAuth: true });
    await expect(driver.validateConfigOnline!(config({ imap, smtp }), createFakeEgress())).resolves.toBeUndefined();
    expect(imap.auth).toHaveLength(1);
    expect(imap.commands.some((c) => /LOGOUT/.test(c))).toBe(true);
    expect(smtp.authLines).toHaveLength(1);
    expect(smtp.commands.some((c) => /^QUIT/i.test(c))).toBe(true);
    expect(smtp.messages).toHaveLength(0);
  });
  it("fails on a bad password", async () => {
    const imap = await imapMock({ mailboxes: mailboxes(), authFail: true });
    await expect(driver.validateConfigOnline!(config({ imap }), createFakeEgress())).rejects.toThrow(/imap: authentication failed/);
  });
  it("fails on a bad smtp password", async () => {
    const smtp = await smtpMock({ rejectAuth: true });
    await expect(driver.validateConfigOnline!(config({ smtp }), createFakeEgress())).rejects.toThrow(/smtp/);
  });
});
