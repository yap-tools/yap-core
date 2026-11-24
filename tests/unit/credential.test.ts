/**
 * The credential lane: resolveCredential's dispatch — missing, sysadmin
 * (constant-time, before any DB work), token-prefix routing, and key lookup —
 * plus bearer-header parsing. The valid-token outcome is exercised end to end
 * by the OAuth integration suite, which drives both transports through this
 * module.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bearerToken, resolveCredential, scopeOf } from "../../src/core/credential.js";
import { issueKeyForUser } from "../../src/core/keys.js";
import { createUser, updateUser } from "../../src/core/users.js";
import { OAUTH_ACCESS_TOKEN_PREFIX } from "../../src/crypto.js";
import { createDb, type Db } from "../../src/db/index.js";

const oidc = { providers: [], signup: false, allow: [] };
const config = { sysadminKey: "yap_sys_test_sysadmin_key", keyLogin: true, oidc };

let db: Db;
let userId: string;
let accessKey: string;

beforeAll(async () => {
  db = await createDb({ dialect: "sqlite", path: ":memory:" });
  await db.migrate();
  const created = await createUser(db, config, { name: "ada" });
  userId = created.user.id;
  accessKey = created.initialKey.key;
});

afterAll(async () => {
  await db.close();
});

describe("bearerToken", () => {
  it("extracts the secret, case-insensitively, trimming whitespace", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer  abc ")).toBe("abc");
    expect(bearerToken(" Bearer\tabc")).toBe("abc");
  });

  it("rejects non-bearer and empty headers", () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("")).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
  });
});

describe("resolveCredential", () => {
  it("reports a missing credential", async () => {
    expect(await resolveCredential(db, config, null)).toEqual({ kind: "missing" });
    expect(await resolveCredential(db, config, "")).toEqual({ kind: "missing" });
  });

  it("recognizes the sysadmin key before touching any lane", async () => {
    expect(await resolveCredential(db, config, config.sysadminKey)).toEqual({ kind: "sysadmin" });
  });

  it("resolves a live access key to its user", async () => {
    expect(await resolveCredential(db, config, accessKey)).toEqual({ kind: "user", userId });
  });

  it("an unscoped key runs with no scope context", async () => {
    expect(scopeOf(await resolveCredential(db, config, accessKey))).toBeUndefined();
  });

  it("a scoped key carries the key context to run under: its id and scope", async () => {
    const scoped = await issueKeyForUser(db, config, userId, "agent", { role: "read-only" });
    const outcome = await resolveCredential(db, config, scoped.key);
    expect(outcome).toEqual({
      kind: "user",
      userId,
      keyAuth: { source: "key", userId, keyId: scoped.id, scope: { role: "read-only" } },
    });
    expect(scopeOf(outcome)).toEqual({ source: "key", userId, keyId: scoped.id, scope: { role: "read-only" } });
  });

  it("fails closed on a stored scope it cannot read: the key does not authenticate", async () => {
    const scoped = await issueKeyForUser(db, config, userId, "corrupt", { role: "member" });
    const { accessKeys } = db.tables;
    for (const stored of ['{"role":"root"}', "not json", "null", '{"role":"member","spaces":["s"]}']) {
      await db.client.update(accessKeys).set({ scope: stored }).where(eq(accessKeys.id, scoped.id));
      expect(await resolveCredential(db, config, scoped.key), stored).toEqual({ kind: "invalid-key" });
    }
  });

  it("reports an unknown key as invalid-key", async () => {
    expect(await resolveCredential(db, config, "yap_nope")).toEqual({ kind: "invalid-key" });
  });

  it("routes the token prefix to the token lane, never the key lane", async () => {
    // An unknown secret with the access-token prefix must fail as a token,
    // not fall through to the key lookup.
    expect(await resolveCredential(db, config, `${OAUTH_ACCESS_TOKEN_PREFIX}unknown`)).toEqual({
      kind: "invalid-token",
    });
  });

  it("with key login off for the instance, refuses every key the same way, valid or made up", async () => {
    const off = { ...config, keyLogin: false };
    for (const presented of [accessKey, "yap_nope"]) {
      expect(await resolveCredential(db, off, presented)).toEqual({
        kind: "key-refused",
        reason: "key-login-off",
        message: "Access keys can't be used on this instance. Connect with a login provider.",
      });
    }
    // The sysadmin key keeps its own lane.
    expect(await resolveCredential(db, off, config.sysadminKey)).toEqual({ kind: "sysadmin" });
  });

  it("refuses the keys of a provider-login-only user, and only theirs", async () => {
    const other = await createUser(db, config, { name: "grace" });
    await updateUser(db, userId, { providerLoginOnly: true });
    try {
      expect(await resolveCredential(db, config, accessKey)).toMatchObject({
        kind: "key-refused",
        reason: "provider-login-only",
      });
      expect(await resolveCredential(db, config, other.initialKey.key)).toEqual({ kind: "user", userId: other.user.id });
    } finally {
      await updateUser(db, userId, { providerLoginOnly: false });
    }
    expect(await resolveCredential(db, config, accessKey)).toEqual({ kind: "user", userId });
  });
});
