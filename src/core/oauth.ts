/**
 * OAuth 2.1 authorization-server core. Each instance is its own complete
 * authority: dynamic client registration (public clients, PKCE mandatory),
 * authorization codes minted at the consent screen against an access key,
 * opaque hashed tokens, rotating refresh tokens with reuse detection, and
 * per-client grants ("connected apps") bound to the authorizing key so that
 * revoking the key kills every delegation made with it.
 *
 * A token is never more powerful than its key: authorization is always
 * `live grants ∧ scope mask ∧ resource restriction` (see capabilities.ts),
 * so role changes and grant edits apply to outstanding tokens immediately.
 */
import { and, eq, lt } from "drizzle-orm";

import type { YapConfig } from "../config.js";
import {
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  generateSecret,
  hashKey,
  verifyPkceS256,
} from "../crypto.js";
import type { Db } from "../db/index.js";
import { assertCanManageCredentials, TOKEN_ROLES, type TokenAuth, type TokenScope } from "./authScope.js";
import { notFound } from "./errors.js";
import { newId, nowIso } from "./util.js";

/** RFC 6749-shaped error; the OAuth endpoints format it per the RFC instead
 * of Yap's { error: { code, message } } envelope. */
export class OAuthError extends Error {
  constructor(
    public code:
      | "invalid_request"
      | "invalid_client"
      | "invalid_grant"
      | "invalid_scope"
      | "unauthorized_client"
      | "unsupported_grant_type",
    message: string,
  ) {
    super(message);
  }
}

// ---- Scope wire format ------------------------------------------------------

/**
 * Scope strings are space-delimited entries: `role:<admin|member|read-only>`,
 * `space:<id>`, `bundle:<id>`. Unknown entries are ignored (RFC 6749 §3.3
 * allows the server to narrow). Anything but exactly one requested role —
 * none, or several (clients commonly request every advertised scope) —
 * resolves to `member`: content work is possible, credential/role/space
 * management is not. The consent screen lets the user pick a different role
 * either way; the granted scope is echoed in the token response per §3.3.
 */
export function parseScopeParam(raw: string | undefined | null): TokenScope {
  const scope: TokenScope = { role: "member" };
  const roles: TokenScope["role"][] = [];
  const spaces: string[] = [];
  const bundles: string[] = [];
  for (const entry of (raw ?? "").split(/\s+/).filter(Boolean)) {
    if (entry.startsWith("role:")) {
      const role = entry.slice("role:".length);
      if ((TOKEN_ROLES as readonly string[]).includes(role)) roles.push(role as TokenScope["role"]);
    } else if (entry.startsWith("space:")) {
      spaces.push(entry.slice("space:".length));
    } else if (entry.startsWith("bundle:")) {
      bundles.push(entry.slice("bundle:".length));
    }
  }
  if (roles.length === 1) scope.role = roles[0]!;
  if (spaces.length > 0) scope.spaces = spaces;
  if (bundles.length > 0) scope.bundles = bundles;
  return scope;
}

export function formatScope(scope: TokenScope): string {
  return [
    `role:${scope.role}`,
    ...(scope.spaces ?? []).map((id) => `space:${id}`),
    ...(scope.bundles ?? []).map((id) => `bundle:${id}`),
  ].join(" ");
}

// ---- Clients ----------------------------------------------------------------

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  createdAt: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname);
}

/** http is only acceptable on loopback (native-app callbacks, RFC 8252);
 * anything else needs https or a private-use scheme. */
function validRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "http:") return isLoopback(url);
  return url.protocol.length > 1; // https: or a private-use scheme
}

/**
 * RFC 8252 §7.3: loopback http redirects match on everything but the port —
 * native clients bind whatever local port is free. All other URIs match
 * exactly.
 */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  let a: URL, b: URL;
  try {
    a = new URL(registered);
    b = new URL(presented);
  } catch {
    return false;
  }
  if (a.protocol !== "http:" || !isLoopback(a) || !isLoopback(b)) return false;
  return b.protocol === "http:" && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

export async function registerClient(
  db: Db,
  input: { clientName?: unknown; redirectUris: unknown },
): Promise<OAuthClient> {
  const uris = input.redirectUris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) {
    throw new OAuthError("invalid_request", "redirect_uris must be an array of 1-10 URIs");
  }
  for (const uri of uris) {
    if (typeof uri !== "string" || !validRedirectUri(uri)) {
      throw new OAuthError(
        "invalid_request",
        `invalid redirect_uri ${JSON.stringify(uri)}: must be https, a private-use scheme, or http on loopback`,
      );
    }
  }
  const name = typeof input.clientName === "string" ? input.clientName.slice(0, 200) : "";
  const { oauthClients } = db.tables;
  const client: OAuthClient = { id: newId(), name, redirectUris: uris as string[], createdAt: nowIso() };
  await db.client.insert(oauthClients).values({
    id: client.id,
    name: client.name,
    redirectUris: JSON.stringify(client.redirectUris),
    createdAt: client.createdAt,
  });
  return client;
}

export async function getClient(db: Db, clientId: string): Promise<OAuthClient | null> {
  const { oauthClients } = db.tables;
  const rows = await db.client.select().from(oauthClients).where(eq(oauthClients.id, clientId));
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, name: row.name, redirectUris: JSON.parse(row.redirectUris), createdAt: row.createdAt };
}

// ---- Authorization codes ----------------------------------------------------

function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function isExpired(iso: string): boolean {
  return new Date(iso).getTime() <= Date.now();
}

export async function mintAuthCode(
  db: Db,
  config: YapConfig,
  input: {
    clientId: string;
    userId: string;
    keyId: string;
    scope: TokenScope;
    codeChallenge: string;
    redirectUri: string;
  },
): Promise<string> {
  const { oauthCodes } = db.tables;
  // Opportunistic cleanup: codes live for seconds, so sweep on mint.
  await db.client.delete(oauthCodes).where(lt(oauthCodes.expiresAt, nowIso()));
  const code = generateSecret();
  await db.client.insert(oauthCodes).values({
    id: newId(),
    codeHash: hashKey(code),
    clientId: input.clientId,
    userId: input.userId,
    keyId: input.keyId,
    scope: JSON.stringify(input.scope),
    codeChallenge: input.codeChallenge,
    redirectUri: input.redirectUri,
    expiresAt: isoIn(config.oauthCodeTtlSeconds),
  });
  return code;
}

// ---- Tokens & grants --------------------------------------------------------

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function issueTokenPair(db: Db, config: YapConfig, grantId: string, scope: TokenScope): Promise<TokenResponse> {
  const { oauthTokens } = db.tables;
  const accessToken = generateSecret(OAUTH_ACCESS_TOKEN_PREFIX);
  const refreshToken = generateSecret(OAUTH_REFRESH_TOKEN_PREFIX);
  const now = nowIso();
  await db.client.insert(oauthTokens).values([
    {
      id: newId(),
      tokenHash: hashKey(accessToken),
      grantId,
      kind: "access",
      expiresAt: isoIn(config.oauthAccessTokenTtlSeconds),
      revokedAt: null,
    },
    {
      id: newId(),
      tokenHash: hashKey(refreshToken),
      grantId,
      kind: "refresh",
      expiresAt: isoIn(config.oauthRefreshTokenTtlSeconds),
      revokedAt: null,
    },
  ]);
  // Expired rows of this grant are dead weight — sweep while we're here.
  await db.client.delete(oauthTokens).where(and(eq(oauthTokens.grantId, grantId), lt(oauthTokens.expiresAt, now)));
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: config.oauthAccessTokenTtlSeconds,
    refresh_token: refreshToken,
    scope: formatScope(scope),
  };
}

/** Code → grant + first token pair. The code is single-use: consumed (deleted)
 * before validation results are surfaced, so a replay finds nothing. */
export async function exchangeAuthCode(
  db: Db,
  config: YapConfig,
  input: { code: string; codeVerifier: string; clientId: string; redirectUri: string },
): Promise<TokenResponse> {
  const { oauthCodes, oauthGrants } = db.tables;
  const rows = await db.client.select().from(oauthCodes).where(eq(oauthCodes.codeHash, hashKey(input.code)));
  const row = rows[0];
  if (!row) throw new OAuthError("invalid_grant", "unknown or already used authorization code");
  await db.client.delete(oauthCodes).where(eq(oauthCodes.id, row.id));
  if (isExpired(row.expiresAt)) throw new OAuthError("invalid_grant", "authorization code expired");
  if (row.clientId !== input.clientId) throw new OAuthError("invalid_grant", "code was issued to a different client");
  if (row.redirectUri !== input.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri mismatch");
  if (!input.codeVerifier || !verifyPkceS256(input.codeVerifier, row.codeChallenge)) {
    throw new OAuthError("invalid_grant", "PKCE verification failed");
  }

  const scope: TokenScope = JSON.parse(row.scope);
  const grantId = newId();
  const now = nowIso();
  await db.client.insert(oauthGrants).values({
    id: grantId,
    userId: row.userId,
    keyId: row.keyId,
    clientId: row.clientId,
    scope: row.scope,
    createdAt: now,
    lastUsedAt: now,
  });
  return issueTokenPair(db, config, grantId, scope);
}

/** Refresh rotation. A rotated (revoked) refresh token presented again is
 * treated as theft: the whole grant dies (OAuth 2.1 §4.3.1). */
export async function refreshTokens(
  db: Db,
  config: YapConfig,
  input: { refreshToken: string; clientId: string },
): Promise<TokenResponse> {
  const { oauthTokens, oauthGrants } = db.tables;
  const rows = await db.client
    .select({
      tokenId: oauthTokens.id,
      revokedAt: oauthTokens.revokedAt,
      expiresAt: oauthTokens.expiresAt,
      kind: oauthTokens.kind,
      grantId: oauthGrants.id,
      clientId: oauthGrants.clientId,
      scope: oauthGrants.scope,
    })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthTokens.grantId, oauthGrants.id))
    .where(eq(oauthTokens.tokenHash, hashKey(input.refreshToken)));
  const row = rows[0];
  if (!row || row.kind !== "refresh") throw new OAuthError("invalid_grant", "unknown refresh token");
  if (row.clientId !== input.clientId) throw new OAuthError("invalid_grant", "refresh token belongs to a different client");
  if (row.revokedAt) {
    await db.client.delete(oauthGrants).where(eq(oauthGrants.id, row.grantId));
    throw new OAuthError("invalid_grant", "refresh token reuse detected; the authorization has been revoked");
  }
  if (isExpired(row.expiresAt)) throw new OAuthError("invalid_grant", "refresh token expired");
  await db.client.update(oauthTokens).set({ revokedAt: nowIso() }).where(eq(oauthTokens.id, row.tokenId));
  return issueTokenPair(db, config, row.grantId, JSON.parse(row.scope));
}

/**
 * RFC 7009: always succeeds from the caller's view. Revoking a refresh token
 * tears down its whole grant (access tokens included); revoking an access
 * token kills that token only.
 */
export async function revokeToken(db: Db, presented: string): Promise<void> {
  const { oauthTokens, oauthGrants } = db.tables;
  const rows = await db.client.select().from(oauthTokens).where(eq(oauthTokens.tokenHash, hashKey(presented)));
  const row = rows[0];
  if (!row) return;
  if (row.kind === "refresh") {
    await db.client.delete(oauthGrants).where(eq(oauthGrants.id, row.grantId));
  } else {
    await db.client.update(oauthTokens).set({ revokedAt: nowIso() }).where(eq(oauthTokens.id, row.id));
  }
}

/** Resolves a presented access token to its delegation, or null. */
export async function authenticateToken(db: Db, presented: string): Promise<TokenAuth | null> {
  const { oauthTokens, oauthGrants } = db.tables;
  const rows = await db.client
    .select({
      kind: oauthTokens.kind,
      revokedAt: oauthTokens.revokedAt,
      expiresAt: oauthTokens.expiresAt,
      grantId: oauthGrants.id,
      userId: oauthGrants.userId,
      scope: oauthGrants.scope,
    })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthTokens.grantId, oauthGrants.id))
    .where(eq(oauthTokens.tokenHash, hashKey(presented)));
  const row = rows[0];
  if (!row || row.kind !== "access" || row.revokedAt || isExpired(row.expiresAt)) return null;
  await db.client.update(oauthGrants).set({ lastUsedAt: nowIso() }).where(eq(oauthGrants.id, row.grantId));
  return { userId: row.userId, grantId: row.grantId, scope: JSON.parse(row.scope) };
}

// ---- Grant management (the "connected apps" view) ---------------------------

export interface GrantInfo {
  id: string;
  client: { id: string; name: string };
  scope: string;
  createdAt: string;
  lastUsedAt: string;
}

export async function listUserGrants(db: Db, userId: string): Promise<GrantInfo[]> {
  assertCanManageCredentials();
  const { oauthGrants, oauthClients } = db.tables;
  const rows = await db.client
    .select({
      id: oauthGrants.id,
      clientId: oauthClients.id,
      clientName: oauthClients.name,
      scope: oauthGrants.scope,
      createdAt: oauthGrants.createdAt,
      lastUsedAt: oauthGrants.lastUsedAt,
    })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
    .where(eq(oauthGrants.userId, userId));
  return rows.map((r) => ({
    id: r.id,
    client: { id: r.clientId, name: r.clientName },
    scope: formatScope(JSON.parse(r.scope)),
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
  }));
}

/** Disconnects one client: the grant and all its tokens die; the authorizing
 * key and other clients are untouched. */
export async function revokeUserGrant(db: Db, userId: string, grantId: string): Promise<void> {
  assertCanManageCredentials();
  const { oauthGrants } = db.tables;
  const rows = await db.client
    .select({ id: oauthGrants.id })
    .from(oauthGrants)
    .where(and(eq(oauthGrants.id, grantId), eq(oauthGrants.userId, userId)));
  if (rows.length === 0) throw notFound("grant", grantId);
  await db.client.delete(oauthGrants).where(eq(oauthGrants.id, grantId));
}

/** Key revocation cascade: every delegation authorized with the key dies. */
export async function revokeGrantsForKey(db: Db, keyId: string): Promise<void> {
  const { oauthGrants } = db.tables;
  await db.client.delete(oauthGrants).where(eq(oauthGrants.keyId, keyId));
}
