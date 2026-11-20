import { describe, expect, it } from "vitest";

import {
  ACCOUNT_CAPABILITIES,
  checkDeniedCapabilities,
  parseDeniedCapabilities,
  serializeDeniedCapabilities,
} from "../../src/core/accountCapabilities.js";
import {
  assertAccountWrite,
  assertCanCreateSpaces,
  assertCanManageCredentials,
  runWithScope,
  type ScopedAuth,
  type TokenRole,
} from "../../src/core/authScope.js";
import { YapError } from "../../src/core/errors.js";
import { checkKeyScope } from "../../src/core/keys.js";

describe("account capabilities", () => {
  it("knows exactly manage_keys and create_spaces", () => {
    expect(ACCOUNT_CAPABILITIES).toEqual(["manage_keys", "create_spaces"]);
  });

  it("accepts any subset, deduplicated and in canonical order", () => {
    expect(checkDeniedCapabilities([])).toEqual([]);
    expect(checkDeniedCapabilities(["create_spaces"])).toEqual(["create_spaces"]);
    expect(checkDeniedCapabilities(["create_spaces", "manage_keys", "create_spaces"])).toEqual([
      "manage_keys",
      "create_spaces",
    ]);
  });

  it("rejects anything that is not an array of known names, listing what was unknown", () => {
    for (const bad of [undefined, null, "manage_keys", 1, {}, { 0: "manage_keys", length: 1 }]) {
      expect(() => checkDeniedCapabilities(bad), JSON.stringify(bad)).toThrow(YapError);
    }
    for (const bad of [["edit_items"], ["Manage_Keys"], [" manage_keys"], [null], [["manage_keys"]]]) {
      expect(() => checkDeniedCapabilities(bad), JSON.stringify(bad)).toThrow(YapError);
    }
    try {
      checkDeniedCapabilities(["manage_keys", "edit_items", 7]);
      expect.unreachable();
    } catch (err) {
      expect((err as YapError).code).toBe("invalid_request");
      expect((err as YapError).details).toEqual({
        unknown: ["edit_items", 7],
        allowed: ["manage_keys", "create_spaces"],
      });
    }
  });

  it("round-trips through storage, dropping names it does not know", () => {
    expect(parseDeniedCapabilities(serializeDeniedCapabilities(["manage_keys", "create_spaces"]))).toEqual([
      "manage_keys",
      "create_spaces",
    ]);
    expect(parseDeniedCapabilities("[]")).toEqual([]);
    expect(parseDeniedCapabilities('["create_spaces","from_a_newer_version"]')).toEqual(["create_spaces"]);
    expect(() => parseDeniedCapabilities('{"manage_keys":true}')).toThrow();
  });
});

describe("account-level checks under a scope", () => {
  const key = (role: TokenRole): ScopedAuth => ({ source: "key", userId: "u1", keyId: "k1", scope: { role } });
  const token = (role: TokenRole): ScopedAuth => ({ source: "token", userId: "u1", grantId: "g1", scope: { role } });
  const passes = (auth: ScopedAuth | undefined, check: () => void): boolean => {
    try {
      if (auth) runWithScope(auth, check);
      else check();
      return true;
    } catch (err) {
      if (err instanceof YapError && err.code === "forbidden") return false;
      throw err;
    }
  };

  it("credential management: unscoped keys and admin tokens yes, scoped keys never", () => {
    expect(passes(undefined, assertCanManageCredentials)).toBe(true);
    expect(passes(token("admin"), assertCanManageCredentials)).toBe(true);
    expect(passes(token("member"), assertCanManageCredentials)).toBe(false);
    for (const role of ["admin", "member", "read-only"] as const) {
      expect(passes(key(role), assertCanManageCredentials), role).toBe(false);
    }
  });

  it("create_spaces: a scoped key only at admin; tokens keep their rule (anything but read-only)", () => {
    const createSpace = () => {
      assertAccountWrite();
      assertCanCreateSpaces();
    };
    expect(passes(undefined, createSpace)).toBe(true);
    expect(passes(key("admin"), createSpace)).toBe(true);
    expect(passes(key("member"), createSpace)).toBe(false);
    expect(passes(key("read-only"), createSpace)).toBe(false);
    expect(passes(token("admin"), createSpace)).toBe(true);
    expect(passes(token("member"), createSpace)).toBe(true);
    expect(passes(token("read-only"), createSpace)).toBe(false);
  });

  it("account writes are refused to a read-only scope of either kind", () => {
    expect(passes(key("read-only"), assertAccountWrite)).toBe(false);
    expect(passes(token("read-only"), assertAccountWrite)).toBe(false);
    expect(passes(key("member"), assertAccountWrite)).toBe(true);
  });
});

describe("checkKeyScope", () => {
  it("absent or null is unscoped; a known role is kept and nothing else", () => {
    expect(checkKeyScope(undefined)).toBeNull();
    expect(checkKeyScope(null)).toBeNull();
    for (const role of ["admin", "member", "read-only"]) expect(checkKeyScope({ role })).toEqual({ role });
  });

  it("refuses location, unknown fields, unknown roles and non-objects", () => {
    for (const bad of [{ role: "member", spaces: [] }, { role: "member", bundles: ["b"] }, { role: "member", extra: 1 }, { role: "owner" }, {}, "member", ["member"], 1]) {
      expect(() => checkKeyScope(bad), JSON.stringify(bad)).toThrow(YapError);
    }
  });
});
