/**
 * The OAuth 2.1 front door: RFC 8414/9728 discovery, RFC 7591 dynamic client
 * registration, the authorize screen (the one interactive page Core ships —
 * it authenticates by access key; Core has no passwords), the token endpoint
 * (authorization code + PKCE, rotating refresh), and RFC 7009 revocation.
 *
 * Error shapes: the /oauth/* endpoints speak RFC 6749 ({ error,
 * error_description }); the /v1 grant-management routes speak Yap's envelope.
 */
import type { Context } from "hono";

import type { ContentfulStatusCode } from "hono/utils/http-status";

import { constantTimeEqual } from "../crypto.js";
import { YapError } from "../core/errors.js";
import { authenticateKeyRow } from "../core/keys.js";
import * as oauth from "../core/oauth.js";
import type { YapServer } from "../server.js";

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---- Page chrome ------------------------------------------------------------
// Core ships exactly these UI widgets: the authorize screen, the connections
// page, and their error states. One shared shell keeps them consistent.

/** The full Yap lockup (from the brand styleguide): pill, mark, wordmark —
 * in currentColor so it themes with the page. */
const LOGO_SVG = `<svg width="90" height="24" viewBox="0 0 2262.93 605.65" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Yap">
  <path d="M1523.76,328.8h102.09l-36.15-97.56c-.89-2.4-2.4-6.78-4.51-13.1-2.11-6.32-4.14-12.88-6.1-19.64-1.96-6.79-3.54-11.97-4.74-15.59-1.51,6.03-3.09,12.12-4.74,18.29-1.65,6.18-3.32,11.82-4.96,16.93-1.67,5.12-3.1,9.48-4.3,13.1l-36.58,97.56ZM1951.48,276.85c6.63-9.63,9.94-22.27,9.94-37.93,0-20.78-6.61-36.28-19.87-46.52-13.24-10.23-34.17-15.35-62.78-15.35h-41.09v127.36h32.52c20.47,0,37.49-2.18,51.03-6.56,13.55-4.35,23.65-11.36,30.26-21M2003.43,237.1c0,13.26-2.19,25.98-6.56,38.17-4.36,12.2-11.52,23.12-21.45,32.75-9.94,9.64-23.18,17.24-39.75,22.81-16.57,5.58-36.89,8.36-60.96,8.36h-37.04v125.56h-40.65V142.26h85.36c42.16,0,72.86,8.28,92.13,24.83,19.27,16.57,28.92,39.91,28.92,70.01M1718.89,464.75h-42.01l-38.84-99.82h-127.83l-38.38,99.82h-41.11l126.03-323.85h36.57l125.57,323.85ZM1439.76,142.26l-107.5,197.38v125.1h-40.65v-123.31l-107.49-199.18h44.25l83.56,158.53,84.01-158.53h43.81ZM529.08,238.1l2.78,2.78-.35,11.79-3.82.7-1.39,1.39,2.78,2.78-2.78,2.77v2.78l-5.56,5.56,2.78,2.78-11.11,11.11,2.78,2.78-1.39,1.39h-2.78l-1.39,1.39,2.78,2.78-1.39,1.39-3.47.69-.7,3.47-1.39,1.39-2.78-2.77-1.39,1.38-.69,6.26-10.42,4.52-12.5-1.05-6.95-6.95v-13.89l5.56-5.55.69-3.47,4.17-1.39,3.47-6.25,5.56-8.34,3.82-6.94,2.43-8.33,2.09-20.85-5.56-5.55-.69-3.48-3.48-.69-8.33-8.33-26.4-6.26h-58.35l-33.34,4.87-44.44,11.47-55.56,21.53-12.5,1.73-2.78,2.78-2.78-2.78-9.03-3.48-2.43-7.64.35-5.55,1.38-4.17,12.51-12.5,6.94-1.73,19.45-8,6.95-1.39,5.56-5.55,18.06-4.51,47.22-13.55,33.34-5.2,29.17-1.76,2.78-2.78,2.78,2.78,2.78-2.78,45.83,6.95,13.9,3.47,5.55,2.08,11.12,5.56,4.16,1.39,15.29,15.28.69,3.47,4.17,1.39.69,3.48,5.56,5.55,2.78,19.45-2.78,2.78,2.78,2.78-2.78,2.78ZM225.91,392.28l8.34-2.78,2.78,2.78,2.77-2.78,34.74-1.73,16.67-2.44,41.66-11.11,22.23-8.33,6.95-1.39,5.55-5.56,2.78,2.78,1.39-1.39.69-3.47,3.48-.7,2.78-2.78,2.77,2.78,5.56-5.56,4.17,1.05,13.89.34,4.17,1.39,4.17,4.17,1.73,6.95-.34,5.55-1.39,4.17-9.73,9.72h-5.55l-5.56,5.56-6.95,1.39-91.68,27.79-15.28,1.38-2.78,2.78-2.77-2.78-2.78,2.78-44.46,2.78-2.78,2.78-2.77-2.78-26.4-1.73-11.11-2.44-16.67-5.88-5.56-2.44-12.5-6.95-15.29-15.28v-2.78l-5.55-5.55-1.39-9.73-2.78-8.33.35-8.34,1.04-4.17-2.78-2.78,2.78-2.77,1.39-9.73,3.12-8.33,1.05-4.17,2.77-2.78-2.77-2.78,8.33-8.33.7-6.26,3.47-.69,8.33-8.33h13.9l6.94,6.94v2.78l2.78,2.78-2.78,2.78,2.78,2.78-1.04,4.16-1.74,9.73-5.55,5.55v2.78l-5.56,5.56v25.01l12.5,12.5,4.17,1.39,11.11,5.22,11.12,2.77,18.06,1.73,2.78,2.78,2.77-2.78,2.78,2.78ZM2261.93,302.82c0-166.69-135.13-301.82-301.82-301.82H302.82C136.13,1,1,136.13,1,302.82s135.13,301.82,301.82,301.82h1657.29c166.69,0,301.82-135.13,301.82-301.82" fill="currentColor"/>
</svg>`;

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0;
         padding: 1rem 0; box-sizing: border-box;
         background: light-dark(#f6f6f4, #161618); color: light-dark(#1a1a1a, #ececec); }
  main { width: min(28rem, calc(100vw - 2rem)); background: light-dark(#fff, #1f1f23);
         border: 1px solid light-dark(#e3e3df, #2e2e33); border-radius: 12px; padding: 2rem; box-sizing: border-box; }
  .brand { display: flex; gap: .5rem; align-items: center; font-weight: 700; margin-bottom: 1.25rem; }
  h1 { font-size: 1.1rem; margin: 0 0 .75rem; }
  .client { font-weight: 600; }
  fieldset { border: 0; padding: 0; margin: 0; }
  legend, .keylabel { display: block; font-size: .85rem; font-weight: 600; margin: 1rem 0 .35rem; padding: 0; }
  .role, .connection { display: flex; gap: .6rem; align-items: baseline; padding: .55rem .75rem; border-radius: 8px;
          border: 1px solid light-dark(#e3e3df, #2e2e33); margin-bottom: .4rem; font-size: .85rem; }
  .role { cursor: pointer; }
  .role:has(input:checked) { border-color: light-dark(#1a1a1a, #ececec); background: light-dark(#f2f2ef, #26262b); }
  .connection { justify-content: space-between; align-items: center; gap: 1rem; }
  .connection .meta { min-width: 0; }
  .connection .meta code { font-size: .75rem; opacity: .7; word-break: break-all; }
  .connection .meta small { display: block; opacity: .6; }
  .restriction, .notice { font-size: .85rem; padding: .55rem .75rem; border-radius: 8px;
                 background: light-dark(#f2f2ef, #26262b); margin: .6rem 0 0; }
  .notice { margin: 0 0 .4rem; } /* same vertical rhythm as the connection cards below it */
  input[type="password"] { width: 100%; box-sizing: border-box; padding: .6rem .7rem; border-radius: 8px;
           border: 1px solid light-dark(#ccc, #3a3a40); background: transparent; color: inherit; font-size: .95rem; }
  .error { color: light-dark(#b3261e, #ff8a80); font-size: .85rem; margin: .5rem 0 0; }
  .actions { display: flex; gap: .6rem; margin-top: 1.25rem; }
  button { padding: .6rem; border-radius: 8px; border: 1px solid transparent; font-size: .95rem; cursor: pointer; }
  .actions button { flex: 1; }
  button.primary { background: light-dark(#1a1a1a, #ececec); color: light-dark(#fff, #161618); }
  button.quiet { background: transparent; border-color: light-dark(#ccc, #3a3a40); color: inherit; }
  button.danger { background: transparent; border-color: light-dark(#b3261e, #ff8a80);
                  color: light-dark(#b3261e, #ff8a80); font-size: .8rem; padding: .35rem .7rem; flex: none; }
  .hint { font-size: .8rem; opacity: .65; margin-top: 1rem; }
  .hint a { color: inherit; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} — Yap</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
  <header class="brand">${LOGO_SVG}</header>
${body}
</main>
</body>
</html>`;
}

const ROLE_OPTIONS: Array<{ value: string; title: string; summary: string }> = [
  { value: "read-only", title: "Read-only", summary: "Read items and files. No writes of any kind." },
  {
    value: "member",
    title: "Member",
    summary: "Read and edit items, docs, and files, and fire hooks. No credential, role, or space management.",
  },
  {
    value: "admin",
    title: "Admin",
    summary: "Act fully as you, including managing access keys, roles, spaces, and connected apps.",
  },
];

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

function consentPage(input: {
  clientName: string;
  params: AuthorizeParams;
  selectedRole: string;
  restrictionNote: string;
  error?: string;
}): string {
  const { params } = input;
  const hidden = [
    ["client_id", params.clientId],
    ["redirect_uri", params.redirectUri],
    ["scope", params.scope],
    ["state", params.state],
    ["code_challenge", params.codeChallenge],
    ["code_challenge_method", params.codeChallengeMethod],
  ]
    .map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
    .join("\n      ");
  const roles = ROLE_OPTIONS.map(
    (role) => `<label class="role">
      <input type="radio" name="role" value="${esc(role.value)}"${role.value === input.selectedRole ? " checked" : ""}>
      <span><strong>${esc(role.title)}</strong> — ${esc(role.summary)}</span>
    </label>`,
  ).join("\n    ");
  return page(
    `Authorize ${input.clientName}`,
    `  <h1><span class="client">${esc(input.clientName)}</span> wants to connect to your Yap</h1>
  <form method="post" action="/oauth/authorize">
      ${hidden}
    <fieldset>
    <legend>Access to grant</legend>
    ${roles}
    </fieldset>
    ${input.restrictionNote ? `<p class="restriction">${esc(input.restrictionNote)}</p>` : ""}
    <label class="keylabel" for="key">Your access key</label>
    <input id="key" type="password" name="access_key" autocomplete="off" required autofocus>
    ${input.error ? `<p class="error">${esc(input.error)}</p>` : ""}
    <div class="actions">
      <button type="submit" name="decision" value="deny" class="quiet">Deny</button>
      <button type="submit" name="decision" value="approve" class="primary">Approve</button>
    </div>
  </form>
  <p class="hint">Your key authenticates this approval and is never shared with the app — the app only receives
  tokens limited to the access selected above, revocable at any time on the
  <a href="/oauth/connections">connected apps page</a>.</p>`,
  );
}

function errorPage(title: string, message: string): string {
  return page(title, `  <h1>${esc(title)}</h1><p>${esc(message)}</p>`);
}

function fmtWhen(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * The connected-apps page: enter a key, see that user's grants, disconnect.
 * Stateless like the consent screen — the key rides the forms; nothing is
 * stored client-side. (Heads with real sessions use /v1/oauth/grants.)
 */
function connectionsPage(input: {
  grants?: oauth.GrantInfo[];
  accessKey?: string;
  error?: string;
  notice?: string;
}): string {
  let body: string;
  if (input.grants === undefined) {
    body = `  <h1>Connected apps</h1>
  <p class="hint" style="margin-top:0">Apps you have authorized to act on your Yap. Enter an access key to see
  the connections of the account it belongs to.</p>
  <form method="post" action="/oauth/connections">
    <label class="keylabel" for="key">Your access key</label>
    <input id="key" type="password" name="access_key" autocomplete="off" required autofocus>
    ${input.error ? `<p class="error">${esc(input.error)}</p>` : ""}
    <div class="actions">
      <button type="submit" class="primary">Show connections</button>
    </div>
  </form>`;
  } else {
    const rows =
      input.grants.length === 0
        ? `<p class="hint" style="margin-top:0">No connected apps.</p>`
        : input.grants
            .map(
              (grant) => `<div class="connection">
      <div class="meta">
        <strong>${esc(grant.client.name || "Unnamed app")}</strong><br>
        <code>${esc(grant.scope)}</code>
        <small>connected ${esc(fmtWhen(grant.createdAt))} · last used ${esc(fmtWhen(grant.lastUsedAt))}</small>
      </div>
      <form method="post" action="/oauth/connections/disconnect">
        <input type="hidden" name="access_key" value="${esc(input.accessKey)}">
        <input type="hidden" name="grant_id" value="${esc(grant.id)}">
        <button type="submit" class="danger">Disconnect</button>
      </form>
    </div>`,
            )
            .join("\n    ");
    body = `  <h1>Connected apps</h1>
  ${input.notice ? `<p class="notice">${esc(input.notice)}</p>` : ""}
    ${rows}
  <p class="hint">Disconnecting an app revokes its tokens immediately; your access keys are untouched.
  Apps reconnect through the normal authorize flow.</p>`;
  }
  return page("Connected apps", body);
}

function oauthErrorBody(err: oauth.OAuthError): { error: string; error_description: string } {
  return { error: err.code, error_description: err.message };
}

function formValue(form: Record<string, unknown>, name: string): string {
  const value = form[name];
  return typeof value === "string" ? value : "";
}

export function registerOAuthRoutes(server: YapServer): void {
  const app = server.mcp.getApp();
  const { db, config, logger } = server;
  const baseUrl = config.baseUrl;

  const handle = (fn: (c: Context) => Promise<Response>) => async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof oauth.OAuthError) return c.json(oauthErrorBody(err), 400);
      if (err instanceof YapError) return c.json(err.toBody(), err.httpStatus as ContentfulStatusCode);
      logger.error("unhandled OAuth error", err);
      return c.json({ error: "server_error", error_description: "internal error" }, 500);
    }
  };

  // ---- Discovery ------------------------------------------------------------
  // Served at the bare well-known paths and at the /mcp path-suffix variants
  // (RFC 8414 §3 / RFC 9728 §3 path-aware discovery for the resource
  // <baseUrl>/mcp, which is what MCP clients derive from the connection URL).

  const authorizationServerDoc = {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["role:admin", "role:member", "role:read-only"],
  };
  const protectedResourceDoc = {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
    resource_name: "Yap",
    scopes_supported: authorizationServerDoc.scopes_supported,
  };
  for (const suffix of ["", "/mcp"]) {
    app.get(`/.well-known/oauth-authorization-server${suffix}`, (c) => c.json(authorizationServerDoc));
    app.get(`/.well-known/oauth-protected-resource${suffix}`, (c) => c.json(protectedResourceDoc));
  }

  // ---- Dynamic client registration (RFC 7591) --------------------------------

  app.post(
    "/oauth/register",
    handle(async (c) => {
      let body: Record<string, unknown>;
      try {
        body = (await c.req.json()) as Record<string, unknown>;
      } catch {
        throw new oauth.OAuthError("invalid_request", "request body must be valid JSON");
      }
      const client = await oauth.registerClient(db, {
        clientName: body.client_name,
        redirectUris: body.redirect_uris,
      });
      return c.json(
        {
          client_id: client.id,
          client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1000),
          client_name: client.name,
          redirect_uris: client.redirectUris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        },
        201,
      );
    }),
  );

  // ---- Authorize screen -------------------------------------------------------

  /**
   * Validates the authorize request. Client/redirect failures render an error
   * page (never redirect to an unverified URI — RFC 6749 §4.1.2.1); all other
   * failures redirect back to the verified redirect_uri with an error code.
   */
  async function validateAuthorize(
    raw: Record<string, string>,
  ): Promise<
    | { ok: true; client: oauth.OAuthClient; params: AuthorizeParams }
    | { ok: false; page: string }
    | { ok: false; redirect: string }
  > {
    const params: AuthorizeParams = {
      clientId: raw.client_id ?? "",
      redirectUri: raw.redirect_uri ?? "",
      scope: raw.scope ?? "",
      state: raw.state ?? "",
      codeChallenge: raw.code_challenge ?? "",
      codeChallengeMethod: raw.code_challenge_method ?? "",
    };
    const client = params.clientId ? await oauth.getClient(db, params.clientId) : null;
    if (!client) {
      return { ok: false, page: errorPage("Unknown client", "This app is not registered with this Yap instance.") };
    }
    if (!client.redirectUris.some((registered) => oauth.redirectUriMatches(registered, params.redirectUri))) {
      return {
        ok: false,
        page: errorPage("Invalid redirect", "The app asked to redirect somewhere it did not register."),
      };
    }
    const redirectError = (code: string, description: string): { ok: false; redirect: string } => {
      const url = new URL(params.redirectUri);
      url.searchParams.set("error", code);
      url.searchParams.set("error_description", description);
      if (params.state) url.searchParams.set("state", params.state);
      return { ok: false, redirect: url.toString() };
    };
    if ((raw.response_type ?? "code") !== "code") {
      return redirectError("unsupported_response_type", "only response_type=code is supported");
    }
    if (!params.codeChallenge || (params.codeChallengeMethod || "S256") !== "S256") {
      return redirectError("invalid_request", "PKCE with code_challenge_method=S256 is required");
    }
    return { ok: true, client, params };
  }

  function renderConsent(
    c: Context,
    client: oauth.OAuthClient,
    params: AuthorizeParams,
    selectedRole?: string,
    error?: string,
  ): Response {
    const scope = oauth.parseScopeParam(params.scope);
    const restrictionNote =
      scope.spaces?.length || scope.bundles?.length
        ? `The app asked to be limited to ${[
            scope.spaces?.length ? `${scope.spaces.length} space(s)` : "",
            scope.bundles?.length ? `${scope.bundles.length} bundle(s)` : "",
          ]
            .filter(Boolean)
            .join(" and ")}; that limit applies whichever access you grant.`
        : "";
    return c.html(
      consentPage({
        clientName: client.name || "An unnamed app",
        params,
        selectedRole: selectedRole ?? scope.role,
        restrictionNote,
        error,
      }),
      error ? 401 : 200,
    );
  }

  app.get(
    "/oauth/authorize",
    handle(async (c) => {
      const result = await validateAuthorize(c.req.query());
      if (!result.ok) return "page" in result ? c.html(result.page, 400) : c.redirect(result.redirect, 302);
      return renderConsent(c, result.client, result.params);
    }),
  );

  app.post(
    "/oauth/authorize",
    handle(async (c) => {
      const form = (await c.req.parseBody()) as Record<string, string>;
      const result = await validateAuthorize(form);
      if (!result.ok) return "page" in result ? c.html(result.page, 400) : c.redirect(result.redirect, 302);
      const { client, params } = result;

      const redirect = new URL(params.redirectUri);
      if (params.state) redirect.searchParams.set("state", params.state);

      if (formValue(form, "decision") !== "approve") {
        redirect.searchParams.set("error", "access_denied");
        return c.redirect(redirect.toString(), 302);
      }

      // The user picks the role on the consent screen — the request's scope
      // is a preselection, not a contract. RFC 6749 §3.3 allows granting a
      // scope other than the requested one; the token response echoes it.
      const scope = oauth.parseScopeParam(params.scope);
      const chosenRole = formValue(form, "role");
      if (chosenRole === "admin" || chosenRole === "member" || chosenRole === "read-only") {
        scope.role = chosenRole;
      }

      const presentedKey = formValue(form, "access_key").trim();
      if (!presentedKey || constantTimeEqual(presentedKey, config.sysadminKey)) {
        return renderConsent(c, client, params, scope.role, "Enter one of your user access keys (the sysadmin key cannot authorize apps).");
      }
      const keyAuth = await authenticateKeyRow(db, presentedKey);
      if (!keyAuth) {
        return renderConsent(c, client, params, scope.role, "That access key is invalid or revoked.");
      }

      // The granted scope is what the user selected. The capability layer
      // clamps every token decision against the user's live grants, so the
      // delegation can never exceed the authorizing key's authority.
      const code = await oauth.mintAuthCode(db, config, {
        clientId: client.id,
        userId: keyAuth.userId,
        keyId: keyAuth.keyId,
        scope,
        codeChallenge: params.codeChallenge,
        redirectUri: params.redirectUri,
      });
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("iss", baseUrl);
      return c.redirect(redirect.toString(), 302);
    }),
  );

  // ---- Token endpoint ---------------------------------------------------------

  app.post(
    "/oauth/token",
    handle(async (c) => {
      const form = (await c.req.parseBody()) as Record<string, string>;
      const grantType = formValue(form, "grant_type");
      const clientId = formValue(form, "client_id");
      if (!clientId || !(await oauth.getClient(db, clientId))) {
        throw new oauth.OAuthError("invalid_client", "unknown client_id");
      }
      // The `resource` indicator (RFC 8707) is accepted but not recorded:
      // tokens are opaque rows in this instance's database — there is exactly
      // one audience they can ever be presented to.
      if (grantType === "authorization_code") {
        const response = await oauth.exchangeAuthCode(db, config, {
          code: formValue(form, "code"),
          codeVerifier: formValue(form, "code_verifier"),
          clientId,
          redirectUri: formValue(form, "redirect_uri"),
        });
        return c.json(response);
      }
      if (grantType === "refresh_token") {
        const response = await oauth.refreshTokens(db, config, {
          refreshToken: formValue(form, "refresh_token"),
          clientId,
        });
        return c.json(response);
      }
      throw new oauth.OAuthError("unsupported_grant_type", "use authorization_code or refresh_token");
    }),
  );

  // ---- Revocation (RFC 7009) ----------------------------------------------------

  app.post(
    "/oauth/revoke",
    handle(async (c) => {
      const form = (await c.req.parseBody()) as Record<string, string>;
      await oauth.revokeToken(db, formValue(form, "token"));
      return c.body(null, 200);
    }),
  );

  // ---- Connected apps page --------------------------------------------------

  /** Key auth for the self-served pages: sysadmin key refused, like consent. */
  async function pageKeyAuth(form: Record<string, string>): Promise<{ userId: string; keyId: string } | null> {
    const presented = formValue(form, "access_key").trim();
    if (!presented || constantTimeEqual(presented, config.sysadminKey)) return null;
    return authenticateKeyRow(db, presented);
  }

  const BAD_KEY = "That access key is invalid or revoked (the sysadmin key has no connections).";

  app.get(
    "/oauth/connections",
    handle(async (c) => c.html(connectionsPage({}))),
  );

  app.post(
    "/oauth/connections",
    handle(async (c) => {
      const form = (await c.req.parseBody()) as Record<string, string>;
      const auth = await pageKeyAuth(form);
      if (!auth) return c.html(connectionsPage({ error: BAD_KEY }), 401);
      return c.html(
        connectionsPage({
          grants: await oauth.listUserGrants(db, auth.userId),
          accessKey: formValue(form, "access_key").trim(),
        }),
      );
    }),
  );

  app.post(
    "/oauth/connections/disconnect",
    handle(async (c) => {
      const form = (await c.req.parseBody()) as Record<string, string>;
      const auth = await pageKeyAuth(form);
      if (!auth) return c.html(connectionsPage({ error: BAD_KEY }), 401);
      let notice = "App disconnected — its tokens are revoked.";
      try {
        await oauth.revokeUserGrant(db, auth.userId, formValue(form, "grant_id"));
      } catch {
        notice = "That connection was already gone."; // only notFound escapes revokeUserGrant
      }
      return c.html(
        connectionsPage({
          grants: await oauth.listUserGrants(db, auth.userId),
          accessKey: formValue(form, "access_key").trim(),
          notice,
        }),
      );
    }),
  );
}
