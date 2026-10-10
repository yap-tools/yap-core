import { describe, expect, it } from "vitest";

import {
  ACCOUNT_CAPABILITIES,
  checkDeniedCapabilities,
  parseDeniedCapabilities,
  serializeDeniedCapabilities,
} from "../../src/core/accountCapabilities.js";
import { YapError } from "../../src/core/errors.js";

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
