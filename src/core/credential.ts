/**
 * The credential lane: one decision, made once — what does a presented
 * bearer secret mean? Exactly one of three lanes: a user access key
 * (identity, full authority), an OAuth access token (delegated identity,
 * scope-clamped), or the environment-level sysadmin key (operator
 * credential, never a content principal). Both transports resolve through
 * here and keep only their own wording and dressing per outcome. Two things
 * deliberately stay with the transports: credential *extraction* (REST reads
 * the Authorization header; MCP adds the ?key= fallback) and the *timing* of
 * the token scope context (REST per request, MCP per session).
 */
import { OAUTH_ACCESS_TOKEN_PREFIX, constantTimeEqual } from "../crypto.js";
import type { Db } from "../db/index.js";
import type { TokenAuth } from "./authScope.js";
import { authenticateKey } from "./keys.js";
import { authenticateToken } from "./oauth.js";

export type CredentialOutcome =
  | { kind: "missing" }
  | { kind: "sysadmin" }
  | { kind: "user"; userId: string }
  | { kind: "token"; userId: string; tokenAuth: TokenAuth }
  | { kind: "invalid-token" }
  | { kind: "invalid-key" };

/** Extracts the bearer secret from an Authorization header value. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

export async function resolveCredential(
  db: Db,
  config: { sysadminKey: string },
  presented: string | null | undefined,
): Promise<CredentialOutcome> {
  if (!presented) return { kind: "missing" };
  if (constantTimeEqual(presented, config.sysadminKey)) return { kind: "sysadmin" };
  if (presented.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
    const tokenAuth = await authenticateToken(db, presented);
    return tokenAuth ? { kind: "token", userId: tokenAuth.userId, tokenAuth } : { kind: "invalid-token" };
  }
  const userId = await authenticateKey(db, presented);
  return userId ? { kind: "user", userId } : { kind: "invalid-key" };
}
