/** OAuth flow helpers for integration tests: client registration, the
 * key-authenticated consent post, and the code + PKCE exchange. */
import { createHash, randomBytes } from "node:crypto";
import { expect } from "vitest";

export const REDIRECT_URI = "https://app.example/callback";

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function registerClient(baseUrl: string, name = "Test App", redirectUris = [REDIRECT_URI]) {
  const res = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: redirectUris }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

export interface AuthorizeInput {
  clientId: string;
  key: string;
  challenge: string;
  scope?: string;
  redirectUri?: string;
  decision?: string;
  state?: string;
  /** The consent screen's role picker; omitted = whatever the request preselected. */
  role?: string;
}

export async function postAuthorize(baseUrl: string, input: AuthorizeInput): Promise<Response> {
  const form = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri ?? REDIRECT_URI,
    scope: input.scope ?? "",
    state: input.state ?? "st4te",
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    access_key: input.key,
    decision: input.decision ?? "approve",
    ...(input.role !== undefined ? { role: input.role } : {}),
  });
  return fetch(`${baseUrl}/oauth/authorize`, { method: "POST", body: form, redirect: "manual" });
}

export async function tokenRequest(baseUrl: string, params: Record<string, string>) {
  const res = await fetch(`${baseUrl}/oauth/token`, { method: "POST", body: new URLSearchParams(params) });
  return { status: res.status, body: (await res.json()) as any };
}

/** Runs the whole code+PKCE flow and returns the first token pair. */
export async function connectApp(baseUrl: string, key: string, scope = "") {
  const client = await registerClient(baseUrl);
  const { verifier, challenge } = pkce();
  const authz = await postAuthorize(baseUrl, { clientId: client.body.client_id, key, challenge, scope });
  expect(authz.status).toBe(302);
  const redirect = new URL(authz.headers.get("location")!);
  const code = redirect.searchParams.get("code")!;
  expect(code).toBeTruthy();
  const token = await tokenRequest(baseUrl, {
    grant_type: "authorization_code",
    client_id: client.body.client_id,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  });
  expect(token.status).toBe(200);
  const body = token.body as { access_token: string; refresh_token: string; scope: string };
  return { clientId: client.body.client_id as string, ...body };
}
