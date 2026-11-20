/**
 * The helpers MCP authoring and the secret form rely on (serviceConfig.ts):
 * finding secret values in settings, matching a concrete path to a schema
 * secret, the placeholder candidates for secrets not set yet, and setting
 * secrets from a form.
 */
import { describe, expect, it } from "vitest";

import { createHttpDriver } from "../../src/core/drivers/http.js";
import { createMailDriver } from "../../src/core/drivers/mail/index.js";
import { neededSecrets } from "../../src/core/services.js";
import {
  dropMovedSecrets,
  mergeConfig,
  PENDING_SECRET,
  pendingSecretCandidates,
  secretFieldFor,
  secretValuesIn,
  setSecrets,
} from "../../src/core/serviceConfig.js";
import { loadConfig } from "../../src/config.js";
import { testEnv } from "../helpers/app.js";

const http = createHttpDriver(loadConfig(testEnv()));
const mail = createMailDriver();

describe("secretValuesIn", () => {
  it("lists the secret paths that hold a value, map keys spelled out", () => {
    expect(secretValuesIn(http, { url: "x", headers: { authorization: "t", "x-key": "k" } })).toEqual([
      "headers.authorization",
      "headers.x-key",
    ]);
    expect(secretValuesIn(mail, { user: "u", oauth2: { client_id: "c", client_secret: "s" } })).toEqual([
      "oauth2.client_secret",
    ]);
  });

  it("ignores nulls and empty maps", () => {
    expect(secretValuesIn(mail, { user: "u", pass: null })).toEqual([]);
    expect(secretValuesIn(http, { url: "x", headers: {} })).toEqual([]);
  });
});

describe("secretFieldFor", () => {
  it("matches a concrete path to its schema field, * as any key", () => {
    expect(secretFieldFor(http, "headers.authorization")?.path).toBe("headers.*");
    expect(secretFieldFor(mail, "oauth2.refresh_token")?.label).toBe("OAuth refresh token");
  });

  it("refuses non-secret paths, wildcards and odd segments", () => {
    for (const path of ["url", "headers.*", "headers", "headers.a.b", "pass.x", "headers.__proto__ x", ""]) {
      expect(secretFieldFor(path.startsWith("headers") || path === "url" ? http : mail, path), path).toBeUndefined();
    }
  });
});

describe("pendingSecretCandidates", () => {
  const base = { user: "u@example.com", from: "u@example.com", smtp: { host: "smtp.example.com", port: 465 } };

  it("is the config itself when nothing is missing", () => {
    const config = { ...base, pass: "p" };
    expect(pendingSecretCandidates(mail, config)).toEqual({ pending: [], candidates: [{ config, filled: [] }] });
  });

  it("offers nested-only, then everything, so one of several credentials can pass", () => {
    const { pending, candidates } = pendingSecretCandidates(mail, { ...base, oauth2: { client_id: "c" } });
    expect(pending).toEqual(["oauth2.client_secret", "oauth2.refresh_token", "pass"]);
    expect(candidates.map((c) => c.filled)).toEqual([
      ["oauth2.client_secret", "oauth2.refresh_token"],
      ["pass", "oauth2.client_secret", "oauth2.refresh_token"],
    ]);
    expect(candidates[0]!.config).toMatchObject({ oauth2: { client_secret: PENDING_SECRET } });
    expect(candidates[0]!.config).not.toHaveProperty("pass");
  });

  it("never treats a map path as missing", () => {
    expect(pendingSecretCandidates(http, { url: "x", method: "GET" }).pending).toEqual([]);
  });
});

describe("setSecrets", () => {
  it("sets the paths given, adds their objects to the settings, and keeps the rest", () => {
    const out = setSecrets({ url: "x" }, { headers: { a: "1" } }, { "headers.b": "2" });
    expect(out.settings).toEqual({ url: "x", headers: {} });
    expect(out.secrets).toEqual({ headers: { a: "1", b: "2" } });
    expect(out.merged).toEqual(mergeConfig(out.settings, out.secrets));
    expect(out.merged).toEqual({ url: "x", headers: { a: "1", b: "2" } });
  });

  it("replaces a secret already set", () => {
    expect(setSecrets({ user: "u" }, { pass: "old" }, { pass: "new" }).secrets).toEqual({ pass: "new" });
  });
});

describe("neededSecrets", () => {
  const base = { user: "u@example.com", from: "u@example.com", smtp: { host: "smtp.example.com", port: 465 } };
  const oauth2 = { client_id: "c", token_url: "https://o.example.com/t" };

  it("is empty for a complete config, so the online check runs (a full oauth2 block has no pass)", () => {
    expect(neededSecrets(mail, { ...base, oauth2: { ...oauth2, client_secret: "s", refresh_token: "r" } })).toEqual([]);
    expect(neededSecrets(mail, { ...base, pass: "p" })).toEqual([]);
  });

  it("names the secrets that make the config valid", () => {
    expect(neededSecrets(mail, { ...base, oauth2 })).toEqual(["oauth2.client_secret", "oauth2.refresh_token"]);
    expect(neededSecrets(mail, base)).toEqual(["pass"]);
  });

  it("throws the driver's refusal when no filling works", () => {
    expect(() => neededSecrets(mail, { ...base, from: "nope" })).toThrow(/from .*filled in: pass/);
  });
});

describe("dropMovedSecrets", () => {
  it("drops a secret whose bound setting changes, and keeps it otherwise", () => {
    const before = { url: "https://a.example.com/x", method: "POST", headers: {} };
    const secrets = { headers: { authorization: "t" } };
    expect(dropMovedSecrets(http, before, { ...before, method: "PUT" }, secrets)).toEqual({ secrets, dropped: [] });
    expect(dropMovedSecrets(http, before, { ...before, url: "https://b.example.com/x" }, secrets)).toEqual({
      secrets: {},
      dropped: ["headers.authorization"],
    });
  });

  it("binds mail secrets to the servers they go to", () => {
    const before = { user: "u", smtp: { host: "smtp.example.com", port: 465 } };
    const moved = dropMovedSecrets(mail, before, { ...before, smtp: { host: "evil.example.com", port: 465 } }, { pass: "p" });
    expect(moved.dropped).toEqual(["pass"]);
    const renamed = dropMovedSecrets(mail, before, { ...before, user: "v" }, { pass: "p" });
    expect(renamed.dropped).toEqual([]);
  });
});
