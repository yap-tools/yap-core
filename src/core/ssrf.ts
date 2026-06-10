/**
 * The SSRF guard. Yap's server fetches hook destinations, which makes hooks a
 * server-side request forgery vector against the operator's own network. The
 * guard (normative per the brief): destination URLs resolving to private,
 * link-local, or localhost ranges are denied by default — checked at hook
 * creation AND re-checked at fire time, since DNS can change — with an
 * operator-overridable allowlist for legitimate internal targets.
 */
import { isIP } from "node:net";
import dns from "node:dns/promises";

import { invalid } from "./errors.js";

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inV4Cidr(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incl. cloud metadata 169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
];

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    return PRIVATE_V4_RANGES.some(([base, bits]) => inV4Cidr(ip, base, bits));
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);
    if (lower === "::" || lower === "::1") return true;
    const firstWord = lower.split(":")[0] || "0";
    const first = parseInt(firstWord.padEnd(4, "0").slice(0, 4), 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    return false;
  }
  return false;
}

export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

function hostAllowed(hostname: string, allowHosts: string[]): boolean {
  const needle = hostname.toLowerCase();
  return allowHosts.some((h) => h.toLowerCase() === needle);
}

/**
 * Throws unless every address the destination resolves to is public — or the
 * host is explicitly allowlisted in configuration.
 */
export async function assertPublicDestination(
  rawUrl: string,
  allowHosts: string[],
  resolver: Resolver = defaultResolver,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw invalid(`hook destination is not a valid URL: ${JSON.stringify(rawUrl)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalid(`hook destination must be http(s), got ${url.protocol}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, ""); // strip ipv6 brackets
  if (hostAllowed(hostname, allowHosts)) return;

  const addresses = isIP(hostname) ? [hostname] : await resolveOrFail(hostname, resolver);
  const blocked = addresses.filter((addr) => isPrivateAddress(addr) && !hostAllowed(addr, allowHosts));
  if (blocked.length > 0) {
    throw invalid(
      `hook destination ${hostname} resolves to a private, link-local, or localhost address (${blocked.join(", ")}); ` +
        `denied by default — add the host to YAP_HOOK_ALLOW_HOSTS to permit internal targets`,
    );
  }
}

async function resolveOrFail(hostname: string, resolver: Resolver): Promise<string[]> {
  try {
    const addresses = await resolver(hostname);
    if (addresses.length === 0) throw new Error("no addresses");
    return addresses;
  } catch {
    throw invalid(`hook destination ${hostname} could not be resolved`);
  }
}
