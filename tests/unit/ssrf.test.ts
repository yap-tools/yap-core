import { describe, expect, it } from "vitest";

import { YapError } from "../../src/core/errors.js";
import {
  assertPublicDestination,
  createPinningLookup,
  isPrivateAddress,
  SSRF_PIN_ERROR_CODE,
  type AllAddressLookup,
} from "../../src/core/ssrf.js";

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

  it("flags hex-form IPv4-mapped private addresses (regression: dotted-only check was bypassable)", () => {
    for (const ip of [
      "::ffff:7f00:1", // 127.0.0.1
      "::ffff:a9fe:a9fe", // 169.254.169.254 (cloud metadata)
      "::ffff:a00:1", // 10.0.0.1
      "::ffff:c0a8:1", // 192.168.0.1
      "::127.0.0.1", // IPv4-compatible (deprecated) loopback
      "64:ff9b::7f00:1", // NAT64 of 127.0.0.1
      "64:ff9b::a9fe:a9fe", // NAT64 of metadata
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("passes public v6 addresses", () => {
    for (const ip of [
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
      "::ffff:808:808", // 8.8.8.8 in hex
      "64:ff9b::808:808", // NAT64 of 8.8.8.8
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("denies bracketed hex-mapped loopback as a hook destination", async () => {
    await expect(assertPublicDestination("http://[::ffff:7f00:1]/x", [])).rejects.toThrow(YapError);
    await expect(assertPublicDestination("http://[::ffff:a9fe:a9fe]/latest/meta-data/", [])).rejects.toThrow(
      YapError,
    );
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

describe("createPinningLookup (connect-time validation that closes DNS rebinding)", () => {
  const dnsReturning =
    (addresses: { address: string; family: number }[], err?: Error): AllAddressLookup =>
    (_hostname, _options, callback) =>
      callback((err ?? null) as NodeJS.ErrnoException | null, err ? [] : addresses);

  function run(
    lookup: ReturnType<typeof createPinningLookup>,
    hostname: string,
    options: { all?: boolean } = {},
  ): { err: unknown; args: unknown[] } {
    let captured: { err: unknown; args: unknown[] } = { err: undefined, args: [] };
    lookup(hostname, options as never, (err: unknown, ...args: unknown[]) => {
      captured = { err, args };
    });
    return captured;
  }

  it("blocks when the resolved address is private", () => {
    const lookup = createPinningLookup([], dnsReturning([{ address: "127.0.0.1", family: 4 }]));
    const { err } = run(lookup, "evil.example", { all: true });
    expect((err as { code?: string }).code).toBe(SSRF_PIN_ERROR_CODE);
  });

  it("blocks when ANY resolved address is private (rebinding mix)", () => {
    const lookup = createPinningLookup(
      [],
      dnsReturning([
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ]),
    );
    const { err } = run(lookup, "evil.example", { all: true });
    expect((err as { code?: string }).code).toBe(SSRF_PIN_ERROR_CODE);
  });

  it("passes public addresses in the all-array form", () => {
    const addrs = [{ address: "93.184.216.34", family: 4 }];
    const lookup = createPinningLookup([], dnsReturning(addrs));
    const { err, args } = run(lookup, "ok.example", { all: true });
    expect(err).toBeNull();
    expect(args[0]).toEqual(addrs);
  });

  it("returns the first address + family in the single (non-all) form", () => {
    const lookup = createPinningLookup([], dnsReturning([{ address: "93.184.216.34", family: 4 }]));
    const { err, args } = run(lookup, "ok.example", {});
    expect(err).toBeNull();
    expect(args).toEqual(["93.184.216.34", 4]);
  });

  it("an allowlisted resolved IP is permitted even though it is private", () => {
    const lookup = createPinningLookup(["10.0.0.5"], dnsReturning([{ address: "10.0.0.5", family: 4 }]));
    const { err } = run(lookup, "internal.corp", { all: true });
    expect(err).toBeNull();
  });

  it("propagates resolution failures", () => {
    const lookup = createPinningLookup([], dnsReturning([], new Error("ENOTFOUND")));
    const { err } = run(lookup, "nope.invalid", { all: true });
    expect(err).toBeInstanceOf(Error);
  });
});
