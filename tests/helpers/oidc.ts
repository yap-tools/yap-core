/**
 * A fake OpenID Connect provider for integration tests: discovery, JWKS, an
 * authorize endpoint that logs in whoever the test says is next, and a token
 * endpoint that checks the client secret, the redirect URI and PKCE before it
 * signs an ID token. `tamper` bends the next ID token or response, so tests
 * can show each check refuses it.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

import { getFreePort } from "./app.js";

export interface FakeLogin {
  sub: string;
  email?: string;
  email_verified?: unknown;
  name?: string;
  hd?: string;
}

export interface Tamper {
  aud?: string | string[];
  azp?: string;
  iss?: string;
  nonce?: string;
  expired?: boolean;
  /** Sign with a key the JWKS does not hold. */
  foreignKey?: boolean;
  /** The authorization response names another issuer (RFC 9207). */
  responseIss?: string;
}

export interface FakeProvider {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Who the next authorize request logs in. */
  next: FakeLogin;
  tamper: Tamper;
  /** Token requests that reached the provider, for asserting what Core sent. */
  tokenRequests: URLSearchParams[];
  /** Env for one provider named `name`. */
  env(name?: string, extra?: Record<string, string>): Record<string, string>;
  close(): Promise<void>;
}

export async function startFakeProvider(): Promise<FakeProvider> {
  const port = await getFreePort();
  const issuer = `http://127.0.0.1:${port}`;
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const foreign = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { login: FakeLogin; nonce: string; redirectUri: string; challenge: string; clientId: string }>();

  const provider: FakeProvider = {
    issuer,
    clientId: "core-client",
    clientSecret: "core-secret-" + randomBytes(4).toString("hex"),
    next: { sub: "sub-1", email: "ada@example.com", email_verified: true, name: "Ada" },
    tamper: {},
    tokenRequests: [],
    env(name = "test", extra = {}) {
      const upper = name.toUpperCase();
      return {
        YAP_OIDC_PROVIDERS: name,
        [`YAP_OIDC_${upper}_ISSUER`]: issuer,
        [`YAP_OIDC_${upper}_CLIENT_ID`]: provider.clientId,
        [`YAP_OIDC_${upper}_CLIENT_SECRET`]: provider.clientSecret,
        [`YAP_OIDC_${upper}_LABEL`]: "TestID",
        ...extra,
      };
    },
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const json = (status: number, body: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const q = url.searchParams;
      if (q.get("client_id") !== provider.clientId || q.get("response_type") !== "code") return json(400, { error: "bad" });
      const code = randomBytes(12).toString("hex");
      codes.set(code, {
        login: { ...provider.next },
        nonce: q.get("nonce") ?? "",
        redirectUri: q.get("redirect_uri") ?? "",
        challenge: q.get("code_challenge") ?? "",
        clientId: q.get("client_id") ?? "",
      });
      const back = new URL(q.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state") ?? "");
      back.searchParams.set("iss", provider.tamper.responseIss ?? issuer);
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", async () => {
        const form = new URLSearchParams(raw);
        provider.tokenRequests.push(form);
        const basic = Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString("base64");
        if (req.headers.authorization !== `Basic ${basic}`) return json(401, { error: "invalid_client" });
        const entry = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        if (!entry || entry.redirectUri !== form.get("redirect_uri")) return json(400, { error: "invalid_grant" });
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (challenge !== entry.challenge) return json(400, { error: "invalid_grant" });
        const t = provider.tamper;
        const now = Math.floor(Date.now() / 1000);
        const claims: Record<string, unknown> = { ...entry.login, nonce: t.nonce ?? entry.nonce };
        if (t.azp !== undefined) claims.azp = t.azp;
        const idToken = await new SignJWT(claims)
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .setIssuer(t.iss ?? issuer)
          .setAudience(t.aud ?? entry.clientId)
          .setSubject(entry.login.sub)
          .setIssuedAt(t.expired ? now - 7200 : now)
          .setExpirationTime(t.expired ? now - 3600 : now + 300)
          .sign(t.foreignKey ? foreign.privateKey : privateKey);
        json(200, { access_token: "provider-at", token_type: "Bearer", id_token: idToken });
      });
      return;
    }
    json(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return provider;
}

/**
 * Follows a provider login the way a browser does: from Core's start
 * response through the provider back to Core's callback. Returns the
 * callback's response (the page rendered after the login) and its HTML.
 */
export async function followLogin(start: Response): Promise<{ res: Response; html: string; callbackUrl: string }> {
  if (start.status !== 302) throw new Error(`start answered ${start.status}: ${await start.text()}`);
  const atProvider = await fetch(start.headers.get("location")!, { redirect: "manual" });
  if (atProvider.status !== 302) throw new Error(`provider answered ${atProvider.status}: ${await atProvider.text()}`);
  const callbackUrl = atProvider.headers.get("location")!;
  const res = await fetch(callbackUrl, { redirect: "manual" });
  return { res, html: await res.text(), callbackUrl };
}

/** The login ticket in a page rendered after a provider login (a hidden field, or the widget's data). */
export function ticketIn(html: string): string {
  const field = /name="login_ticket" value="([^"]+)"/.exec(html);
  if (field) return field[1]!;
  const data = /"ticket":"([^"]+)"/.exec(html);
  if (data) return data[1]!;
  throw new Error("no login ticket in the page");
}
