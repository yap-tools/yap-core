import { describe, expect, it } from "vitest";

import { defaultSecurity, normalizeMailConfig } from "../../src/core/drivers/mail/config.js";
import { YapError } from "../../src/core/errors.js";

const oauth2 = { client_id: "a", client_secret: "b", refresh_token: "c", token_url: "https://x.example/t" };

describe("normalizeMailConfig", () => {
  const base = { user: "u", pass: "p", from: "a@b.example", imap: { host: "h", port: 993 } };

  it("accepts a minimal config and fills defaults", () => {
    expect(() => normalizeMailConfig(base)).not.toThrow();
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
    expect(defaultSecurity(993)).toBe("tls");
    expect(defaultSecurity(25)).toBe("tls");
  });

  it("keeps an explicit security and drops unknown fields", () => {
    const c = normalizeMailConfig({ ...base, imap: { host: "h", port: 993, security: "none" }, bogus: 1 });
    expect(c.imap).toEqual({ host: "h", port: 993, security: "none" });
    expect("bogus" in c).toBe(false);
  });

  it.each<[unknown, RegExp]>([
    [{ ...base, user: undefined }, /user/],
    [{ ...base, pass: undefined }, /pass or oauth2/],
    [{ ...base, oauth2 }, /pass or oauth2/],
    [{ ...base, pass: undefined, oauth2: { ...oauth2, token_url: "http://x.example/t" } }, /oauth2.token_url/],
    [{ ...base, pass: undefined, oauth2: { ...oauth2, token_url: "not a url" } }, /oauth2.token_url/],
    [{ ...base, pass: undefined, oauth2: { ...oauth2, refresh_token: undefined } }, /oauth2.refresh_token/],
    [{ ...base, from: "nope" }, /from/],
    [{ ...base, name: "a\r\nBcc: x@y.example" }, /name/],
    [{ ...base, imap: undefined }, /imap or smtp/],
    [{ ...base, imap: { host: "h", port: 70000 } }, /imap.port/],
    [{ ...base, imap: { host: "h", port: 993, security: "ssl" } }, /imap.security/],
    [{ ...base, imap: { host: "imap.example.test:993", port: 993 } }, /imap.host/],
    [{ ...base, smtp: { port: 25 } }, /smtp.host/],
    [{ ...base, smtp: "smtp.example.test" }, /smtp/],
    [{ ...base, allow_plaintext_auth: "yes" }, /allow_plaintext_auth/],
    [{ ...base, drafts_folder: "" }, /drafts_folder/],
    [{ ...base, drafts_folder: "Drafts\r\n" }, /drafts_folder/],
    [{ ...base, sent_folder: "Sent\0" }, /sent_folder/],
    [{ ...base, imap: undefined, smtp: { host: "h", port: 587 }, save_sent: true }, /save_sent/],
    ["nope", /config must be an object/],
    [null, /config must be an object/],
  ])("rejects %j", (cfg, re) => {
    expect(() => normalizeMailConfig(cfg)).toThrow(re);
  });

  it("throws an invalid_request YapError so the CLI can show it at authoring time", () => {
    let caught: unknown;
    try {
      normalizeMailConfig({ ...base, user: "" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(YapError);
    expect((caught as YapError).code).toBe("invalid_request");
  });

  it("accepts an oauth2 config", () => {
    const c = normalizeMailConfig({ ...base, pass: undefined, oauth2 });
    expect(c.oauth2?.client_id).toBe("a");
    expect(c.pass).toBeUndefined();
  });
});
