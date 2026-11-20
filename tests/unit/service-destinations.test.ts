/**
 * describeDestinations: where a service sends data, as the approve page and
 * the secret form show it. Pins are filled in, what a run chooses is named,
 * a setting that is not there is left out, and a param destination counts
 * only when an allowed action takes it.
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { describeDestinations } from "../../src/core/serviceApprovals.js";
import { createDriverRegistry } from "../../src/server.js";

const config = loadConfig({
  YAP_SYSADMIN_KEY: "sysadmin-key-0123456789",
  YAP_MASTER_KEY: randomBytes(32).toString("base64"),
});
const registry = createDriverRegistry(config);
const mail = registry.get("mail");
const http = registry.get("http");

const mailSettings = {
  user: "me@example.com",
  from: "me@example.com",
  smtp: { host: "smtp.example.com", port: 465 },
};

describe("describeDestinations", () => {
  it("mail: shows the server it has, and a pinned recipient as the address", () => {
    const views = describeDestinations(mail, {
      settings: mailSettings,
      pins: { to: "boss@example.com" },
      params: [],
      actions: null,
    });
    expect(views).toEqual([
      { label: "SMTP server", value: "smtp.example.com:465", chosenPerRun: [] },
      { label: "Recipients (To)", value: "boss@example.com", chosenPerRun: [] },
      { label: "Recipients (Cc)", value: null, chosenPerRun: ["cc"] },
      { label: "Recipients (Bcc)", value: null, chosenPerRun: ["bcc"] },
    ]);
  });

  it("mail: a read-only service names no recipient", () => {
    const views = describeDestinations(mail, {
      settings: { ...mailSettings, imap: { host: "imap.example.com", port: 993, security: "tls" } },
      pins: {},
      params: [],
      actions: JSON.stringify(["search", "read"]),
    });
    expect(views.map((v) => v.label)).toEqual(["IMAP server", "SMTP server"]);
    expect(views[0]!.value).toBe("imap.example.com:993 (tls)");
  });

  it("http: fills pins into the url and names the rest", () => {
    const views = describeDestinations(http, {
      settings: { url: "https://api.example.com/{{team}}/{{note}}?x={{team}}", method: "POST" },
      pins: { team: "ops" },
      params: [{ name: "team" }, { name: "note" }],
      actions: null,
    });
    expect(views).toEqual([
      { label: "URL", value: "https://api.example.com/ops/{{note}}?x=ops", chosenPerRun: ["note"] },
    ]);
  });

  it("narrowed to some settings, labels an unnamed one by its path", () => {
    const views = describeDestinations(
      mail,
      { settings: { ...mailSettings, allow_plaintext_auth: false }, pins: {}, params: [], actions: null },
      ["imap", "smtp", "allow_plaintext_auth"],
    );
    expect(views).toEqual([
      { label: "SMTP server", value: "smtp.example.com:465", chosenPerRun: [] },
      { label: "allow_plaintext_auth", value: "false", chosenPerRun: [] },
    ]);
  });
});
