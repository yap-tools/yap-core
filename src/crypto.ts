/**
 * Cryptographic primitives:
 * - access-key generation and hashing (keys are stored hashed, never plain)
 * - AES-256-GCM secret encryption for hook transports (master key from env)
 * - HMAC-signed expiring tokens for upload/download links and widget pages
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const ACCESS_KEY_PREFIX = "yap_";
/** OAuth access-token prefix — distinct so the auth layer can route lanes. */
export const OAUTH_ACCESS_TOKEN_PREFIX = "yap_at_";
/** OAuth refresh-token prefix. */
export const OAUTH_REFRESH_TOKEN_PREFIX = "yap_rt_";

export function generateAccessKey(): string {
  return ACCESS_KEY_PREFIX + randomBytes(32).toString("base64url");
}

export function generateSecret(prefix = ""): string {
  return prefix + randomBytes(32).toString("base64url");
}

/** PKCE S256: base64url(sha256(verifier)) must equal the stored challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier, "utf8").digest("base64url");
  return constantTimeEqual(computed, challenge);
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Encrypts to "v1.<iv>.<tag>.<ciphertext>" (base64url parts). */
export function encryptSecret(plaintext: string, masterKey: Buffer): string {
  if (masterKey.length !== 32) throw new Error("master key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(encrypted: string, masterKey: Buffer): string {
  const parts = encrypted.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("malformed encrypted secret");
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(ivB64!, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64!, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64!, "base64url")), decipher.final()]).toString("utf8");
}

export type TokenPayload = Record<string, unknown> & { exp: number };

function hmac(data: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("base64url");
}

/** Signs a payload into "<base64url(json)>.<hmac>" with an expiry. */
export function signToken(
  payload: Record<string, unknown>,
  secret: Buffer,
  ttlSeconds: number,
  nowMs: number = Date.now(),
): string {
  const body: TokenPayload = { ...payload, exp: Math.floor(nowMs / 1000) + ttlSeconds };
  const data = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  return `${data}.${hmac(data, secret)}`;
}

/** Returns the payload if the signature is valid and unexpired, else null. */
export function verifyToken(
  token: string,
  secret: Buffer,
  nowMs: number = Date.now(),
): TokenPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(data, secret);
  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 < nowMs) return null;
  return payload;
}
