/**
 * The credential lane: resolveCredential's dispatch — missing, sysadmin
 * (constant-time, before any DB work), token-prefix routing, and key lookup —
 * plus bearer-header parsing. The valid-token outcome is exercised end to end
 * by the OAuth integration suite, which drives both transports through this
 * module.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bearerToken, resolveCredential } from "../../src/core/credential.js";
import { createUser } from "../../src/core/users.js";
import { OAUTH_ACCESS_TOKEN_PREFIX } from "../../src/crypto.js";
import { createDb, type Db } from "../../src/db/index.js";

const config = { sysadminKey: "yap_sys_test_sysadmin_key" };

let db: Db;
let userId: string;
let accessKey: string;

beforeAll(async () => {
  db = await createDb({ dialect: "sqlite", path: ":memory:" });
  await db.migrate();
  const created = await createUser(db, { name: "ada" });
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
});
