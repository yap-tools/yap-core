import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  constantTimeEqual,
  decryptSecret,
  encryptSecret,
  generateAccessKey,
  hashKey,
  signToken,
  verifyToken,
} from "../../src/crypto.js";

describe("access keys", () => {
  it("generates prefixed, unique, url-safe keys", () => {
    const a = generateAccessKey();
    const b = generateAccessKey();
    expect(a).toMatch(/^yap_[A-Za-z0-9_-]{40,}$/);
    expect(a).not.toBe(b);
  });

  it("hashes deterministically", () => {
    const key = generateAccessKey();
    expect(hashKey(key)).toBe(hashKey(key));
    expect(hashKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKey(key)).not.toBe(hashKey(generateAccessKey()));
  });

  it("compares in constant time regardless of length", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcdef")).toBe(false);
  });
});

describe("secret encryption (AES-256-GCM)", () => {
  const masterKey = randomBytes(32);

  it("round-trips", () => {
    const plain = JSON.stringify({ url: "https://example.com", headers: { authorization: "Bearer s3cr3t" } });
    const enc = encryptSecret(plain, masterKey);
    expect(enc).not.toContain("s3cr3t");
    expect(decryptSecret(enc, masterKey)).toBe(plain);
  });

  it("produces distinct ciphertexts per call (random IV)", () => {
    expect(encryptSecret("x", masterKey)).not.toBe(encryptSecret("x", masterKey));
  });

  it("rejects tampered ciphertext", () => {
    const enc = encryptSecret("payload", masterKey);
    const parts = enc.split(".");
    const ct = Buffer.from(parts[3]!, "base64url");
    ct[0] = ct[0]! ^ 0xff;
    parts[3] = ct.toString("base64url");
    expect(() => decryptSecret(parts.join("."), masterKey)).toThrow();
  });

  it("rejects the wrong master key", () => {
    const enc = encryptSecret("payload", masterKey);
    expect(() => decryptSecret(enc, randomBytes(32))).toThrow();
  });
});

describe("signed tokens", () => {
  const secret = randomBytes(32);

  it("round-trips payload with expiry", () => {
    const token = signToken({ fileId: "f1", scope: "download" }, secret, 60);
    const payload = verifyToken(token, secret);
    expect(payload).toMatchObject({ fileId: "f1", scope: "download" });
  });

  it("rejects expired tokens", () => {
    const now = Date.now();
    const token = signToken({ a: 1 }, secret, 30, now);
    expect(verifyToken(token, secret, now + 29_000)).not.toBeNull();
    expect(verifyToken(token, secret, now + 31_000)).toBeNull();
  });

  it("rejects tampered payloads and signatures", () => {
    const token = signToken({ fileId: "f1" }, secret, 60);
    const [data, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ fileId: "f2", exp: 9999999999 })).toString("base64url");
    expect(verifyToken(`${forged}.${sig}`, secret)).toBeNull();
    expect(verifyToken(`${data}.AAAA${sig!.slice(4)}`, secret)).toBeNull();
    expect(verifyToken("garbage", secret)).toBeNull();
  });

  it("rejects tokens signed with another secret", () => {
    const token = signToken({ a: 1 }, randomBytes(32), 60);
    expect(verifyToken(token, secret)).toBeNull();
  });
});
