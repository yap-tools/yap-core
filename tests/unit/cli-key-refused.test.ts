/**
 * The CLI's user lane only knows an access key. Where key login is switched
 * off, the API's 401 carries details.reason, and the CLI says plainly why it
 * cannot connect instead of passing on a bare 401.
 */
import { describe, expect, it } from "vitest";

import { requireOk } from "../../src/cli/client.js";

const refused = (reason: string) => ({
  status: 401,
  body: { error: { code: "unauthorized", message: "Access keys can't be used on this instance.", details: { reason } } },
});

describe("requireOk on a refused key", () => {
  it("explains an instance that accepts only provider login", () => {
    expect(() => requireOk(refused("key_login_off"))).toThrow(
      "This instance accepts only provider login, and the CLI can only connect with an access key, so it cannot connect to this instance yet.",
    );
  });

  it("explains an account set to provider login only", () => {
    expect(() => requireOk(refused("provider_login_only"))).toThrow(/logs in only through a login provider/);
  });

  it("passes any other error through as the API worded it", () => {
    expect(() => requireOk({ status: 401, body: { error: { code: "unauthorized", message: "invalid or revoked access key" } } })).toThrow(
      "invalid or revoked access key",
    );
    expect(requireOk({ status: 200, body: { ok: true } })).toEqual({ ok: true });
  });
});
