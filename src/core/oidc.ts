/**
 * OpenID Connect login for the pages Core serves itself: the OAuth consent
 * screen, the connected-apps page, a service's approve page and its secret
 * form. Core is a plain OIDC client (authorization code flow with PKCE) of
 * every provider the operator configures; it holds no passwords, sends no
 * email and keeps no browser session.
 *
 * A login only identifies the person. The round trip:
 *
 * 1. `startLogin`: a page sends the person to their provider. Core stores the
 *    pending request server-side as an `oidc_transactions` row (what page it
 *    was, what it was about, a PKCE verifier and a nonce, both encrypted) and
 *    carries a `state` of its own through the redirect.
 * 2. `finishLogin`: the provider sends the browser back to
 *    `<YAP_BASE_URL>/oidc/<provider>/callback`. The callback claims the row
 *    once, exchanges the code, verifies the ID token and finds the Yap user
 *    for it, then mints a one-off login ticket. The caller renders the page
 *    the login was for, with the ticket in it. The callback never decides
 *    anything by itself: with no session, nothing ties a callback to the
 *    browser that started the flow, so the person makes the decision on the
 *    page shown after it, with their name on it.
 * 3. `spendLoginTicket`: the page posts the decision with the ticket, which is
 *    good once, for that page and what it was about, for a few minutes.
 *
 * Who a login is: the provider's claim mapping (`mapClaims`, from its preset
 * and env overrides) reads the ID token into a subject, an email it vouches
 * for, a name and whether it vouches for the email's domain. A returning
 * person is recognised by the provider's issuer and that subject
 * (`user_identities`), never by email. A first login links to an invite (a
 * user the operator created with that email and no identity yet) when the
 * mapping yields an email (verified, or trusted for that provider), or, when
 * sign-up is on and the address is on the allowlist, creates a user with a
 * personal space and no access key. Either way the user is then set to provider login only
 * (keyLogin.ts): a claimed invite's keys stop working and the OAuth grants
 * they authorized are deleted. Anyone else is turned away.
 *
 * Other login methods (GitHub OAuth, SAML, passkeys) would sit beside this one
 * and hand the same thing back: a verified Yap user. Consent, token issuance
 * and capability checks stay shared and never see which method was used,
 * except that a provider-login grant lives at most `grantMaxDays`.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { and, eq, isNull, gt, lt, notExists } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";

import type { OidcProviderConfig, YapConfig } from "../config.js";
import { decryptSecret, encryptSecret, generateSecret, hashKey } from "../crypto.js";
import { isUniqueViolation, type Db } from "../db/index.js";
import { createUser, findUserByEmail, revokeKeyBackedGrants, USERS_EMAIL_INDEX } from "./users.js";
import { newId, nowIso } from "./util.js";

/** The pages a provider login can be for. */
export type LoginPurpose = "consent" | "connections" | "service-approve" | "secret-input";

export const LOGIN_PURPOSES: readonly LoginPurpose[] = ["consent", "connections", "service-approve", "secret-input"];

/** How long the round trip to the provider may take, and how long the page after it stays usable. */
export const LOGIN_TTL_SECONDS = 600;

/** A login that did not end in a person, with words for them. */
export class OidcLoginError extends Error {}

/**
 * What a page offers to log in with: the providers, and whether it shows an
 * access-key field at all. `keyLogin` is false only where key login is off for
 * the whole instance; a page cannot know who someone is before they log in,
 * so a provider-login-only user still sees the field elsewhere and is refused
 * when they use it.
 */
export interface LoginOptions {
  providers: { id: string; label: string }[];
  keyLogin: boolean;
}

export function loginOptions(config: YapConfig): LoginOptions {
  return {
    providers: config.oidc.providers.map((p) => ({ id: p.name, label: p.label })),
    keyLogin: config.keyLogin,
  };
}

export function findProvider(config: YapConfig, name: string): OidcProviderConfig | null {
  return config.oidc.providers.find((p) => p.name === name) ?? null;
}

export function callbackUrl(config: YapConfig, provider: OidcProviderConfig): string {
  return `${config.baseUrl}/oidc/${provider.name}/callback`;
}

/**
 * The context a login is bound to, as stored and compared: canonical JSON
 * with sorted keys, so the page that spends a ticket must be about exactly
 * what the page that started the login was about.
 */
export function canonicalContext(context: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(context).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

// ---- Discovery --------------------------------------------------------------

interface ProviderMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwks: ReturnType<typeof createRemoteJWKSet>;
  algorithms: string[];
  basicAuth: boolean;
}

/** Asymmetric signatures only: an ID token signed with the client secret (HS*) or not at all is refused. */
const ASYMMETRIC_ALGS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA", "Ed25519"];
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

const discoveryCache = new Map<string, { at: number; meta: ProviderMetadata }>();

function secureOrLoopback(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** The provider's discovery document, checked and cached for an hour. */
async function providerMetadata(provider: OidcProviderConfig): Promise<ProviderMetadata> {
  const cached = discoveryCache.get(provider.issuer);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.meta;
  const url = `${provider.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  let doc: Record<string, unknown>;
  try {
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    doc = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    throw new OidcLoginError(`${provider.label} could not be reached (${(err as Error).message}). Try again later.`);
  }
  // OIDC Discovery §4.3: the issuer in the document must be the one configured, exactly.
  if (doc.issuer !== provider.issuer) {
    throw new OidcLoginError(`${provider.label} is misconfigured: its discovery document names another issuer.`);
  }
  for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    if (!secureOrLoopback(doc[field])) {
      throw new OidcLoginError(`${provider.label} is misconfigured: its ${field} is missing or not https.`);
    }
  }
  const advertised = Array.isArray(doc.id_token_signing_alg_values_supported)
    ? doc.id_token_signing_alg_values_supported.filter((a): a is string => typeof a === "string")
    : ["RS256"];
  const algorithms = advertised.filter((a) => ASYMMETRIC_ALGS.includes(a));
  const methods = Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported : [];
  const meta: ProviderMetadata = {
    authorizationEndpoint: doc.authorization_endpoint as string,
    tokenEndpoint: doc.token_endpoint as string,
    jwks: createRemoteJWKSet(new URL(doc.jwks_uri as string), { timeoutDuration: FETCH_TIMEOUT_MS }),
    algorithms: algorithms.length > 0 ? algorithms : ["RS256"],
    // client_secret_basic is the default (OIDC Core §9); _post only when that is all the provider takes.
    basicAuth: methods.length === 0 || methods.includes("client_secret_basic") || !methods.includes("client_secret_post"),
  };
  discoveryCache.set(provider.issuer, { at: Date.now(), meta });
  return meta;
}

// ---- 1. Start -----------------------------------------------------------------

function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/**
 * Stores the pending login and returns the provider URL to send the browser
 * to. The caller has already checked the page the login is for (its token,
 * or for consent the authorize request).
 */
export async function startLogin(
  env: { db: Db; config: YapConfig },
  provider: OidcProviderConfig,
  purpose: LoginPurpose,
  context: Record<string, string>,
): Promise<string> {
  const { db, config } = env;
  const meta = await providerMetadata(provider);
  const { oidcTransactions } = db.tables;
  // Opportunistic sweep: rows live for minutes.
  await db.client.delete(oidcTransactions).where(lt(oidcTransactions.expiresAt, nowIso()));

  const state = generateSecret();
  const nonce = generateSecret();
  const verifier = randomBytes(32).toString("base64url");
  await db.client.insert(oidcTransactions).values({
    id: newId(),
    stateHash: hashKey(state),
    provider: provider.name,
    purpose,
    context: canonicalContext(context),
    nonce: encryptSecret(nonce, config.masterKey),
    codeVerifier: encryptSecret(verifier, config.masterKey),
    createdAt: nowIso(),
    expiresAt: isoIn(LOGIN_TTL_SECONDS),
    calledBackAt: null,
    userId: null,
    ticketHash: null,
    ticketExpiresAt: null,
    usedAt: null,
  });

  const url = new URL(meta.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", callbackUrl(config, provider));
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// ---- 2. Callback ----------------------------------------------------------------

export interface FinishedLogin {
  purpose: LoginPurpose;
  context: Record<string, string>;
  user: { id: string; name: string };
  provider: { id: string; label: string };
  /** The one-off login ticket the page rendered next carries. */
  ticket: string;
}

/**
 * Handles the provider's redirect back: claims the pending login (once), turns
 * the code into a verified ID token, finds or creates the Yap user, and mints
 * a login ticket for the page the login was for. Throws OidcLoginError with
 * words for the person on any failure.
 */
export async function finishLogin(
  env: { db: Db; config: YapConfig },
  provider: OidcProviderConfig,
  query: Record<string, string>,
): Promise<FinishedLogin> {
  const { db, config } = env;
  const { oidcTransactions } = db.tables;
  const state = query.state ?? "";
  if (!state) throw new OidcLoginError("This login link is incomplete. Start again from the page you came from.");

  // Claim first: whatever happens next, a state is good for one callback.
  const now = nowIso();
  const claimed = await db.client
    .update(oidcTransactions)
    .set({ calledBackAt: now })
    .where(
      and(
        eq(oidcTransactions.stateHash, hashKey(state)),
        eq(oidcTransactions.provider, provider.name),
        isNull(oidcTransactions.calledBackAt),
        gt(oidcTransactions.expiresAt, now),
      ),
    )
    .returning();
  const tx = claimed[0];
  if (!tx) {
    throw new OidcLoginError("This login has expired or was already used. Start again from the page you came from.");
  }
  if (query.error) {
    throw new OidcLoginError(`${provider.label} did not log you in (${query.error}). Start again from the page you came from.`);
  }
  // RFC 9207: a provider that names itself in the response must name the one this login went to.
  if (query.iss !== undefined && query.iss !== provider.issuer) {
    throw new OidcLoginError("The login came back from a different provider than it was sent to.");
  }
  const code = query.code ?? "";
  if (!code) throw new OidcLoginError(`${provider.label} sent no authorization code. Start again.`);

  const meta = await providerMetadata(provider);
  const idToken = await exchangeCode(provider, meta, {
    code,
    redirectUri: callbackUrl(config, provider),
    verifier: decryptSecret(tx.codeVerifier, config.masterKey),
  });
  const claims = await verifyIdToken(provider, meta, idToken, decryptSecret(tx.nonce, config.masterKey));
  const user = await resolvePerson(db, config, provider, mapClaims(provider, claims));

  const ticket = generateSecret();
  const ticketExpiresAt = isoIn(LOGIN_TTL_SECONDS);
  // The row now lives as long as its ticket: the sweep on start goes by expires_at.
  await db.client
    .update(oidcTransactions)
    .set({ userId: user.id, ticketHash: hashKey(ticket), ticketExpiresAt, expiresAt: ticketExpiresAt })
    .where(eq(oidcTransactions.id, tx.id));
  return {
    purpose: tx.purpose as LoginPurpose,
    context: JSON.parse(tx.context) as Record<string, string>,
    user,
    provider: { id: provider.name, label: provider.label },
    ticket,
  };
}

async function exchangeCode(
  provider: OidcProviderConfig,
  meta: ProviderMetadata,
  input: { code: string; redirectUri: string; verifier: string },
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (meta.basicAuth) {
    const id = encodeURIComponent(provider.clientId);
    const secret = encodeURIComponent(provider.clientSecret);
    headers.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
  } else {
    body.set("client_id", provider.clientId);
    body.set("client_secret", provider.clientSecret);
  }
  let json: Record<string, unknown>;
  try {
    const res = await fetch(meta.tokenEndpoint, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : `HTTP ${res.status}`);
  } catch (err) {
    throw new OidcLoginError(`${provider.label} refused the login (${(err as Error).message}). Start again.`);
  }
  if (typeof json.id_token !== "string") throw new OidcLoginError(`${provider.label} sent no ID token.`);
  return json.id_token;
}

/** OIDC Core §3.1.3.7: signature (JWKS), issuer, audience (and azp), expiry, issued-at, nonce. */
async function verifyIdToken(
  provider: OidcProviderConfig,
  meta: ProviderMetadata,
  idToken: string,
  nonce: string,
): Promise<JWTPayload> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, meta.jwks, {
      issuer: provider.issuer,
      audience: provider.clientId,
      algorithms: meta.algorithms,
      requiredClaims: ["sub", "iat", "exp"],
      clockTolerance: 60,
    }));
  } catch (err) {
    throw new OidcLoginError(`The ID token from ${provider.label} did not verify (${(err as Error).message}).`);
  }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if ((aud.length > 1 || payload.azp !== undefined) && payload.azp !== provider.clientId) {
    throw new OidcLoginError(`The ID token from ${provider.label} was issued to another party.`);
  }
  if (payload.nonce !== nonce) throw new OidcLoginError(`The ID token from ${provider.label} belongs to another login.`);
  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw new OidcLoginError(`The ID token from ${provider.label} names nobody.`);
  }
  return payload;
}

// ---- Who the login is -------------------------------------------------------------

/**
 * What a login says about the person, read from the ID token by the
 * provider's claim mapping (its preset plus env overrides, config.ts). This is
 * all `resolvePerson` sees: which claims a provider uses lives here only.
 */
export interface MappedLogin {
  /** Identifies a returning person, with the provider's issuer. */
  subject: string;
  /** The address the provider vouches for (lowercased), or null: then it cannot claim an invite or sign up. */
  email: string | null;
  /** The display name for a user a sign-up creates. */
  name: string;
  /** Whether an `@domain` allowlist entry may admit `email` (Google's `hd` names the domain; true without a domain claim). */
  domainVouched: boolean;
}

/**
 * Reads an ID token's claims through the provider's mapping. The email is the
 * first of `emailClaims` that holds an address; it counts only with
 * `email_verified: true` (a boolean), unless the provider is set to trust it.
 * (Config refuses any claim but `email` on an untrusted provider, since
 * `email_verified` speaks for `email` alone.)
 * Throws when the subject claim is missing, since then nobody can be recognised.
 */
export function mapClaims(provider: OidcProviderConfig, claims: Record<string, unknown>): MappedLogin {
  const map = provider.claims;
  const subject = claims[map.subjectClaim];
  if (typeof subject !== "string" || subject === "") {
    throw new OidcLoginError(`The ID token from ${provider.label} names nobody (no ${map.subjectClaim} claim).`);
  }
  let email: string | null = null;
  if (map.trustEmail || claims.email_verified === true) {
    for (const claim of map.emailClaims) {
      const value = claims[claim];
      if (typeof value !== "string") continue;
      const candidate = value.trim().toLowerCase();
      if (candidate.includes("@")) {
        email = candidate;
        break;
      }
    }
  }
  const rawName = typeof claims.name === "string" ? claims.name.trim() : "";
  const name = (rawName || email || "").slice(0, 200);
  let domainVouched = true;
  if (map.domainClaim !== null) {
    const vouched = claims[map.domainClaim];
    domainVouched =
      email !== null && typeof vouched === "string" && vouched.toLowerCase() === email.slice(email.lastIndexOf("@") + 1);
  }
  return { subject, email, name, domainVouched };
}

/**
 * Whether sign-up admits this address: an exact entry, or an `@domain` entry
 * when the login vouches for the domain (`MappedLogin.domainVouched`).
 */
export function signupAllows(allow: string[], email: string, domainVouched: boolean): boolean {
  if (allow.includes(email)) return true;
  const domain = email.slice(email.lastIndexOf("@") + 1);
  return allow.includes(`@${domain}`) && domainVouched;
}

async function linkedUser(db: Db, issuer: string, subject: string): Promise<{ id: string; name: string } | null> {
  const { users, userIdentities } = db.tables;
  const rows = await db.client
    .select({ id: users.id, name: users.name })
    .from(userIdentities)
    .innerJoin(users, eq(userIdentities.userId, users.id))
    .where(and(eq(userIdentities.issuer, issuer), eq(userIdentities.subject, subject)));
  return rows[0] ?? null;
}

const NO_ACCOUNT =
  "There is no Yap account for this login. Ask the operator of this Yap for an invitation, then log in again.";

const EMAIL_IN_USE =
  "This email address already belongs to a Yap account that logs in another way. Log in the way you did before, or ask the operator.";

async function resolvePerson(
  db: Db,
  config: YapConfig,
  provider: OidcProviderConfig,
  login: MappedLogin,
): Promise<{ id: string; name: string }> {
  const issuer = provider.issuer;
  const { subject, email } = login;
  const known = await linkedUser(db, issuer, subject);
  if (known) return known;

  if (!email) throw new OidcLoginError(NO_ACCOUNT);
  const { users, userIdentities } = db.tables;

  // An invite: a user the operator created with this email and no identity yet.
  const invites = await db.client
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(
      and(
        eq(users.email, email),
        notExists(db.client.select({ id: userIdentities.id }).from(userIdentities).where(eq(userIdentities.userId, users.id))),
      ),
    );
  // Email is unique, so at most one user can match; the branch below stays as
  // a guard should that ever stop holding.
  if (invites.length > 1) {
    throw new OidcLoginError("Several Yap accounts are waiting for this email address. Ask the operator to sort it out.");
  }
  if (invites.length === 1) {
    const invite = invites[0]!;
    await claimInvite(db, invite.id, issuer, subject, email);
    return invite;
  }

  if (!config.oidc.signup || !signupAllows(config.oidc.allow, email, login.domainVouched)) throw new OidcLoginError(NO_ACCOUNT);
  // Email is unique, so sign-up cannot make a second account with an address
  // another user has (one who logs in another way, since no invite matched),
  // unless a concurrent first login of this same person just made it.
  if (await findUserByEmail(db, email)) {
    const winner = await linkedUser(db, issuer, subject);
    if (winner) return winner;
    throw new OidcLoginError(EMAIL_IN_USE);
  }
  // Created without identity or email, so no other login can find it; both
  // are then published in one transaction, so a login never sees a linked
  // user that this sign-up could still take back.
  const created = await createUser(
    db,
    config,
    { name: login.name, providerLoginOnly: true },
    { initialKey: false },
  );
  try {
    await db.transaction(function* (tx) {
      yield tx.insert(userIdentities).values({ id: newId(), userId: created.user.id, issuer, subject, createdAt: nowIso() });
      yield tx.update(users).set({ email }).where(eq(users.id, created.user.id));
    });
  } catch (err) {
    // Nothing was published, so this user goes. A concurrent first login of
    // the same person won the identity: theirs stands. Or another user took
    // the address meanwhile.
    await db.client.delete(users).where(eq(users.id, created.user.id));
    const winner = await linkedUser(db, issuer, subject);
    if (winner) return winner;
    if (isUniqueViolation(err, USERS_EMAIL_INDEX)) throw new OidcLoginError(EMAIL_IN_USE);
    throw err;
  }
  return { id: created.user.id, name: created.user.name };
}

/**
 * Links an identity to an invite, once, and sets the user to provider login
 * only, deleting the OAuth grants their keys authorized, in one transaction.
 * The update locks the user row first and only matches while the user still
 * carries this email, so an invite the operator withdrew or changed meanwhile
 * is not claimed, and of two different logins claiming the same invite at
 * once, the second waits for the first and then finds it claimed (and rolls
 * back its flag with the rest).
 */
async function claimInvite(db: Db, userId: string, issuer: string, subject: string, email: string): Promise<void> {
  const { users, userIdentities } = db.tables;
  await db.transaction(function* (tx) {
    const still: unknown[] = yield tx
      .update(users)
      .set({ email, providerLoginOnly: 1 })
      .where(and(eq(users.id, userId), eq(users.email, email)))
      .returning({ id: users.id });
    if (still.length === 0) throw new OidcLoginError(NO_ACCOUNT);
    const linked: unknown[] = yield tx.select({ id: userIdentities.id }).from(userIdentities).where(eq(userIdentities.userId, userId));
    if (linked.length > 0) throw new OidcLoginError("This invitation was just claimed by another login.");
    yield tx.insert(userIdentities).values({ id: newId(), userId, issuer, subject, createdAt: nowIso() });
    yield* revokeKeyBackedGrants(tx, db.tables, userId);
  });
}

// ---- 3. The decision ------------------------------------------------------------

/**
 * Spends a login ticket on the decision it was minted for: once, before it
 * expires, for the same page and the same context. Returns the person and the
 * provider they logged in with, or null.
 */
export async function spendLoginTicket(
  db: Db,
  ticket: string,
  purpose: LoginPurpose,
  context: Record<string, string>,
): Promise<{ userId: string; provider: string } | null> {
  if (!ticket) return null;
  const { oidcTransactions } = db.tables;
  const now = nowIso();
  const spent = await db.client
    .update(oidcTransactions)
    .set({ usedAt: now })
    .where(
      and(
        eq(oidcTransactions.ticketHash, hashKey(ticket)),
        eq(oidcTransactions.purpose, purpose),
        eq(oidcTransactions.context, canonicalContext(context)),
        isNull(oidcTransactions.usedAt),
        gt(oidcTransactions.ticketExpiresAt, now),
      ),
    )
    .returning({ userId: oidcTransactions.userId, provider: oidcTransactions.provider });
  const row = spent[0];
  if (!row || !row.userId) return null;
  return { userId: row.userId, provider: row.provider };
}
