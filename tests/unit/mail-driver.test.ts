/**
 * The mail driver's actions against the in-process IMAP and SMTP mocks:
 * what each returns, what goes on the wire, and — the part that matters most
 * for a built-in — which failures reach an agent. A `YapError` is shown to
 * the agent verbatim by the runs layer; anything else collapses to "run
 * failed", so every case here asserts not just the message but the class.
 */
import { afterEach, describe, expect, it } from "vitest";

import { normalizeMailConfig } from "../../src/core/drivers/mail/config.js";
import { createMailDriver } from "../../src/core/drivers/mail/index.js";
import type { BundleFile, BundleReader, BundleWriter } from "../../src/core/drivers/types.js";
import { YapError } from "../../src/core/errors.js";
import { createCtx, createFakeEgress } from "../helpers/mail/egress.js";
import { simpleMessage, startImapMock, utf7Encode, type ImapMock, type ImapMockOptions, type MockMailboxSeed } from "../helpers/mail/imap-mock.js";
import { parseMessage } from "../helpers/mail/mime.js";
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

async function run(
  cfg: Config,
  action: string,
  params: Record<string, string> = {},
  { pinned = [], reader = null }: { pinned?: readonly string[]; reader?: BundleReader | null } = {},
): Promise<{ result: Result; ctx: ReturnType<typeof createCtx> }> {
  const ctx = createCtx(createFakeEgress(), { pinned });
  ctx.reader = reader;
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
  it("declares the mail driver actions and their params", () => {
    expect(driver.name).toBe("mail");
    expect(driver.api).toBe(1);
    expect(driver.egress).toBe(true);
    expect(Object.keys(driver.actions).sort()).toEqual(["attachment", "delete_draft", "draft", "folders", "mark", "read", "search", "send"]);
    expect(driver.writes).toEqual({ files: true });
    expect(driver.reads).toEqual({ files: true });
    for (const action of ["send", "draft"]) {
      const spec = driver.actions[action]!;
      expect(spec.description, action).not.toMatch(/plain-text/i);
      const attachments = spec.params!.find((p) => p.name === "attachments");
      expect(attachments, action).toMatchObject({ required: false });
      expect(attachments!.description).toMatch(/file:\/\/\{uuid\}/);
      expect(attachments!.description).toMatch(/this bundle/);
      expect(attachments!.description).toMatch(/18 MiB/);
      expect(attachments!.description).toMatch(/10 files/);
    }
    expect(driver.actions["attachment"]!.params!.map((p) => [p.name, p.required])).toEqual([
      ["uid", true],
      ["folder", false],
      ["part", true],
    ]);
    for (const [name, spec] of Object.entries(driver.actions)) {
      expect(spec.description, name).toBeTypeOf("string");
      expect(Array.isArray(spec.params), name).toBe(true);
      expect(Number.isInteger(spec.timeoutMs) && spec.timeoutMs > 0, name).toBe(true);
    }
    expect(driver.actions["send"]!.params!.filter((p) => p.required).map((p) => p.name)).toEqual(["body"]);
    expect(driver.actions["delete_draft"]!.params!.map((p) => p.name)).toEqual(["uid"]);
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
    expect(result.attachments).toEqual([{ part: "2", filename: "report.pdf", content_type: "application/pdf", size: expect.any(Number) }]);
    expect(imap.commands.some((c) => /BODY\.PEEK\[1\.1\]/.test(c))).toBe(true);
  });
  it("reports a missing uid as not found and rejects bad uids", async () => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    await expect(run(config({ imap }), "read", { uid: "99" })).rejects.toThrow(/not found/);
    await expect(run(config({ imap }), "read", { uid: "abc" })).rejects.toThrow(/uid must be a positive integer/);
    await expect(run(config({ imap }), "read", {})).rejects.toThrow(/uid/);
  });
});

type StoredFile = { name: string; mimeType?: string; bytes: Buffer };

/** A bundle writer that keeps what it was handed instead of storing it. */
function fakeWriter(): { writer: BundleWriter; files: StoredFile[] } {
  const files: StoredFile[] = [];
  const writer: BundleWriter = {
    createItems: async () => {
      throw new Error("fake writer: no item writes");
    },
    updateItems: async () => {
      throw new Error("fake writer: no item writes");
    },
    writeFile: async (input) => {
      const bytes = Buffer.from(input.bytes ?? "");
      files.push({ name: input.name, mimeType: input.mimeType, bytes });
      const id = `file-${files.length}`;
      return { id, ref: `file://${id}`, name: input.name, mimeType: input.mimeType ?? "", size: bytes.length, status: "finalized", createdAt: "2026-11-12T00:00:00.000Z" };
    },
  };
  return { writer, files };
}

/** One message: a text body, then each given part, all inside multipart/mixed. */
function withParts(...parts: string[][]): string {
  return [
    "From: Alice <alice@example.com>",
    "To: troels@example.com",
    "Subject: Files",
    "Date: Mon, 3 Mar 2025 10:00:00 +0000",
    "Message-ID: <files@example.com>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="B1"',
    "",
    "--B1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "see attached",
    ...parts.flatMap((p) => ["--B1", ...p]),
    "--B1--",
    "",
  ].join("\r\n");
}

describe("attachment", () => {
  const PDF = Buffer.from("%PDF-1.4\n\u0000ÿ binary-ish bytes \u0001\u0002", "latin1");
  const pdfPart = (disposition = 'attachment; filename="report.pdf"'): string[] => [
    'Content-Type: application/pdf; name="report.pdf"',
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${disposition}`,
    "",
    PDF.toString("base64"),
  ];

  async function attach(raw: string, params: Record<string, string>, { bodystructure, writeFile }: { bodystructure?: string; writeFile?: BundleWriter["writeFile"] } = {}) {
    const imap = await imapMock({ mailboxes: [{ ...seededInbox(), messages: [{ uid: 5, flags: [], internalDate: new Date(), raw, bodystructure }] }] });
    const { writer: fake, files } = fakeWriter();
    const writer = writeFile ? { ...fake, writeFile } : fake;
    const ctx = createCtx(createFakeEgress());
    ctx.config = config({ imap });
    ctx.action = "attachment";
    ctx.params = { uid: "5", ...params };
    ctx.writer = writer;
    let result: Result;
    let error: Error | undefined;
    try {
      result = await driver.run(ctx);
    } catch (e) {
      error = e as Error;
    }
    // No action of this one ever writes to the mailbox.
    expect(imap.commands.filter((c) => /UID STORE|\bSTORE\b|APPEND|EXPUNGE/.test(c))).toEqual([]);
    expect(imap.commands.filter((c) => /BODY\[/.test(c) && !/BODY\.PEEK\[/.test(c))).toEqual([]);
    // Any folder it opened, it opened read-only.
    expect(imap.commands.filter((c) => /^A\d+ SELECT/.test(c))).toEqual([]);
    expect(imap.mailbox("INBOX")!.messages.find((m) => m.uid === 5)!.flags).toEqual([]);
    return { result, error, files, imap };
  }

  it("downloads a base64 attachment into the bundle, byte for byte", async () => {
    const { result, error, files, imap } = await attach(withParts(pdfPart()), { part: "2" });
    expect(error).toBeUndefined();
    expect(imap.commands.some((c) => /^A\d+ EXAMINE/.test(c))).toBe(true);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("report.pdf");
    expect(files[0]!.mimeType).toBe("application/pdf");
    expect(files[0]!.bytes.equals(PDF)).toBe(true);
    expect(result).toEqual({
      uid: 5,
      folder: "INBOX",
      part: "2",
      filename: "report.pdf",
      content_type: "application/pdf",
      size: PDF.length,
      file: expect.objectContaining({ id: "file-1", ref: "file://file-1", name: "report.pdf", size: PDF.length }),
    });
  });

  it("decodes a quoted-printable attachment", async () => {
    const part = ['Content-Type: text/csv; charset=utf-8; name="data.csv"', "Content-Transfer-Encoding: quoted-printable", 'Content-Disposition: attachment; filename="data.csv"', "", "navn,by", "Bl=C3=A5b=C3=A6r,K=C3=B8ben=", "havn=  ", ",x"];
    const { result, files } = await attach(withParts(part), { part: "2" });
    expect(files[0]!.bytes.toString("utf8")).toBe("navn,by\r\nBlåbær,København,x");
    expect(result.content_type).toBe("text/csv");
    expect(files[0]!.mimeType).toBe("text/csv");
  });

  it("downloads a nested part and lists its part id on read", async () => {
    const raw = [
      "From: Alice <alice@example.com>",
      "To: troels@example.com",
      "Subject: Nested",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="B1"',
      "",
      "--B1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "body",
      "--B1",
      'Content-Type: multipart/related; boundary="B2"',
      "",
      "--B2",
      'Content-Type: image/png; name="logo.png"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("PNGDATA").toString("base64"),
      "--B2--",
      "--B1--",
      "",
    ].join("\r\n");
    const readImap = await imapMock({ mailboxes: [{ ...seededInbox(), messages: [{ uid: 5, flags: [], internalDate: new Date(), raw }] }] });
    const listed = (await run(config({ imap: readImap }), "read", { uid: "5" })).result;
    expect(listed.attachments).toEqual([{ part: "2.1", filename: "logo.png", content_type: "image/png", size: expect.any(Number) }]);
    const { result, files, imap } = await attach(raw, { part: "2.1" });
    expect(files[0]!.bytes.toString()).toBe("PNGDATA");
    expect(result).toMatchObject({ part: "2.1", filename: "logo.png", content_type: "image/png", size: 7 });
    expect(imap.commands.some((c) => /BODY\.PEEK\[2\.1\]<0\.\d+>/.test(c))).toBe(true);
  });

  it("strips path separators and control characters from the filename but keeps the extension", async () => {
    const { result, files } = await attach(withParts(pdfPart('attachment; filename="../../etc/pass\twd\\report.pdf"')), { part: "2" });
    expect(files[0]!.name).not.toMatch(/[/\\\u0000-\u001f]/);
    expect(files[0]!.name).toMatch(/report\.pdf$/);
    expect(result.filename).toBe(files[0]!.name);
  });

  it("names a nameless attachment after the message, the part, and its type", async () => {
    const part = ["Content-Type: application/pdf", "Content-Transfer-Encoding: base64", "", PDF.toString("base64")];
    const { result, files } = await attach(withParts(part), { part: "2" });
    expect(files[0]!.name).toBe("attachment-5-2.pdf");
    expect(result.filename).toBe("attachment-5-2.pdf");
  });

  it("refuses the message's text body", async () => {
    const { error, files } = await attach(withParts(pdfPart()), { part: "1" });
    expect(agentSafe(error!)).toEqual({ agentSafe: true, code: "invalid_request" });
    expect(error!.message).toMatch(/part "1"/);
    expect(error!.message).toMatch(/not an attachment/);
    expect(files).toEqual([]);
  });

  it("refuses a part that does not exist, and a section that is not a part number", async () => {
    for (const part of ["7", "2.9", "HEADER", "TEXT", "1]<0.1> UID", ""]) {
      const { error, files, imap } = await attach(withParts(pdfPart()), { part });
      expect(agentSafe(error!), part).toEqual({ agentSafe: true, code: "invalid_request" });
      expect(files, part).toEqual([]);
      // Nothing but the structure was fetched: the agent cannot name a section.
      expect(imap.commands.filter((c) => /BODY\.PEEK\[/.test(c)), part).toEqual([]);
    }
  });

  it("refuses an attachment over the cap without fetching or writing it", async () => {
    const huge = 40 * 1024 * 1024;
    const bodystructure = `(("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 12 1 NIL NIL NIL NIL)("APPLICATION" "ZIP" ("NAME" "big.zip") NIL NIL "BASE64" ${huge} NIL ("ATTACHMENT" ("FILENAME" "big.zip")) NIL NIL) "MIXED" ("BOUNDARY" "B1") NIL NIL NIL)`;
    const { error, files, imap } = await attach(withParts(pdfPart()), { part: "2" }, { bodystructure });
    expect(agentSafe(error!)).toEqual({ agentSafe: true, code: "invalid_request" });
    expect(error!.message).toMatch(/over the 25 MiB limit/);
    expect(files).toEqual([]);
    expect(imap.commands.filter((c) => /BODY\.PEEK\[2\]/.test(c))).toEqual([]);
  });

  it("refuses an attachment that only turns out over the cap once decoded, writing nothing", async () => {
    // binary: the declared size passes the up-front check (no expansion to
    // allow for), so this is the post-decode check doing the refusing.
    const part = ['Content-Type: application/octet-stream; name="big.bin"', "Content-Transfer-Encoding: binary", "", "a".repeat(25 * 1024 * 1024 + 1)];
    const { error, files } = await attach(withParts(part), { part: "2" });
    expect(agentSafe(error!)).toEqual({ agentSafe: true, code: "invalid_request" });
    expect(error!.message).toMatch(/over the 25 MiB limit \(25\.0 MiB\)/);
    expect(files).toEqual([]);
  }, 60_000);

  it("refuses an attachment whose bytes run past what its declared size allowed, writing nothing", async () => {
    // The structure claims 10 bytes; the server sends far more than any
    // 25 MiB attachment could take. Reading stops at the ceiling.
    const bodystructure = `(("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 12 1 NIL NIL NIL NIL)("APPLICATION" "OCTET-STREAM" ("NAME" "big.bin") NIL NIL "BINARY" 10 NIL NIL NIL NIL) "MIXED" ("BOUNDARY" "B1") NIL NIL NIL)`;
    const part = ['Content-Type: application/octet-stream; name="big.bin"', "Content-Transfer-Encoding: binary", "", "a".repeat(26 * 1024 * 1024)];
    const { error, files } = await attach(withParts(part), { part: "2" }, { bodystructure });
    expect(agentSafe(error!)).toEqual({ agentSafe: true, code: "invalid_request" });
    expect(error!.message).toMatch(/over the 25 MiB limit \(more than/);
    expect(files).toEqual([]);
  }, 60_000);

  it("neutralises bidi overrides and C1 controls, and shortens a long name keeping its extension", async () => {
    const { files } = await attach(withParts(pdfPart('attachment; filename="invoice\u202efdp.exe\u0085.pdf"')), { part: "2" });
    expect(files[0]!.name).toBe("invoice_fdp.exe_.pdf");
    const long = "\u{1F600}".repeat(200) + ".pdf";
    const { files: longFiles } = await attach(withParts(pdfPart(`attachment; filename="${long}"`)), { part: "2" });
    const name = longFiles[0]!.name;
    expect(name.length).toBeLessThanOrEqual(255);
    expect(name.endsWith(".pdf")).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name)).toBe(false);
  });

  it("refuses an encoding it cannot decode", async () => {
    const part = ['Content-Type: application/octet-stream; name="x.bin"', "Content-Transfer-Encoding: x-uuencode", "", "begin 644 x.bin", "end"];
    const { error, files } = await attach(withParts(part), { part: "2" });
    expect(agentSafe(error!)).toEqual({ agentSafe: true, code: "invalid_request" });
    expect(error!.message).toMatch(/x-uuencode/);
    expect(files).toEqual([]);
  });

  it("reads a part larger than one fetch window in consecutive partial fetches", async () => {
    const big = Buffer.alloc(4 * 1024 * 1024 + 12345);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 0xff;
    const wrapped = big.toString("base64").replace(/.{76}/g, "$&\r\n");
    const part = ['Content-Type: application/zip; name="big.zip"', "Content-Transfer-Encoding: base64", "", wrapped];
    const { result, files, imap } = await attach(withParts(part), { part: "2" });
    expect(files[0]!.bytes.equals(big)).toBe(true);
    expect(result.size).toBe(big.length);
    const windows = imap.commands.filter((c) => /BODY\.PEEK\[2\]/.test(c)).map((c) => /<(\d+)\.(\d+)>/.exec(c)!.slice(1).map(Number));
    expect(windows.length).toBeGreaterThan(1);
    windows.forEach(([offset, count], i) => {
      expect(count).toBe(4 * 1024 * 1024);
      expect(offset).toBe(i * 4 * 1024 * 1024);
    });
  });

  it("refuses a part the server returns short of its BODYSTRUCTURE size", async () => {
    const encoded = PDF.toString("base64");
    const bodystructure = `(("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 12 1 NIL NIL NIL NIL)("APPLICATION" "PDF" ("NAME" "report.pdf") NIL NIL "BASE64" ${encoded.length + 500} NIL ("ATTACHMENT" ("FILENAME" "report.pdf")) NIL NIL) "MIXED" ("BOUNDARY" "B1") NIL NIL NIL)`;
    const { error, files } = await attach(withParts(pdfPart()), { part: "2" }, { bodystructure });
    expect(agentSafe(error!)).toEqual({ agentSafe: true, code: "invalid_request" });
    expect(error!.message).toMatch(/incomplete/);
    expect(files).toEqual([]);
  });

  it("passes the bundle's own refusal (e.g. a MIME type the instance disallows) through to the agent", async () => {
    const writeFile = async (): Promise<never> => {
      throw new YapError("unsupported_media_type", "MIME type application/pdf is not allowed");
    };
    const { error } = await attach(withParts(pdfPart()), { part: "2" }, { writeFile });
    expect(agentSafe(error!)).toEqual({ agentSafe: true, code: "unsupported_media_type" });
  });

  it("collapses a run without a writer: that is the host's wiring, not the agent's doing", async () => {
    const imap = await imapMock({ mailboxes: mailboxes() });
    const error = await failure(config({ imap }), "attachment", { uid: "1", part: "2" });
    expect(agentSafe(error)).toEqual({ agentSafe: undefined, code: undefined });
  });

  it("requires uid and part", async () => {
    const { error } = await attach(withParts(pdfPart()), { uid: "", part: "2" });
    expect(error!.message).toMatch(/uid is required/);
    const { error: noPart } = await attach(withParts(pdfPart()), {});
    expect(noPart!.message).toMatch(/part is required/);
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
  it("sends to cc and bcc, with bcc on the envelope only", async () => {
    const smtp = await smtpMock();
    await run(config({ smtp }), "send", { to: "a@example.com", cc: "c@example.com", bcc: "hidden@example.com", subject: "Hi", body: "x" });
    const [m] = smtp.messages;
    expect(m!.to).toEqual(["a@example.com", "c@example.com", "hidden@example.com"]);
    expect(m!.data).toContain("Cc: c@example.com");
    expect(m!.data).not.toContain("hidden@example.com");
  });
  it("caps recipients across to, cc, and bcc together", async () => {
    const smtp = await smtpMock();
    const many = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}@example.com`).join(",");
    await expect(
      run(config({ smtp }), "send", { to: many(20, "a"), cc: many(20, "c"), bcc: many(11, "b"), subject: "Hi", body: "x" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(smtp.messages).toHaveLength(0);
    // A reply derives its `to` after the parameter count — it must still count.
    const imap = await imapMock({ mailboxes: mailboxes() });
    await expect(
      run(config({ smtp, imap }), "send", { bcc: many(50, "b"), body: "x", reply_to_uid: "3" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(smtp.messages).toHaveLength(0);
  });
  it("locks every recipient field once any of them is pinned", async () => {
    // The host injects the pinned `to` and refuses a supplied `to`; the
    // driver's part is to refuse the unpinned siblings, or a pin on `to`
    // would fix nothing.
    const smtp = await smtpMock();
    for (const extra of [{ cc: "attacker@example.com" }, { bcc: "attacker@example.com" }] as Record<string, string>[]) {
      const err = await run(config({ smtp }), "send", { to: "ops@example.com", subject: "Hi", body: "x", ...extra }, { pinned: ["to"] }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "invalid_request" });
      expect((err as Error).message).toMatch(/recipients are fixed on this service/);
    }
    expect(smtp.messages).toHaveLength(0);
    // Pinned cc, unpinned to: `to` is locked too — and a reply may not
    // derive it from the original, which would be aiming by proxy.
    const err = await run(config({ smtp }), "send", { to: "x@example.com", cc: "ops@example.com", subject: "Hi", body: "x" }, { pinned: ["cc"] }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/to cannot be supplied/);
    const imap = await imapMock({ mailboxes: mailboxes() });
    const reply = await run(config({ smtp, imap }), "send", { cc: "ops@example.com", body: "x", reply_to_uid: "3" }, { pinned: ["cc"] }).catch((e: unknown) => e);
    expect((reply as Error).message).toMatch(/cannot derive `to`/);
    // The pinned shape itself still works: pinned `to`, agent supplies the rest.
    await run(config({ smtp }), "send", { to: "ops@example.com", subject: "Hi", body: "x" }, { pinned: ["to"] });
    expect(smtp.messages[0]!.to).toEqual(["ops@example.com"]);
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
  it("keeps cc and bcc on a draft as headers for the client to honour", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([{ name: "Drafts", attributes: ["\\Drafts"], messages: [] }]) });
    await run(config({ imap }), "draft", { to: "bob@example.com", cc: "c@example.com", bcc: "hidden@example.com", subject: "P", body: "x" });
    const raw = imap.mailbox("Drafts")!.messages[0]!.raw;
    expect(raw).toMatch(/^Cc: c@example.com\r?$/m);
    expect(raw).toMatch(/^Bcc: hidden@example.com\r?$/m);
  });
  it("does not reply-all: a reply carries no cc unless supplied", async () => {
    const inbox = { name: "INBOX", messages: [{ uid: 9, flags: [], internalDate: new Date("2025-03-03T10:00:00Z"), raw: simpleMessage({ subject: "Ask", messageId: "<nine@example.com>", extraHeaders: "Cc: other@example.com\r\n" }) }] };
    const imap = await imapMock({ mailboxes: [inbox, { name: "Drafts", attributes: ["\\Drafts"], messages: [] }] });
    await run(config({ imap }), "draft", { body: "x", reply_to_uid: "9" });
    expect(imap.mailbox("Drafts")!.messages[0]!.raw).not.toMatch(/^Cc:/m);
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

describe("delete_draft", () => {
  it("deletes exactly the requested UID from the resolved Drafts folder", async () => {
    const imap = await imapMock({
      mailboxes: mailboxes([
        {
          name: "Drafts",
          attributes: ["\\Drafts"],
          messages: [
            { uid: 7, flags: ["\\Draft"], internalDate: new Date(), raw: msg({ subject: "Old draft" }) },
            { uid: 8, flags: ["\\Draft"], internalDate: new Date(), raw: msg({ subject: "Other draft" }) },
          ],
        },
        { name: "Archive", messages: [{ uid: 7, flags: [], internalDate: new Date(), raw: msg({ subject: "Real mail" }) }] },
      ]),
    });
    const { result } = await run(config({ imap }), "delete_draft", { uid: "7" });
    expect(result).toEqual({ folder: "Drafts", uid: 7 });
    expect(imap.mailbox("Drafts")!.messages.map((m) => m.uid)).toEqual([8]);
    expect(imap.mailbox("Archive")!.messages.map((m) => m.uid)).toEqual([7]);
    expect(imap.commands.some((c) => /SELECT "Drafts"$/.test(c))).toBe(true);
    expect(imap.commands.some((c) => /UID STORE 7 \+FLAGS \(\\Deleted\)$/.test(c))).toBe(true);
    expect(imap.commands.some((c) => /UID EXPUNGE 7$/.test(c))).toBe(true);
    expect(imap.commands.every((c) => !/^A\d+ EXPUNGE$/.test(c))).toBe(true);
  });

  it("honours drafts_folder even if an extraneous folder parameter reaches the driver", async () => {
    const imap = await imapMock({
      mailboxes: mailboxes([
        { name: "Drafts", attributes: ["\\Drafts"], messages: [{ uid: 3, flags: ["\\Draft"], internalDate: new Date(), raw: msg({ subject: "Default draft" }) }] },
        { name: "Proposals", messages: [{ uid: 3, flags: ["\\Draft"], internalDate: new Date(), raw: msg({ subject: "Configured draft" }) }] },
      ]),
    });
    const { result } = await run(config({ imap, drafts_folder: "Proposals" }), "delete_draft", { uid: "3", folder: "Drafts" });
    expect(result).toEqual({ folder: "Proposals", uid: 3 });
    expect(imap.mailbox("Proposals")!.messages).toHaveLength(0);
    expect(imap.mailbox("Drafts")!.messages.map((m) => m.uid)).toEqual([3]);
  });

  it("fails clearly without UIDPLUS instead of plain EXPUNGE", async () => {
    const imap = await imapMock({
      mailboxes: mailboxes([{ name: "Drafts", attributes: ["\\Drafts"], messages: [{ uid: 4, flags: ["\\Draft"], internalDate: new Date(), raw: msg() }] }]),
      noUidplus: true,
    });
    const err = await failure(config({ imap }), "delete_draft", { uid: "4" });
    expect(err).toBeInstanceOf(YapError);
    expect(agentSafe(err)).toEqual({ agentSafe: true, code: "invalid_request" });
    expect(err.message).toMatch(/UIDPLUS/);
    expect(imap.mailbox("Drafts")!.messages.map((m) => m.uid)).toEqual([4]);
    expect(imap.commands.every((c) => !/EXPUNGE/.test(c))).toBe(true);
  });

  it("reports missing draft UIDs as not_found", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([{ name: "Drafts", attributes: ["\\Drafts"], messages: [] }]) });
    const err = await failure(config({ imap }), "delete_draft", { uid: "99" });
    expect(err).toBeInstanceOf(YapError);
    expect(agentSafe(err)).toEqual({ agentSafe: true, code: "not_found" });
    expect(err.message).toMatch(/message 99 not found/);
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

describe("attachments on draft and send", () => {
  const ID_A = "0b6e3c1a-8f1e-4c1a-9d2b-1a2b3c4d5e6f";
  const ID_B = "1c7f4d2b-9a2f-4d2b-8e3c-2b3c4d5e6f70";
  const ID_C = "2d805e3c-ab30-4e3c-9f4d-3c4d5e6f7081";
  const ID_MISSING = "3e916f4d-bc41-4f4d-a05e-4d5e6f708192";

  interface FakeFile {
    name: string;
    mimeType: string;
    bytes: Buffer;
    /** The size on the file record, when it should differ from the bytes. */
    size?: number;
  }

  /** A reader over an in-memory bundle, shaped like services.ts's: refs as
   * file://{uuid} or a bare id, not_found for anything else, and a bytes()
   * that honours maxBytes. Records which refs were resolved and read. */
  function fakeReader(files: Record<string, FakeFile>): BundleReader & { resolved: string[]; read: string[] } {
    const resolved: string[] = [];
    const read: string[] = [];
    return {
      resolved,
      read,
      async readFile(refOrId: string): Promise<BundleFile> {
        resolved.push(refOrId);
        const id = refOrId.trim().replace(/^file:\/\//, "");
        const f = Object.hasOwn(files, id) ? files[id] : undefined;
        if (!f) throw new YapError("not_found", `file ${id} not found`);
        const size = f.size ?? f.bytes.length;
        const bytes = async (opts?: { maxBytes?: number }) => {
          if (opts?.maxBytes !== undefined && size > opts.maxBytes) throw new YapError("payload_too_large", `file ${id} exceeds the maximum inline read size of ${opts.maxBytes} bytes`);
          if (opts?.maxBytes === undefined && size > 10 * 1024 * 1024) throw new YapError("payload_too_large", `file ${id} exceeds the default`);
          read.push(id);
          return new Uint8Array(f.bytes);
        };
        return {
          id,
          name: f.name,
          mimeType: f.mimeType,
          size,
          bytes,
          stream: async () => {
            throw new Error("stream not expected");
          },
          text: async () => {
            throw new Error("text not expected");
          },
        };
      },
      async getItems() {
        throw new Error("getItems not expected");
      },
    };
  }

  const files = (): Record<string, FakeFile> => ({
    [ID_A]: { name: "clip one.mp3", mimeType: "audio/mpeg", bytes: Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256)) },
    [ID_B]: { name: "Stemmeprøve \"2\"; æøå.wav", mimeType: "audio/wav", bytes: Buffer.from("RIFF....WAVEfmt ") },
    [ID_C]: { name: "notes", mimeType: "", bytes: Buffer.from("plain notes\n") },
  });
  const drafts = (): MockMailboxSeed => ({ name: "Drafts", attributes: ["\\Drafts"], messages: [] });
  const draftParams = { to: "mie@example.com", bcc: "hidden@example.com", subject: "Voice test", body: "Here are the clips.\nTell me what you think." };

  it("attaches one file: multipart/mixed in Drafts, flagged \\Draft, body and bytes intact", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([drafts()]) });
    const reader = fakeReader(files());
    const { result } = await run(config({ imap }), "draft", { ...draftParams, attachments: `file://${ID_A}` }, { reader });
    expect(result).toEqual({ folder: "Drafts", uid: 1, attachments: [{ name: "clip one.mp3", mime_type: "audio/mpeg", size: 5000 }] });
    const stored = imap.mailbox("Drafts")!.messages;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.flags).toEqual(["\\Draft"]);
    const msg = parseMessage(stored[0]!.raw);
    expect(msg.contentType).toBe("multipart/mixed");
    expect(msg.headers["bcc"]).toBe("hidden@example.com");
    expect(msg.parts.map((p) => p.contentType)).toEqual(["text/plain", "audio/mpeg"]);
    expect(msg.parts[0]!.bytes.toString("utf8")).toBe("Here are the clips.\r\nTell me what you think.");
    expect(msg.parts[1]!.dispositionParams["filename"]).toBe("clip one.mp3");
    expect(Buffer.compare(msg.parts[1]!.bytes, files()[ID_A]!.bytes)).toBe(0);
    expect(reader.read).toEqual([ID_A]);
  });

  it("attaches several in the order given, trimming whitespace and ignoring empty entries", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([drafts()]) });
    const reader = fakeReader(files());
    const { result } = await run(config({ imap }), "draft", { ...draftParams, attachments: ` ${ID_C} , ,file://${ID_B},, file://${ID_A} ` }, { reader });
    expect(result.attachments).toEqual([
      { name: "notes", mime_type: "application/octet-stream", size: 12 },
      { name: 'Stemmeprøve "2"; æøå.wav', mime_type: "audio/wav", size: 16 },
      { name: "clip one.mp3", mime_type: "audio/mpeg", size: 5000 },
    ]);
    const msg = parseMessage(imap.mailbox("Drafts")!.messages[0]!.raw);
    const fileParts = msg.parts.slice(1);
    expect(fileParts.map((p) => p.dispositionParams["filename"])).toEqual(["notes", 'Stemmeprøve "2"; æøå.wav', "clip one.mp3"]);
    expect(fileParts.map((p) => p.params["name"])).toEqual(["notes", 'Stemmeprøve "2"; æøå.wav', "clip one.mp3"]);
    expect(fileParts.map((p) => p.contentType)).toEqual(["application/octet-stream", "audio/wav", "audio/mpeg"]);
    for (const [part, id] of fileParts.map((p, i) => [p, [ID_C, ID_B, ID_A][i]!] as const)) {
      expect(Buffer.compare(part.bytes, files()[id]!.bytes)).toBe(0);
    }
  });

  it("leaves a draft without attachments exactly as before: one text/plain part, no attachments key, no reads", async () => {
    for (const attachments of [undefined, "", " , "]) {
      const imap = await imapMock({ mailboxes: mailboxes([drafts()]) });
      const reader = fakeReader(files());
      const params = attachments === undefined ? draftParams : { ...draftParams, attachments };
      const { result } = await run(config({ imap }), "draft", params, { reader });
      expect(result).toEqual({ folder: "Drafts", uid: 1 });
      const raw = imap.mailbox("Drafts")!.messages[0]!.raw;
      expect(raw).toMatch(/\r\nContent-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nHere are the clips\./);
      expect(raw).not.toContain("multipart");
      expect(reader.resolved).toEqual([]);
    }
  });

  it("keeps In-Reply-To and References on a reply draft with an attachment", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([drafts()]) });
    await run(config({ imap }), "draft", { body: "x", reply_to_uid: "3", attachments: ID_A }, { reader: fakeReader(files()) });
    const msg = parseMessage(imap.mailbox("Drafts")!.messages[0]!.raw);
    expect(msg.headers["in-reply-to"]).toBe("<three@example.com>");
    expect(msg.headers["references"]).toBe("<three@example.com>");
    expect(msg.headers["subject"]).toBe("Re: Third");
    expect(msg.parts).toHaveLength(2);
  });

  it("fails the whole run naming the reference when one does not resolve, appending nothing", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([drafts()]) });
    const reader = fakeReader(files());
    const error = await run(config({ imap }), "draft", { ...draftParams, attachments: `${ID_A},file://${ID_MISSING}` }, { reader }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(YapError);
    expect((error as YapError).code).toBe("not_found");
    expect((error as Error).message).toContain(`file://${ID_MISSING}`);
    expect((error as Error).message).toMatch(/not a file in this bundle/);
    expect(imap.mailbox("Drafts")!.messages).toHaveLength(0);
    // Resolution happens for every reference before any bytes are read.
    expect(reader.read).toEqual([]);
  });

  it("refuses a malformed or duplicate reference before connecting", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([drafts()]) });
    const reader = fakeReader(files());
    const cfg = config({ imap });
    const bad = await run(cfg, "draft", { ...draftParams, attachments: "item://nope" }, { reader }).catch((e: Error) => e);
    expect(agentSafe(bad as Error)).toEqual({ agentSafe: true, code: "invalid_request" });
    expect((bad as Error).message).toMatch(/attachment "item:\/\/nope" is not a file:\/\/\{uuid\} reference or file id/);
    const twice = await run(cfg, "draft", { ...draftParams, attachments: `file://${ID_A}, ${ID_A.toUpperCase()}` }, { reader }).catch((e: Error) => e);
    expect((twice as Error).message).toMatch(/is listed more than once/);
    expect(agentSafe(twice as Error).code).toBe("invalid_request");
    expect(reader.resolved).toEqual([]);
    expect(imap.mailbox("Drafts")!.messages).toHaveLength(0);
  });

  it("caps the count at 10 files", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([drafts()]) });
    const reader = fakeReader(files());
    const ids = Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const error = await run(config({ imap }), "draft", { ...draftParams, attachments: ids.join(",") }, { reader }).catch((e: Error) => e);
    expect(agentSafe(error as Error).code).toBe("invalid_request");
    expect((error as Error).message).toMatch(/at most 10 files \(got 11\)/);
    expect(reader.resolved).toEqual([]);
    expect(imap.mailbox("Drafts")!.messages).toHaveLength(0);
  });

  it("caps the total at 18 MiB from the file records, before reading a byte", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([drafts()]) });
    const big = files();
    big[ID_A]!.size = 10 * 1024 * 1024;
    big[ID_B]!.size = 8 * 1024 * 1024 + 1;
    const reader = fakeReader(big);
    const error = await run(config({ imap }), "draft", { ...draftParams, attachments: `${ID_A},${ID_B}` }, { reader }).catch((e: Error) => e);
    expect(agentSafe(error as Error).code).toBe("invalid_request");
    expect((error as Error).message).toMatch(/attachments total 18874369 bytes; the cap is 18 MiB/);
    expect(reader.read).toEqual([]);
    expect(imap.mailbox("Drafts")!.messages).toHaveLength(0);
  });

  it("refuses a filename the message cannot carry, appending nothing", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([drafts()]) });
    const evil = files();
    evil[ID_A]!.name = "x.txt\r\nBcc: attacker@example.com";
    const error = await run(config({ imap }), "draft", { ...draftParams, attachments: ID_A }, { reader: fakeReader(evil) }).catch((e: Error) => e);
    expect(agentSafe(error as Error).code).toBe("invalid_request");
    expect((error as Error).message).toMatch(/attachment filename must not contain a line break/);
    expect(imap.mailbox("Drafts")!.messages).toHaveLength(0);
  });

  it("reports the server's own text when it refuses the append for size", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([drafts()]), appendLimit: 2000 });
    const error = await run(config({ imap }), "draft", { ...draftParams, attachments: ID_A }, { reader: fakeReader(files()) }).catch((e: Error) => e);
    expect(agentSafe(error as Error).code).toBe("invalid_request");
    expect((error as Error).message).toBe("the server refused the message: [TOOBIG] Message too large for this mailbox");
    expect(imap.mailbox("Drafts")!.messages).toHaveLength(0);
  });

  it("keeps a pinned attachments value out of every error", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([drafts()]) });
    const cfg = config({ imap });
    const pinnedRun = (attachments: string) =>
      run(cfg, "draft", { ...draftParams, attachments }, { pinned: ["attachments"], reader: fakeReader(files()) }).catch((e: Error) => e);
    for (const value of ["secret-not-a-ref", `file://${ID_MISSING}`]) {
      const error = (await pinnedRun(value)) as Error;
      expect(agentSafe(error).agentSafe).toBe(true);
      expect(error.message).toMatch(/pinned attachment/);
      expect(error.message).not.toContain(value);
      expect(error.message).not.toContain(ID_MISSING);
    }
    // Pinned to an empty value, the service attaches nothing and reads nothing.
    const reader = fakeReader(files());
    const { result } = await run(cfg, "draft", { ...draftParams, attachments: "" }, { pinned: ["attachments"], reader });
    expect(result.attachments).toBeUndefined();
    expect(reader.resolved).toEqual([]);
  });

  it("sends the same multipart message draft builds, minus the Bcc header, with bcc still on the envelope", async () => {
    const imap = await imapMock({ mailboxes: mailboxes([drafts()]) });
    const smtp = await smtpMock();
    const cfg = config({ imap, smtp });
    const params = { ...draftParams, attachments: `${ID_A},${ID_B}` };
    const sent = await run(cfg, "send", params, { reader: fakeReader(files()) });
    await run(cfg, "draft", params, { reader: fakeReader(files()) });
    expect(sent.result).toEqual({
      accepted: true,
      message_id: expect.stringMatching(/^<.+@example\.com>$/),
      attachments: [
        { name: "clip one.mp3", mime_type: "audio/mpeg", size: 5000 },
        { name: 'Stemmeprøve "2"; æøå.wav', mime_type: "audio/wav", size: 16 },
      ],
    });
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]!.to).toEqual(["mie@example.com", "hidden@example.com"]);
    const out = parseMessage(smtp.messages[0]!.data);
    const draft = parseMessage(imap.mailbox("Drafts")!.messages[0]!.raw);
    expect(out.headers["bcc"]).toBeUndefined();
    expect(draft.headers["bcc"]).toBe("hidden@example.com");
    const { bcc: _bcc, "message-id": _a, date: _b, "content-type": _c, ...draftHeaders } = draft.headers;
    const { "message-id": _d, date: _e, "content-type": _f, ...sentHeaders } = out.headers;
    expect(sentHeaders).toEqual(draftHeaders);
    const shape = (m: typeof out) => m.parts.map((p) => ({ header: p.rawHeader, bytes: p.bytes.toString("base64") }));
    expect(shape(out)).toEqual(shape(draft));
  });

  it("leaves send without attachments as it was: one text/plain part, the same result shape", async () => {
    const smtp = await smtpMock();
    const reader = fakeReader(files());
    const { result } = await run(config({ smtp }), "send", { to: "a@example.com", subject: "s", body: "plain" }, { reader });
    expect(Object.keys(result).sort()).toEqual(["accepted", "message_id"]);
    expect(smtp.messages[0]!.data).toMatch(/\r\nContent-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nplain$/);
    expect(reader.resolved).toEqual([]);
  });

  it("refuses a send whose attachment does not resolve without sending anything", async () => {
    const smtp = await smtpMock();
    const error = await run(config({ smtp }), "send", { to: "a@example.com", subject: "s", body: "b", attachments: ID_MISSING }, { reader: fakeReader(files()) }).catch((e: Error) => e);
    expect(agentSafe(error as Error).code).toBe("not_found");
    expect(smtp.messages).toHaveLength(0);
  });

  it("only draft and send touch the reader", async () => {
    // The runner hands a reader to every action of a driver that declares
    // reads; this checks the other handlers never so much as look at it.
    const imap = await imapMock({
      mailboxes: mailboxes([{ name: "Drafts", attributes: ["\\Drafts"], messages: [{ uid: 7, flags: ["\\Draft"], internalDate: new Date(), raw: msg({ subject: "Old" }) }] }]),
    });
    const cfg = config({ imap });
    // Each call must get as far as the server, so a handler that failed early
    // cannot pass by never reaching code that might touch the reader.
    // attachment fetches the message's structure and then finds no part 2.
    const calls: Array<[string, Record<string, string>, string]> = [
      ["folders", {}, "ok"],
      ["search", {}, "ok"],
      ["read", { uid: "1" }, "ok"],
      ["mark", { uid: "1", flag: "seen" }, "ok"],
      ["delete_draft", { uid: "7" }, "ok"],
      ["attachment", { uid: "1", part: "2" }, 'part "2" is not an attachment of message 1; take part from read\'s attachments'],
    ];
    for (const [action, params, expected] of calls) {
      const ctx = createCtx(createFakeEgress());
      let touched = false;
      Object.defineProperty(ctx, "reader", {
        get() {
          touched = true;
          return null;
        },
      });
      ctx.writer = fakeWriter().writer;
      ctx.config = cfg;
      ctx.action = action;
      ctx.params = params;
      const outcome = await driver.run(ctx).then(
        () => "ok",
        (e: Error) => e.message,
      );
      expect(outcome, action).toBe(expected);
      expect(touched, action).toBe(false);
    }
  });
});
