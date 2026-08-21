/**
 * The built-in mail driver through the whole stack: a service authored over
 * REST on a real (mock) IMAP server, run through the runs layer with the real
 * egress guard (loopback allowlisted), its allowlist enforced by the host, and
 * a wrong password caught at authoring time by `validateConfigOnline` rather
 * than on the first run. The per-action behaviour lives in the unit suite;
 * this is the wiring.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { simpleMessage, startImapMock, type ImapMock } from "../helpers/mail/imap-mock.js";
import { startMockSmtp, type MockSmtp } from "../helpers/smtp.js";

const PASS = "reader-pw-4711";

describe("mail service (built-in driver)", () => {
  let app: TestApp;
  let alice: ApiClient;
  let bundleId: string;
  let imap: ImapMock;
  /** A server that refuses every login — the mock does not check passwords. */
  let refusing: ImapMock;
  let smtp: MockSmtp;
  let serviceId: string;

  function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      user: "reader",
      pass: PASS,
      from: "reader@example.com",
      allow_plaintext_auth: true,
      imap: { host: "127.0.0.1", port: imap.port, security: "none" },
      ...overrides,
    };
  }

  async function run(action: string, params: Record<string, string> = {}) {
    return await alice.post(`/v1/services/${serviceId}/run`, { action, params, wait_ms: 10_000 });
  }

  beforeAll(async () => {
    imap = await startImapMock({
      mailboxes: [
        {
          name: "INBOX",
          uidvalidity: 4242,
          messages: [
            { uid: 1, flags: ["\\Seen"], internalDate: new Date("2025-01-10T09:00:00Z"), raw: simpleMessage({ subject: "Welcome", from: "Alice <alice@example.com>", body: "hello reader" }) },
            { uid: 2, flags: [], internalDate: new Date("2025-02-20T09:00:00Z"), raw: simpleMessage({ subject: "Invoice", from: "Bob <bob@example.com>", messageId: "<inv@example.com>", body: "please pay" }) },
          ],
        },
        { name: "Drafts", attributes: ["\\Drafts"], messages: [] },
      ],
    });
    refusing = await startImapMock({ authFail: true });
    smtp = await startMockSmtp();
    app = await bootTestApp({ YAP_HOOK_ALLOW_HOSTS: "127.0.0.1" });
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    const spaceId = (await alice.post("/v1/spaces", { name: "Mail" })).body.id;
    bundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "inbox" })).body.id;

    const created = await alice.post(`/v1/bundles/${bundleId}/services`, {
      name: "inbox",
      driver: "mail",
      actions: ["folders", "search", "read"],
      config: config(),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    serviceId = created.body.id;
  });

  afterAll(async () => {
    await app?.stop();
    await imap?.close();
    await refusing?.close();
    await smtp?.close();
  });

  it("keeps a notifier aimed: a pinned `to` locks cc and bcc through the whole stack", async () => {
    const created = await alice.post(`/v1/bundles/${bundleId}/services`, {
      name: "notifier",
      driver: "mail",
      actions: ["send"],
      pins: { to: "ops@example.com" },
      config: config({ smtp: { host: "127.0.0.1", port: smtp.port, security: "none" } }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // The listing shows cc/bcc as callable — pins are per name — which is
    // exactly why the driver has to refuse them at run time.
    const send = created.body.actions.find((a: { name: string }) => a.name === "send");
    const names = send.params.map((p: { name: string }) => p.name);
    expect(names).not.toContain("to");
    expect(names).toEqual(expect.arrayContaining(["cc", "bcc"]));

    const post = (params: Record<string, string>) =>
      alice.post(`/v1/services/${created.body.id}/run`, { params, wait_ms: 10_000 });
    const aimed = await post({ subject: "hi", body: "b", cc: "attacker@example.com" });
    expect(aimed.body.status).toBe("failed");
    expect(aimed.body.errorCode).toBe("invalid_request");
    expect(aimed.body.error).toMatch(/recipients are fixed on this service; cc cannot be supplied/);
    const blind = await post({ subject: "hi", body: "b", bcc: "attacker@example.com" });
    expect(blind.body.error).toMatch(/bcc cannot be supplied/);
    expect(smtp.messages).toHaveLength(0);

    const ok = await post({ subject: "hi", body: "b" });
    expect(ok.body.status, JSON.stringify(ok.body)).toBe("succeeded");
    expect(smtp.messages[0]!.to).toEqual(["ops@example.com"]);
    expect(JSON.stringify(ok.body)).not.toContain("ops@example.com");
  });

  it("is a built-in: authored without installing anything, listing only the allowed actions", async () => {
    const listed = (await alice.get(`/v1/bundles/${bundleId}/services`)).body.data.find((s: any) => s.name === "inbox");
    expect(listed.driver).toBe("mail");
    expect(listed.actions.map((a: any) => a.name)).toEqual(["folders", "search", "read"]);
    expect(JSON.stringify(listed)).not.toContain(PASS);
  });

  it("searches the inbox through the runs layer", async () => {
    const res = await run("search", { unseen: "true" });
    expect(res.status).toBe(200);
    expect(res.body.status, JSON.stringify(res.body)).toBe("succeeded");
    expect(res.body.result.folder).toBe("INBOX");
    expect(res.body.result.uidvalidity).toBe(4242);
    expect(res.body.result.messages.map((m: any) => m.uid)).toEqual([2]);
    expect(res.body.result.messages[0].subject).toBe("Invoice");
    expect(JSON.stringify(res.body)).not.toContain(PASS);
  });

  it("reads one message without marking it seen", async () => {
    const res = await run("read", { uid: "2" });
    expect(res.body.status, JSON.stringify(res.body)).toBe("succeeded");
    expect(res.body.result).toMatchObject({ uid: 2, message_id: "<inv@example.com>", text: "please pay", truncated: false });
    expect(imap.mailbox("INBOX")!.messages[1]!.flags).toEqual([]);
  });

  it("shows the agent a not-found verdict for a missing message", async () => {
    const res = await run("read", { uid: "99" });
    expect(res.body.status).toBe("failed");
    expect(res.body.error).toMatch(/message 99 not found/);
  });

  it("rejects the disabled send action as unknown, naming only the allowed ones", async () => {
    const res = await run("send", { to: "x@example.com", subject: "s", body: "b" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('unknown action "send" for service "inbox" (available: folders, search, read)');
  });

  it("refuses a bad password at authoring time (validateConfigOnline)", async () => {
    const res = await alice.post(`/v1/bundles/${bundleId}/services`, {
      name: "wrong-password",
      driver: "mail",
      config: config({ pass: "not-it", imap: { host: "127.0.0.1", port: refusing.port, security: "none" } }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/invalid config for driver "mail": imap: authentication failed/);
    expect(res.body.error.message).not.toContain("not-it");
  });
});
