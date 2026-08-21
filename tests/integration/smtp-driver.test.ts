/**
 * The ticket's worked example, end to end: an operator installs the external
 * `smtp` driver, authors a service whose recipient is *pinned*, and an agent
 * sends mail through it without ever being able to choose who receives it.
 *
 * The driver under test is `examples/drivers/smtp` — plain JavaScript that
 * imports nothing from Yap — copied into a temporary drivers/ directory and
 * loaded by the real loader, so this suite exercises the whole injection
 * contract: external loading, guarded socket egress (`ctx.egress.connect`),
 * pins merged in by the runner, and the abort/timeout budget. The far end is a
 * mock SMTP server, so the assertions are on the bytes that actually crossed
 * the wire.
 */
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { startMockSmtp, type MockSmtp } from "../helpers/smtp.js";

const DRIVER = fileURLToPath(new URL("../../examples/drivers/smtp", import.meta.url));

/** A drivers/ directory holding a copy of the example driver, as `yap driver
 * add` would leave it. */
function driversDirWithSmtp(): string {
  const dir = mkdtempSync(join(tmpdir(), "yap-drivers-"));
  cpSync(DRIVER, join(dir, "driver-smtp"), { recursive: true });
  return dir;
}

const PINNED_TO = "troels@example.test";
const FROM = "yap@example.test";

/** Non-ASCII on purpose: the subject must arrive as an RFC 2047 encoded word. */
const SUBJECT = "Rapport for august ☂";
/** A line starting with "." must arrive dot-stuffed, or it would end the DATA. */
const BODY = "First line\n.hidden\nlast ☂ line";

describe("smtp example driver", () => {
  let app: TestApp;
  let alice: ApiClient;
  let bundleId: string;
  let mock: MockSmtp;
  let rejecting: MockSmtp;
  let authing: MockSmtp;

  /** Authors an smtp service in the test bundle. */
  async function authorService(name: string, config: Record<string, unknown>, pins?: Record<string, string>) {
    return await alice.post(`/v1/bundles/${bundleId}/services`, {
      name,
      driver: "smtp",
      config,
      ...(pins ? { pins } : {}),
    });
  }

  async function run(serviceId: string, params: Record<string, unknown>) {
    return await alice.post(`/v1/services/${serviceId}/run`, { action: "send", params, wait_ms: 5000 });
  }

  beforeAll(async () => {
    [mock, rejecting, authing] = await Promise.all([
      startMockSmtp(),
      startMockSmtp({ rejectRcpt: true }),
      startMockSmtp({ requireAuth: true }),
    ]);
    app = await bootTestApp({ YAP_DRIVERS_DIR: driversDirWithSmtp(), YAP_HOOK_ALLOW_HOSTS: "127.0.0.1" });
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    const spaceId = (await alice.post("/v1/spaces", { name: "Mail" })).body.id;
    bundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "outbound" })).body.id;
  });

  afterAll(async () => {
    await app?.stop();
    await Promise.all([mock.close(), rejecting.close(), authing.close()]);
  });

  it("sends mail to the pinned recipient without exposing it", async () => {
    const created = await authorService(
      "notify-troels",
      { host: "127.0.0.1", port: mock.port, from: FROM },
      { to: PINNED_TO },
    );
    expect(created.status).toBe(201);
    // The pin is configuration: an agent reading the bundle sees only the two
    // parameters it may supply, and cannot even learn that `to` is fixed.
    expect(created.body.actions).toEqual([
      {
        name: "send",
        description: expect.any(String),
        params: [
          { name: "subject", description: expect.any(String), required: true },
          { name: "body", description: expect.any(String), required: true },
        ],
      },
    ]);

    const res = await run(created.body.id, { subject: SUBJECT, body: BODY });
    expect(res.status).toBe(200);
    expect(res.body.error).toBe(null);
    expect(res.body.status).toBe("succeeded");
    // The result says only that the mail was taken: echoing the recipient
    // would hand the pinned address back through run.result, which any
    // run_services holder can read.
    expect(res.body.result).toEqual({ accepted: true });
    expect(JSON.stringify(res.body)).not.toContain(PINNED_TO);
    // The pinned value never lands on the run row either.
    expect(res.body.params).toEqual({ subject: SUBJECT, body: BODY });

    expect(mock.messages).toHaveLength(1);
    const message = mock.messages[0]!;
    expect(message.from).toBe(FROM);
    expect(message.to).toEqual([PINNED_TO]);
    expect(message.data).toContain(`From: ${FROM}`);
    expect(message.data).toContain(`To: ${PINNED_TO}`);
    // Non-ASCII subject → RFC 2047 encoded word, not raw 8-bit header bytes.
    expect(message.data).toContain(
      `Subject: =?utf-8?B?${Buffer.from(SUBJECT, "utf8").toString("base64")}?=`,
    );
    expect(message.data).toContain("Content-Type: text/plain; charset=utf-8");
    // Body: dot-stuffed leading dot, UTF-8 kept intact.
    const body = message.data.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    expect(body).toBe("First line\r\n..hidden\r\nlast ☂ line");
  });

  it("normalizes a bare CR in the body so it cannot smuggle a second command", async () => {
    // A lone "\r" (no paired "\n") used to survive line-splitting whole and
    // reach the wire raw. A server that treats bare CR as its own line
    // terminator would read "\r.\r" as end-of-DATA followed by new SMTP
    // commands — smuggling straight past the pinned recipient. The fix
    // normalizes every line-break form to CRLF before dot-stuffing, so no
    // bare CR ever reaches the wire.
    const created = await authorService(
      "bare-cr",
      { host: "127.0.0.1", port: mock.port, from: FROM },
      { to: PINNED_TO },
    );
    const before = mock.messages.length;
    const smugglingBody = "x\r.\rRCPT TO:<attacker@evil.test>\r";
    const res = await run(created.body.id, { subject: "Hello", body: smugglingBody });
    expect(res.body.status).toBe("succeeded");

    expect(mock.messages).toHaveLength(before + 1);
    const message = mock.messages[mock.messages.length - 1]!;
    // Only the pinned recipient was ever recorded — the embedded "RCPT TO:"
    // text stayed inside the DATA payload as message content, never parsed
    // as a command of its own.
    expect(message.to).toEqual([PINNED_TO]);
    const body = message.data.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    // Every line-break form normalized to CRLF, and the lone "." line
    // dot-stuffed to "..", exactly as a legitimate leading-dot line would be.
    expect(body).toBe("x\r\n..\r\nRCPT TO:<attacker@evil.test>\r\n");
    // No orphan CR survives anywhere in what actually crossed the wire.
    expect(message.data).not.toMatch(/\r(?!\n)/);
  });

  it("refuses a caller-supplied recipient", async () => {
    const created = await authorService(
      "pinned-recipient",
      { host: "127.0.0.1", port: mock.port, from: FROM },
      { to: PINNED_TO },
    );
    const before = mock.messages.length;
    const res = await alice.post(`/v1/services/${created.body.id}/run`, {
      action: "send",
      params: { to: "attacker@example.test", subject: "hi", body: "hi" },
      wait_ms: 5000,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/"to" is fixed by this service configuration/);
    expect(mock.messages.length).toBe(before);
  });

  it("authenticates with AUTH LOGIN when the config carries credentials", async () => {
    const created = await authorService(
      "authed",
      { host: "127.0.0.1", port: authing.port, from: FROM, user: "postmaster", pass: "s3cret" },
      { to: PINNED_TO },
    );
    const res = await run(created.body.id, { subject: "Hello", body: "Authenticated." });
    expect(res.body.status).toBe("succeeded");
    expect(authing.authLines).toEqual([
      Buffer.from("postmaster", "utf8").toString("base64"),
      Buffer.from("s3cret", "utf8").toString("base64"),
    ]);
    expect(authing.messages).toHaveLength(1);
  });

  it("fails the run when the server rejects the recipient", async () => {
    const created = await authorService(
      "rejected",
      { host: "127.0.0.1", port: rejecting.port, from: FROM },
      { to: PINNED_TO },
    );
    const res = await run(created.body.id, { subject: "Hello", body: "Nobody home." });
    expect(res.body.status).toBe("failed");
    // A driver's plain Error is collapsed by the runs layer: the reply line
    // could echo an address, so it never reaches the agent-visible row.
    expect(res.body.errorCode).toBe("internal");
    expect(res.body.error).toBe("run failed");
    expect(rejecting.messages).toHaveLength(0);
  });

  it("blocks a private destination at run time even though authoring allowed it", async () => {
    // The smtp driver has no authoring-time online check (assertPublic speaks
    // only http(s)), so the guard that matters is the one inside
    // egress.connect — and it must refuse before a single byte is sent.
    const created = await authorService(
      "internal-relay",
      { host: "10.0.0.1", port: mock.port, from: FROM },
      { to: PINNED_TO },
    );
    expect(created.status).toBe(201);
    const before = mock.connections;
    const res = await alice.post(`/v1/services/${created.body.id}/run`, {
      action: "send",
      params: { subject: "Hello", body: "Should not leave." },
      // Well under the connect budget: a run that merely *hung* on 10.0.0.1
      // would still be running here, so a terminal `failed` is the guard.
      wait_ms: 3000,
    });
    expect(res.body.status).toBe("failed");
    expect(res.body.errorCode).toBe("internal");
    expect(mock.connections).toBe(before);
  });

  it("rejects a malformed config at authoring time, naming the field", async () => {
    const missingFrom = await authorService("no-from", { host: "127.0.0.1", port: mock.port });
    expect(missingFrom.status).toBe(400);
    expect(missingFrom.body.error.message).toMatch(/from/);

    const badPort = await authorService("bad-port", { host: "127.0.0.1", port: 0, from: FROM });
    expect(badPort.status).toBe(400);
    expect(badPort.body.error.message).toMatch(/port/);

    const halfCredentials = await authorService("half-auth", {
      host: "127.0.0.1",
      port: mock.port,
      from: FROM,
      user: "postmaster",
    });
    expect(halfCredentials.status).toBe(400);
    expect(halfCredentials.body.error.message).toMatch(/pass/);
  });
});

/**
 * The other half of the contract: a driver must honour `ctx.signal`. This app
 * caps every run at half a second, and the far end is a server that accepts the
 * connection and then says nothing — so only the abort can end the session, and
 * the driver has to close the socket it owns on its way out.
 */
describe("smtp example driver under the run budget", () => {
  let app: TestApp;
  let alice: ApiClient;
  let silent: MockSmtp;
  let serviceId: string;

  beforeAll(async () => {
    silent = await startMockSmtp({ silent: true });
    app = await bootTestApp({
      YAP_DRIVERS_DIR: driversDirWithSmtp(),
      YAP_HOOK_ALLOW_HOSTS: "127.0.0.1",
      YAP_RUN_TIMEOUT_CAP_MS: "500",
    });
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    const spaceId = (await alice.post("/v1/spaces", { name: "Mail" })).body.id;
    const bundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "outbound" })).body.id;
    const created = await alice.post(`/v1/bundles/${bundleId}/services`, {
      name: "into-the-void",
      driver: "smtp",
      config: { host: "127.0.0.1", port: silent.port, from: FROM },
      pins: { to: PINNED_TO },
    });
    serviceId = created.body.id;
  });

  afterAll(async () => {
    await app?.stop();
    await silent.close();
  });

  it("times the run out and closes the socket it opened", async () => {
    const res = await alice.post(`/v1/services/${serviceId}/run`, {
      action: "send",
      params: { subject: "Hello", body: "Nobody is listening." },
      wait_ms: 5000,
    });
    expect(res.body.status).toBe("failed");
    expect(res.body.error).toMatch(/timed out after 500ms/);
    expect(silent.connections).toBe(1);
    // The socket is the driver's to close — egress.dispose() does not touch it.
    await expect.poll(() => silent.closed, { timeout: 2000 }).toBe(1);
  });
});

/**
 * The zero-connection half of the SSRF guard: an operator who never
 * allowlists anything must get zero connections to a private destination,
 * not merely a `failed` run. This app boots with no `YAP_HOOK_ALLOW_HOSTS` at
 * all — unlike every describe block above, which allowlists 127.0.0.1 so the
 * mock server is reachable — and the service is pointed at the mock's own
 * host and port. If the guard let anything through, this is the one place a
 * real connection would land.
 */
describe("smtp example driver without an SSRF allowlist", () => {
  let app: TestApp;
  let alice: ApiClient;
  let loopback: MockSmtp;
  let serviceId: string;

  beforeAll(async () => {
    loopback = await startMockSmtp();
    app = await bootTestApp({ YAP_DRIVERS_DIR: driversDirWithSmtp() });
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    const spaceId = (await alice.post("/v1/spaces", { name: "Mail" })).body.id;
    const bundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "outbound" })).body.id;
    const created = await alice.post(`/v1/bundles/${bundleId}/services`, {
      name: "loopback-relay",
      driver: "smtp",
      // The mock's real host and port, unlike the fictitious 10.0.0.1 used
      // above — a guard failure here would show up as an actual connection.
      config: { host: "127.0.0.1", port: loopback.port, from: FROM },
      pins: { to: PINNED_TO },
    });
    serviceId = created.body.id;
  });

  afterAll(async () => {
    await app?.stop();
    await loopback.close();
  });

  it("blocks loopback at run time with zero connections reaching the server", async () => {
    const res = await alice.post(`/v1/services/${serviceId}/run`, {
      action: "send",
      params: { subject: "Hello", body: "Should never leave." },
      wait_ms: 3000,
    });
    expect(res.body.status).toBe("failed");
    expect(res.body.errorCode).toBe("internal");
    expect(loopback.connections).toBe(0);
  });
});
