/**
 * Turning the configured mail account into something a protocol can
 * authenticate with: a password, or an OAuth2 access token for SASL XOAUTH2.
 *
 * Basic auth is dead on Google Workspace and Microsoft 365, so the driver also
 * takes `oauth2: {client_id, client_secret, refresh_token, token_url}` and
 * trades the refresh token for an access token itself. That exchange is an
 * HTTPS POST, and it goes through `ctx.egress.fetch` like every other byte the
 * driver sends — the token endpoint is a destination the operator's egress
 * policy gets to vet, not an exception to it.
 *
 * Access tokens are cached in-module, keyed by the refresh grant that produced
 * them, until 60 s before the provider says they expire: a busy service would
 * otherwise hit the token endpoint on every run, and providers rate-limit that.
 * The cache is process-wide and survives across runs, which is the point; it
 * never holds the refresh token or client secret as values, only as part of a
 * key, and nothing reads the keys back out.
 *
 * Nothing secret reaches an error or the log: a failed refresh reports the
 * HTTP status and the provider's `error` code (a short enum like
 * `invalid_grant`), never `error_description` or the body, both of which
 * providers have been known to echo input into.
 */
import type { OAuth2Config } from "./config.js";
import { requireEgress, type MailCtx } from "./net.js";

const EXPIRY_MARGIN_MS = 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_EXPIRES_IN_S = 3600;

export type ResolvedAuth =
  | { kind: "password"; user: string; pass: string }
  | { kind: "xoauth2"; user: string; token: string }
  | null;

/** The credential fields of a mail config — what `resolveAuth` reads. */
export interface AuthConfig {
  user: string;
  pass?: string;
  oauth2?: OAuth2Config | null;
}

/**
 * What `readBody` can consume. The egress contract promises only `status` and
 * `text()`; a WHATWG/undici response also carries a `body` stream and
 * `arrayBuffer()`, and the stream is preferred because it can be cut off at
 * the cap instead of buffered whole first.
 */
export interface TokenResponse {
  status: number;
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer?(): Promise<ArrayBuffer>;
  text?(): Promise<string>;
}

/** key → { token, expiresAt } */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function clearTokenCache(): void {
  tokenCache.clear();
}

/** The SASL XOAUTH2 initial client response, base64-encoded. */
export function xoauth2Payload(user: string, token: string): string {
  return Buffer.from(`user=${user}\x01auth=Bearer ${token}\x01\x01`, "utf8").toString("base64");
}

/**
 * Resolves to `{kind: "password", user, pass}`, `{kind: "xoauth2", user,
 * token}`, or `null` when the config carries no credentials at all.
 */
export async function resolveAuth(ctx: MailCtx, config: AuthConfig): Promise<ResolvedAuth> {
  const { user, pass, oauth2 } = config;
  if (oauth2 !== undefined && oauth2 !== null) {
    if (typeof user !== "string" || user === "") throw new Error("user is required with oauth2");
    const token = await accessToken(ctx, assertOauth2(oauth2));
    return { kind: "xoauth2", user, token };
  }
  if (pass !== undefined) {
    if (typeof user !== "string" || user === "") throw new Error("user is required with pass");
    return { kind: "password", user, pass };
  }
  return null;
}

/** The config is normally validated at authoring time; this re-checks the
 * fields that decide where a secret is posted, in case a caller bypassed it. */
function assertOauth2(oauth2: OAuth2Config): OAuth2Config {
  if (typeof oauth2 !== "object" || Array.isArray(oauth2)) throw new Error("oauth2 must be an object");
  for (const field of ["client_id", "client_secret", "refresh_token", "token_url"] as const) {
    if (typeof oauth2[field] !== "string" || oauth2[field] === "") {
      throw new Error(`oauth2.${field} must be a non-empty string`);
    }
  }
  let url: URL;
  try {
    url = new URL(oauth2.token_url);
  } catch {
    throw new Error("oauth2.token_url must be a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("oauth2.token_url must be an https URL");
  return oauth2;
}

/**
 * The response body as UTF-8 text, refused past `cap` bytes. A token endpoint
 * answers in a few hundred bytes; anything larger is a misconfigured URL or a
 * hostile peer, and neither gets to fill memory. Reads the stream when there
 * is one (undici / WHATWG), else the buffer, else `text()`.
 */
export async function readBody(response: TokenResponse, cap: number): Promise<string> {
  const tooLarge = (): Error => new Error(`oauth2 token refresh failed: the response exceeded ${cap / 1024} KiB`);
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) throw tooLarge();
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  if (typeof response.arrayBuffer === "function") {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > cap) throw tooLarge();
    return Buffer.from(buffer).toString("utf8");
  }
  if (typeof response.text !== "function") throw new Error("oauth2 token refresh failed: the response had no body");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > cap) throw tooLarge();
  return text;
}

async function accessToken(ctx: MailCtx, oauth2: OAuth2Config): Promise<string> {
  const key = JSON.stringify([oauth2.token_url, oauth2.client_id, oauth2.refresh_token]);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    ctx.log("oauth2: using cached access token");
    return cached.token;
  }
  tokenCache.delete(key);

  ctx.log(`oauth2: refreshing access token at ${oauth2.token_url}`);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: oauth2.client_id,
    client_secret: oauth2.client_secret,
    refresh_token: oauth2.refresh_token,
  }).toString();
  const response: TokenResponse = await requireEgress(ctx).fetch(oauth2.token_url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: ctx.signal,
    redirect: "manual",
  });
  const text = await readBody(response, MAX_RESPONSE_BYTES);
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Reported below as a missing access_token; the body is never surfaced.
  }
  const record = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : null;
  if (response.status < 200 || response.status >= 300) {
    const code = typeof record?.error === "string" ? record.error.slice(0, 64) : undefined;
    const message = `oauth2 token refresh failed: HTTP ${response.status}${code ? ` (${code})` : ""}`;
    ctx.log(message);
    throw new Error(message);
  }
  const token = record?.access_token;
  if (typeof token !== "string" || token === "") {
    throw new Error("oauth2 token refresh failed: the response carried no access_token");
  }
  const expiresIn = Number.isFinite(Number(record?.expires_in)) ? Number(record?.expires_in) : DEFAULT_EXPIRES_IN_S;
  const expiresAt = Date.now() + expiresIn * 1000 - EXPIRY_MARGIN_MS;
  if (expiresAt > Date.now()) tokenCache.set(key, { token, expiresAt });
  ctx.log(`oauth2: access token obtained (expires in ${Math.round(expiresIn)} s)`);
  return token;
}
