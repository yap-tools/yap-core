/**
 * Pure-logic coverage of the OAuth building blocks: scope wire format,
 * redirect URI matching (exact, with the RFC 8252 loopback port exemption),
 * the token-scope capability clamp, and PKCE S256 verification.
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { runWithTokenAuth, type TokenScope } from "../../src/core/authScope.js";
import { scopeAllows } from "../../src/core/capabilities.js";
import { formatScope, parseScopeParam, redirectUriMatches } from "../../src/core/oauth.js";
import { verifyPkceS256 } from "../../src/crypto.js";

const space = { id: "sp1", ownerId: "u1", personal: 0 };

describe("scope wire format", () => {
  it("defaults to role:member when nothing is requested", () => {
    expect(parseScopeParam(undefined)).toEqual({ role: "member" });
    expect(parseScopeParam("")).toEqual({ role: "member" });
  });

  it("parses role, space, and bundle entries and round-trips", () => {
    const scope = parseScopeParam("role:read-only space:sp1 bundle:b1 bundle:b2");
    expect(scope).toEqual({ role: "read-only", spaces: ["sp1"], bundles: ["b1", "b2"] });
    expect(formatScope(scope)).toBe("role:read-only space:sp1 bundle:b1 bundle:b2");
  });

  it("ignores unknown entries and unknown roles (RFC 6749 narrowing)", () => {
    expect(parseScopeParam("openid profile role:owner role:admin claudeai")).toEqual({ role: "admin" });
  });

  it("resolves multiple requested roles to member (clients often request every advertised scope)", () => {
    expect(parseScopeParam("role:admin role:member role:read-only")).toEqual({ role: "member" });
    expect(parseScopeParam("role:admin role:read-only")).toEqual({ role: "member" });
  });
});

describe("redirectUriMatches", () => {
  it("matches exactly for non-loopback URIs", () => {
    expect(redirectUriMatches("https://app.example/cb", "https://app.example/cb")).toBe(true);
    expect(redirectUriMatches("https://app.example/cb", "https://app.example/cb2")).toBe(false);
    expect(redirectUriMatches("https://app.example/cb", "https://evil.example/cb")).toBe(false);
  });

  it("ignores the port for loopback http (RFC 8252 §7.3) but nothing else", () => {
    expect(redirectUriMatches("http://127.0.0.1/cb", "http://127.0.0.1:54321/cb")).toBe(true);
    expect(redirectUriMatches("http://localhost:3000/cb", "http://localhost:9999/cb")).toBe(true);
    expect(redirectUriMatches("http://127.0.0.1/cb", "http://127.0.0.1:54321/other")).toBe(false);
    expect(redirectUriMatches("https://app.example/cb", "https://app.example:444/cb")).toBe(false);
  });
});

describe("scopeAllows (the token clamp)", () => {
  it("admin scope never clamps capabilities", () => {
    const scope: TokenScope = { role: "admin" };
    for (const cap of ["read_items", "edit_items", "manage_roles", "custom_cap"]) {
      expect(scopeAllows(scope, cap, { space })).toBe(true);
    }
  });

  it("member scope allows content but not management", () => {
    const scope: TokenScope = { role: "member" };
    expect(scopeAllows(scope, "edit_items", { space })).toBe(true);
    expect(scopeAllows(scope, "create_bundles", { space })).toBe(true);
    expect(scopeAllows(scope, "manage_roles", { space })).toBe(false);
    expect(scopeAllows(scope, "manage_space", { space })).toBe(false);
  });

  it("read-only scope allows only reads", () => {
    const scope: TokenScope = { role: "read-only" };
    expect(scopeAllows(scope, "read_items", { space })).toBe(true);
    expect(scopeAllows(scope, "read_files", { space })).toBe(true);
    expect(scopeAllows(scope, "edit_items", { space })).toBe(false);
    expect(scopeAllows(scope, "fire_hooks", { space })).toBe(false);
  });

  it("resource restriction covers a listed space and a listed bundle, nothing else", () => {
    const scope: TokenScope = { role: "member", spaces: ["sp1"], bundles: ["b9"] };
    expect(scopeAllows(scope, "read_items", { space })).toBe(true); // sp1 listed
    expect(scopeAllows(scope, "read_items", { space: { ...space, id: "sp2" } })).toBe(false);
    expect(scopeAllows(scope, "read_items", { space: { ...space, id: "sp2" }, bundleId: "b9" })).toBe(true);
    expect(scopeAllows(scope, "read_items", { space: { ...space, id: "sp2" }, bundleId: "b1" })).toBe(false);
  });

  it("runWithTokenAuth exposes the auth to the wrapped function only", async () => {
    const auth = { userId: "u1", grantId: "g1", scope: { role: "member" } as TokenScope };
    const { currentTokenAuth } = await import("../../src/core/authScope.js");
    expect(currentTokenAuth()).toBeUndefined();
    const seen = runWithTokenAuth(auth, () => currentTokenAuth());
    expect(seen).toBe(auth);
    expect(currentTokenAuth()).toBeUndefined();
  });
});

describe("verifyPkceS256", () => {
  it("accepts the matching verifier and rejects others", () => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256(verifier + "x", challenge)).toBe(false);
    expect(verifyPkceS256("", challenge)).toBe(false);
  });
});
