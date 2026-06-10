import { describe, expect, it } from "vitest";

import { YapError } from "../../src/core/errors.js";
import { assertPublicDestination, isPrivateAddress } from "../../src/core/ssrf.js";

describe("isPrivateAddress", () => {
  it("flags loopback, private, link-local, CGNAT, and special v4 ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "127.255.255.255",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "169.254.0.1",
      "100.64.0.1",
      "0.0.0.0",
      "198.18.0.1",
      "192.0.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("passes public v4 addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "11.0.0.1", "100.128.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("flags v6 loopback, unique-local, link-local, and mapped-private", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("passes public v6 addresses", () => {
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("assertPublicDestination", () => {
  const resolveTo =
    (...addresses: string[]) =>
    async () =>
      addresses;

  it("denies private destinations by default", async () => {
    await expect(assertPublicDestination("http://127.0.0.1:9999/x", [])).rejects.toThrow(YapError);
    await expect(assertPublicDestination("http://192.168.1.10/x", [])).rejects.toThrow(/denied by default/);
    await expect(
      assertPublicDestination("https://internal.corp/x", [], resolveTo("10.1.2.3")),
    ).rejects.toThrow(/private/);
  });

  it("denies when ANY resolved address is private (DNS rebinding defense)", async () => {
    await expect(
      assertPublicDestination("https://evil.example/x", [], resolveTo("93.184.216.34", "127.0.0.1")),
    ).rejects.toThrow(/private/);
  });

  it("allows public destinations", async () => {
    await expect(
      assertPublicDestination("https://api.example.com/hook", [], resolveTo("93.184.216.34")),
    ).resolves.toBeUndefined();
  });

  it("the operator allowlist overrides, by hostname or by IP", async () => {
    await expect(assertPublicDestination("http://127.0.0.1:9999/x", ["127.0.0.1"])).resolves.toBeUndefined();
    await expect(
      assertPublicDestination("https://internal.corp/x", ["internal.corp"], resolveTo("10.1.2.3")),
    ).resolves.toBeUndefined();
    await expect(
      assertPublicDestination("https://internal.corp/x", ["10.1.2.3"], resolveTo("10.1.2.3")),
    ).resolves.toBeUndefined();
  });

  it("rejects non-http(s) schemes and malformed URLs", async () => {
    await expect(assertPublicDestination("ftp://example.com/x", [])).rejects.toThrow(/http/);
    await expect(assertPublicDestination("file:///etc/passwd", [])).rejects.toThrow(/http/);
    await expect(assertPublicDestination("not a url", [])).rejects.toThrow(/valid URL/);
  });

  it("rejects unresolvable hosts", async () => {
    await expect(
      assertPublicDestination("https://nope.invalid/x", [], async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow(/could not be resolved/);
  });
});
