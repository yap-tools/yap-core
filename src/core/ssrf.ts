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
    const h = ipv6Hextets(ip);
    if (!h) return true; // unparseable address → treat as unsafe (deny)
    // ::1 (loopback) and :: (unspecified).
    if (h.slice(0, 7).every((x) => x === 0) && (h[7] === 0 || h[7] === 1)) return true;
    // IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), and NAT64
    // (64:ff9b::/96) all embed a v4 address in the last two hextets — check
    // it against the v4 ranges regardless of dotted-vs-hex spelling.
    const firstFiveZero = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0;
    const isMapped = firstFiveZero && (h[5] === 0xffff || h[5] === 0);
    const isNat64 = h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0;
    if (isMapped || isNat64) {
      const v4 = `${(h[6]! >> 8) & 0xff}.${h[6]! & 0xff}.${(h[7]! >> 8) & 0xff}.${h[7]! & 0xff}`;
      return isPrivateAddress(v4);
    }
    if ((h[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((h[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    return false;
  }
  return false;
}

/** Expands any IPv6 literal (with `::` compression and/or an embedded
 * dotted-quad) to its 8 hextets, or null if malformed. */
function ipv6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // Rewrite a trailing embedded IPv4 dotted-quad into two hex groups.
  const lastColon = s.lastIndexOf(":");
  const lastPart = s.slice(lastColon + 1);
  if (lastPart.includes(".")) {
    const v4 = lastPart.split(".").map((n) => Number(n));
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const tail = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const hextets = groups.map((g) => parseInt(g || "0", 16));
  if (hextets.some((x) => Number.isNaN(x) || x < 0 || x > 0xffff)) return null;
  return hextets;
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
