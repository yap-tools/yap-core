import { afterEach, describe, expect, it } from "vitest";

import { xoauth2Payload, type ResolvedAuth } from "../../src/core/drivers/mail/auth.js";
import { buildMessage } from "../../src/core/drivers/mail/message.js";
import { ProtocolError } from "../../src/core/drivers/mail/net.js";
import { dotStuff, smtpProbe, smtpSend, type SmtpSessionConfig } from "../../src/core/drivers/mail/smtp.js";
import { createCtx, createFakeEgress, trustMockCertificate } from "../helpers/mail/egress.js";
import { startMockSmtp, type MockSmtp, type MockSmtpOptions } from "../helpers/smtp.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function mock(options?: MockSmtpOptions): Promise<MockSmtp> {
  const server = await startMockSmtp(options);
  cleanups.push(server.close);
  return server;
}

function ctxFor() {
  const egress = createFakeEgress();
  cleanups.push(() => egress.dispose());
  return createCtx(egress);
}

const message = buildMessage({
  from: "me@example.com",
  to: ["a@x.com"],
  subject: "Hi",
  body: "hello",
  messageId: "<id@example.com>",
  date: new Date("2026-08-21T10:00:00Z"),
});

function config(server: MockSmtp, extra: Partial<SmtpSessionConfig> = {}): SmtpSessionConfig {
  return { host: "mail.example.test", port: server.port, security: "none", auth: null, ...extra };
}

const password: ResolvedAuth = { kind: "password", user: "user@example.com", pass: "pa ss" };

async function rejection(promise: Promise<unknown>): Promise<ProtocolError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ProtocolError);
  return caught as ProtocolError;
}

describe("smtpSend", () => {
  it("sends without auth over a plain connection and closes the socket", async () => {
    const server = await mock({ auth: [] });
    const ctx = ctxFor();
    const result = await smtpSend(ctx, config(server), { from: "me@example.com", to: ["a@x.com"], message });
    expect(result).toEqual({ accepted: true });
    expect(server.messages).toHaveLength(1);
    expect(server.messages[0]).toMatchObject({ from: "me@example.com", to: ["a@x.com"] });
    expect(server.messages[0]?.data).toBe(message.toString("utf8"));
    expect(server.commands.map((c) => c.split(" ")[0])).toEqual(["EHLO", "MAIL", "RCPT", "DATA", "QUIT"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(server.closed).toBe(1);
    expect(ctx.logs.join("\n")).toMatch(/< 250 2\.0\.0 Ok: queued/);
    expect(ctx.logs.join("\n")).toMatch(/<message, \d+ bytes>/);
    expect(ctx.logs.join("\n")).not.toContain("hello");
  });

  it("needs at least one recipient", async () => {
    const server = await mock({ auth: [] });
    await expect(smtpSend(ctxFor(), config(server), { from: "me@example.com", to: [], message })).rejects.toThrow(
      /recipient/,
    );
    expect(server.connections).toBe(0);
  });

  it("refuses to send credentials over plaintext unless allow_plaintext_auth", async () => {
    const server = await mock();
    const ctx = ctxFor();
    await expect(
      smtpSend(ctx, config(server, { auth: password }), { from: "me@example.com", to: ["a@x.com"], message }),
    ).rejects.toThrow(/plaintext/);
    expect(server.authLines).toHaveLength(0);
    expect(server.messages).toHaveLength(0);
  });

  it("prefers AUTH PLAIN and redacts the credentials from the log", async () => {
    const server = await mock({ requireAuth: true });
    const ctx = ctxFor();
    await smtpSend(ctx, config(server, { auth: password, allow_plaintext_auth: true }), {
      from: "me@example.com",
      to: ["a@x.com"],
      message,
    });
    expect(server.authLines).toEqual([Buffer.from("\0user@example.com\0pa ss").toString("base64")]);
    expect(server.commands.some((c) => /^AUTH PLAIN /.test(c))).toBe(true);
    const log = ctx.logs.join("\n");
    expect(log).toMatch(/> AUTH PLAIN <credentials>/);
    expect(log).not.toContain("pa ss");
    expect(log).not.toContain(server.authLines[0]);
  });

  it("surfaces a rejected AUTH PLAIN as a ProtocolError with the reply", async () => {
    const server = await mock({ requireAuth: true, rejectAuth: true });
    const err = await rejection(
      smtpSend(ctxFor(), config(server, { auth: password, allow_plaintext_auth: true }), {
        from: "me@example.com",
        to: ["a@x.com"],
        message,
      }),
    );
    expect(err.step).toBe("AUTH PLAIN");
    expect(err.reply).toMatch(/^535/);
    expect(server.messages).toHaveLength(0);
  });

  it("falls back to AUTH LOGIN when PLAIN is not advertised", async () => {
    const server = await mock({ requireAuth: true, auth: ["LOGIN"] });
    const ctx = ctxFor();
    await smtpSend(ctx, config(server, { auth: password, allow_plaintext_auth: true }), {
      from: "me@example.com",
      to: ["a@x.com"],
      message,
    });
    expect(server.authLines).toEqual([
      Buffer.from("user@example.com").toString("base64"),
      Buffer.from("pa ss").toString("base64"),
    ]);
    const log = ctx.logs.join("\n");
    expect(log).toMatch(/<username>/);
    expect(log).toMatch(/<password>/);
    expect(log).not.toContain(server.authLines[1]);
  });

  it("fails clearly when credentials are configured but the server offers no AUTH", async () => {
    const server = await mock({ auth: [] });
    await expect(
      smtpSend(ctxFor(), config(server, { auth: password, allow_plaintext_auth: true }), {
        from: "me@example.com",
        to: ["a@x.com"],
        message,
      }),
    ).rejects.toThrow(/AUTH/);
    expect(server.authLines).toHaveLength(0);
  });

  it("fails clearly when the server offers only mechanisms it cannot speak", async () => {
    const server = await mock({ auth: ["CRAM-MD5"] });
    const err = await rejection(
      smtpSend(ctxFor(), config(server, { auth: password, allow_plaintext_auth: true }), {
        from: "me@example.com",
        to: ["a@x.com"],
        message,
      }),
    );
    expect(err.message).toMatch(/neither AUTH PLAIN nor AUTH LOGIN/);
    const xoauth2: ResolvedAuth = { kind: "xoauth2", user: "u@example.com", token: "t" };
    const err2 = await rejection(
      smtpSend(ctxFor(), config(server, { auth: xoauth2, allow_plaintext_auth: true }), {
        from: "me@example.com",
        to: ["a@x.com"],
        message,
      }),
    );
    expect(err2.message).toMatch(/AUTH XOAUTH2/);
    expect(server.authLines).toHaveLength(0);
  });

  it("authenticates with XOAUTH2 and surfaces the server's rejection without the token", async () => {
    const ok = await mock({ requireAuth: true });
    const auth: ResolvedAuth = { kind: "xoauth2", user: "u@example.com", token: "ya29.acc3ss" };
    await smtpSend(ctxFor(), config(ok, { auth, allow_plaintext_auth: true }), {
      from: "me@example.com",
      to: ["a@x.com"],
      message,
    });
    expect(ok.authLines).toEqual([xoauth2Payload("u@example.com", "ya29.acc3ss")]);
    expect(ok.messages).toHaveLength(1);

    const bad = await mock({ requireAuth: true, rejectXoauth2: true });
    const ctx = ctxFor();
    const caught = await rejection(
      smtpSend(ctx, config(bad, { auth, allow_plaintext_auth: true }), {
        from: "me@example.com",
        to: ["a@x.com"],
        message,
      }),
    );
    expect(caught.step).toBe("AUTH XOAUTH2");
    expect(caught.reply).toMatch(/^535/);
    expect(caught.message).not.toContain("ya29");
    expect(ctx.logs.join("\n")).not.toContain("ya29");
    expect(bad.messages).toHaveLength(0);
  });

  it("sends to several recipients, one RCPT TO each", async () => {
    const server = await mock({ auth: [] });
    await smtpSend(ctxFor(), config(server), {
      from: "me@example.com",
      to: ["a@x.com", "b@y.com", "c@z.com"],
      message,
    });
    expect(server.messages[0]?.to).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    expect(server.commands.filter((c) => c.startsWith("RCPT"))).toHaveLength(3);
  });

  it("collects RCPT rejections and sends nothing", async () => {
    const server = await mock({ auth: [], rejectRcpt: ["b@y.com", "c@z.com"] });
    const caught = await rejection(
      smtpSend(ctxFor(), config(server), { from: "me@example.com", to: ["a@x.com", "b@y.com", "c@z.com"], message }),
    );
    expect(caught.step).toBe("RCPT TO");
    expect(caught.message).toMatch(/2 of 3 recipients/);
    expect(caught.reply).toBe("550 5.1.1 <b@y.com> unknown user");
    expect(caught.rejections).toEqual([
      { address: "b@y.com", reply: "550 5.1.1 <b@y.com> unknown user" },
      { address: "c@z.com", reply: "550 5.1.1 <c@z.com> unknown user" },
    ]);
    expect(server.messages).toHaveLength(0);
    expect(server.commands.some((c) => c === "DATA")).toBe(false);
  });

  it("dot-stuffs on the wire so no body line can end DATA", async () => {
    const server = await mock({ auth: [] });
    const raw = Buffer.from("Subject: x\r\n\r\n.\r\n..two\r\nend");
    await smtpSend(ctxFor(), config(server), { from: "me@example.com", to: ["a@x.com"], message: raw });
    expect(server.messages).toHaveLength(1);
    expect(server.messages[0]?.data).toBe("Subject: x\r\n\r\n..\r\n...two\r\nend");
  });

  it("normalises bare CR and LF in the message so they cannot smuggle commands", async () => {
    const server = await mock({ auth: [] });
    const raw = Buffer.from("Subject: x\r\n\r\nbody\r.\rRCPT TO:<attacker@evil.test>\r\nafter\n.\n");
    await smtpSend(ctxFor(), config(server), { from: "me@example.com", to: ["a@x.com"], message: raw });
    expect(server.messages).toHaveLength(1);
    expect(server.messages[0]?.to).toEqual(["a@x.com"]);
    expect(server.messages[0]?.data).toBe("Subject: x\r\n\r\nbody\r\n..\r\nRCPT TO:<attacker@evil.test>\r\nafter\r\n..");
    expect(server.commands.filter((c) => c.startsWith("RCPT"))).toHaveLength(1);
  });

  it("raises a ProtocolError with the reply when a step is rejected", async () => {
    const server = await mock({ requireAuth: true, auth: [] });
    const caught = await rejection(
      smtpSend(ctxFor(), config(server), { from: "me@example.com", to: ["a@x.com"], message }),
    );
    expect(caught.step).toBe("MAIL FROM");
    expect(caught.reply).toBe("530 5.7.0 Authentication required");
  });

  it("gives up on a silent server when the signal aborts", async () => {
    const server = await mock({ silent: true });
    const controller = new AbortController();
    const egress = createFakeEgress();
    cleanups.push(() => egress.dispose());
    const ctx = createCtx(egress, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(
      smtpSend(ctx, config(server), { from: "me@example.com", to: ["a@x.com"], message }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((r) => setTimeout(r, 300));
    expect(server.closed).toBe(1);
  });

  describe("STARTTLS", () => {
    const trusted = trustMockCertificate();

    it.skipIf(!trusted)("upgrades, re-EHLOs, and only then authenticates", async () => {
      const server = await mock({ startTls: true, requireAuth: true, authAfterStartTls: true });
      const ctx = ctxFor();
      await smtpSend(ctx, config(server, { host: "localhost", security: "starttls", auth: password }), {
        from: "me@example.com",
        to: ["a@x.com"],
        message,
      });
      expect(server.commands.map((c) => c.split(" ")[0])).toEqual([
        "EHLO",
        "STARTTLS",
        "EHLO",
        "AUTH",
        "MAIL",
        "RCPT",
        "DATA",
        "QUIT",
      ]);
      expect(server.messages).toHaveLength(1);
      expect(ctx.logs.join("\n")).toContain("* TLS established");
      expect(ctx.logs.join("\n")).not.toContain("pa ss");
    });

    it("fails when STARTTLS is required but not advertised", async () => {
      const server = await mock({ startTls: false });
      await expect(
        smtpSend(ctxFor(), config(server, { security: "starttls", auth: password }), {
          from: "me@example.com",
          to: ["a@x.com"],
          message,
        }),
      ).rejects.toThrow(/STARTTLS/);
      expect(server.authLines).toHaveLength(0);
      expect(server.commands.some((c) => c.startsWith("AUTH"))).toBe(false);
    });
  });
});

describe("smtpProbe", () => {
  it("authenticates and quits without sending", async () => {
    const server = await mock({ requireAuth: true });
    await smtpProbe(ctxFor(), config(server, { auth: password, allow_plaintext_auth: true }));
    expect(server.commands.map((c) => c.split(" ")[0])).toEqual(["EHLO", "AUTH", "QUIT"]);
    expect(server.messages).toHaveLength(0);
  });

  it("reports a wrong password at authoring time", async () => {
    const server = await mock({ rejectAuth: true });
    const err = await rejection(smtpProbe(ctxFor(), config(server, { auth: password, allow_plaintext_auth: true })));
    expect(err.step).toBe("AUTH PLAIN");
    await new Promise((r) => setTimeout(r, 50));
    expect(server.closed).toBe(1);
  });
});

describe("dotStuff", () => {
  it("normalises line breaks, doubles leading dots, and guarantees a trailing CRLF", () => {
    expect(dotStuff("a\n.b\r..c\r\nd").toString("latin1")).toBe("a\r\n..b\r\n...c\r\nd\r\n");
    expect(dotStuff(Buffer.from("x\r\n")).toString("latin1")).toBe("x\r\n");
    expect(dotStuff("").toString("latin1")).toBe("\r\n");
  });
  it("keeps UTF-8 bytes intact", () => {
    const utf8 = Buffer.from("héllo\n", "utf8");
    expect(dotStuff(utf8).toString("utf8")).toBe("héllo\r\n");
    expect(dotStuff("héllo").toString("utf8")).toBe("héllo\r\n");
  });
});
