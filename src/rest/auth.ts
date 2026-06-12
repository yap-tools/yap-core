/**
 * REST authentication. Bearer credentials: a user access key, an OAuth access
 * token (resolved by the route wrapper, which establishes the token's scope
 * context before the handler runs), or — on the endpoints marked sysadmin —
 * the environment-level sysadmin key. The sysadmin key is not a user and
 * holds no content capabilities.
 */
import type { Context } from "hono";

import type { YapConfig } from "../config.js";
import { constantTimeEqual } from "../crypto.js";
import type { Db } from "../db/index.js";
import { currentTokenAuth } from "../core/authScope.js";
import { unauthorized } from "../core/errors.js";
import { authenticateKey } from "../core/keys.js";

export function bearerFrom(c: Context): string | null {
  const header = c.req.header("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/** Resolves the request to a user id, rejecting missing keys and the sysadmin key. */
export async function requireUser(c: Context, db: Db, config: YapConfig): Promise<string> {
  // OAuth-token lane: the route wrapper already authenticated the token and
  // established its scope context — the delegated user is right there.
  const tokenAuth = currentTokenAuth();
  if (tokenAuth) return tokenAuth.userId;
  const key = bearerFrom(c);
  if (!key) throw unauthorized("bearer access key or access token required");
  if (constantTimeEqual(key, config.sysadminKey)) {
    throw unauthorized("the sysadmin key is not a user credential; use a user access key");
  }
  const userId = await authenticateKey(db, key);
  if (!userId) throw unauthorized("invalid or revoked access key");
  return userId;
}

export function requireSysadmin(c: Context, config: YapConfig): void {
  const key = bearerFrom(c);
  if (!key || !constantTimeEqual(key, config.sysadminKey)) {
    throw unauthorized("sysadmin key required");
  }
}
