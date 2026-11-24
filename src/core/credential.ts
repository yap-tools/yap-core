/**
 * The credential lane: one decision, made once — what does a presented
 * bearer secret mean? Exactly one of three lanes: a user access key
 * (identity: the user's full authority, or a fixed role mask of it when the
 * key is scoped), an OAuth access token (delegated identity, scope-clamped),
 * or the environment-level sysadmin key (operator credential, never a content
 * principal). Both transports resolve through here and keep only their own
 * wording and dressing per outcome. Two things deliberately stay with the
 * transports: credential *extraction* (REST reads the Authorization header;
 * MCP adds the ?key= fallback) and the *timing* of the scope context (REST
 * per request, MCP per session). `scopeOf` gives the context to run under, for a
 * token and for a scoped key alike; an unscoped key has none and runs as
 * before.
 *
 * Where key login is switched off (keyLogin.ts), a user key resolves to
 * `key-refused` with the reason, never to `invalid-key`, so each transport can
 * tell the caller to connect through a provider instead.
 */
import { OAUTH_ACCESS_TOKEN_PREFIX, constantTimeEqual } from "../crypto.js";
import type { YapConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { KeyAuth, ScopedAuth, TokenAuth } from "./authScope.js";
import { apiKeyRefusedMessage, type KeyRefusal } from "./keyLogin.js";
import { authenticateKey } from "./keys.js";
import { authenticateToken } from "./oauth.js";

export type CredentialOutcome =
  | { kind: "missing" }
  | { kind: "sysadmin" }
  | {
      kind: "user";
      userId: string;
      /** Present exactly when the key is scoped: the context to run under. */
      keyAuth?: KeyAuth;
    }
  | { kind: "token"; userId: string; tokenAuth: TokenAuth }
  | { kind: "invalid-token" }
  | { kind: "invalid-key" }
  | {
      kind: "key-refused";
      reason: KeyRefusal;
      /** The words for an API caller, from the instance's providers. */
      message: string;
    };

/** Extracts the bearer secret from an Authorization header value. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

export async function resolveCredential(
  db: Db,
  config: Pick<YapConfig, "sysadminKey" | "keyLogin" | "oidc">,
  presented: string | null | undefined,
): Promise<CredentialOutcome> {
  if (!presented) return { kind: "missing" };
  if (constantTimeEqual(presented, config.sysadminKey)) return { kind: "sysadmin" };
  if (presented.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
    const tokenAuth = await authenticateToken(db, config, presented);
    return tokenAuth ? { kind: "token", userId: tokenAuth.userId, tokenAuth } : { kind: "invalid-token" };
  }
  const key = await authenticateKey(db, config, presented);
  if (!key.ok) {
    if (key.reason === "invalid") return { kind: "invalid-key" };
    return { kind: "key-refused", reason: key.reason, message: apiKeyRefusedMessage(config, key.reason) };
  }
  const { userId, keyId, scope } = key;
  return scope ? { kind: "user", userId, keyAuth: { source: "key", userId, keyId, scope } } : { kind: "user", userId };
}

/** The scope a resolved credential runs under, if it is narrowed at all. */
export function scopeOf(outcome: CredentialOutcome): ScopedAuth | undefined {
  if (outcome.kind === "token") return outcome.tokenAuth;
  if (outcome.kind === "user") return outcome.keyAuth;
  return undefined;
}
