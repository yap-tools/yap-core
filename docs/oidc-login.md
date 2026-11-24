# Login providers (OpenID Connect)

Core serves a few pages itself, and on each one a person decides something:

- the OAuth consent screen (`/oauth/authorize`): connect an app;
- the connected-apps page (`/oauth/connections`): see and disconnect apps;
- a service's approve page (`/w/service-approve`): let a service an agent wrote run;
- a service's secret form (`/w/secret-input`): enter a secret.

Without configuration the person logs in on these pages by pasting a full
user access key, as before. The operator can also configure one or more
**OpenID Connect providers** (Google, Microsoft Entra ID, Okta, Keycloak,
Auth0, or an operator's own). Core is then a plain OIDC client of each one.
It holds no passwords, sends no email and keeps no browser session. Each page
offers "Continue with {label}" first and the access key second.

A provider login matters most for approvals. An agent holding a person's
access key could paste it into an approve page and approve its own service.
It cannot easily get through the person's provider login, with its own session
and two-factor checks, so with a provider "a person approved this" is closer
to true.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `YAP_OIDC_PROVIDERS` | *(empty)* | Comma list of provider names (`a-z`, `0-9`, `_`, starting with a letter), e.g. `google,okta` |
| `YAP_OIDC_<NAME>_ISSUER` | *(required)* | The provider's issuer URL, exactly as its discovery document states it (https; http only on loopback) |
| `YAP_OIDC_<NAME>_CLIENT_ID` / `_CLIENT_SECRET` | *(required)* | The client Core is registered as at the provider |
| `YAP_OIDC_<NAME>_LABEL` | the name, capitalised | Button text: "Continue with {label}" |
| `YAP_OIDC_<NAME>_GRANT_MAX_DAYS` | `YAP_OIDC_GRANT_MAX_DAYS` | This provider's grant lifetime (see below) |
| `YAP_OIDC_GRANT_MAX_DAYS` | `30` | How long an OAuth grant made after a provider login lives, counted from its creation |
| `YAP_OIDC_SIGNUP` | `false` | Whether a first login without an account may create one |
| `YAP_OIDC_ALLOW` | *(empty)* | Who sign-up admits: exact addresses and `@domain` entries, comma-separated |
| `YAP_OAUTH_MAX_ROLE` | *(unset: admin)* | The highest role the consent screen offers and grants, `admin`, `member` or `read-only`, for every login method |

At the provider, register Core as a confidential web client with the redirect
URI `<YAP_BASE_URL>/oidc/<name>/callback`, the scopes `openid email profile`,
and PKCE allowed. The callback URL is always built from `YAP_BASE_URL` and
never from the request, so configuring a provider without `YAP_BASE_URL`
fails at startup. So does a provider without an issuer, client id or secret,
or an http issuer that is not on loopback.

Core fetches the provider's discovery document
(`<issuer>/.well-known/openid-configuration`) when a login starts and caches
it for an hour. The issuer in it must equal the configured one, and its
endpoints must be https. Outbound requests to the provider are plain `fetch`
calls, not driver egress, so a provider on a private network (a self-hosted
Keycloak) needs no `YAP_HOOK_ALLOW_HOSTS` entry.

## The round trip

1. **Start.** The person clicks "Continue with {label}". The consent screen
   submits its own authorize form to `POST /oidc/<name>/start`, which checks it
   as an authorize request. The other pages link to `GET /oidc/<name>/start`
   with what the page is for (`for=connections`, `service-approve` or
   `secret-input`) and, for the approve page and the secret form, the page's
   request id and its own signed token. Core stores the pending login
   server-side in `oidc_transactions`: the page, what it is about (the
   authorize request, or the request id), and a PKCE verifier and a nonce,
   both encrypted with the master key. It then redirects to the provider with
   a random `state` of its own (only its hash is stored), the nonce and the
   PKCE challenge. The row expires after ten minutes.
2. **Callback.** The provider sends the browser to
   `/oidc/<name>/callback?code=…&state=…`. Core claims the row for that state
   and that provider exactly once (a replayed callback is refused), checks the
   response's `iss` when the provider sends one (RFC 9207), and exchanges the
   code at the token endpoint with the PKCE verifier and the client secret
   (`client_secret_basic`, or `client_secret_post` if that is all the provider
   takes). It verifies the ID token: the signature against the provider's
   JWKS, with asymmetric algorithms only; issuer; audience, and `azp` when
   there are several audiences; expiry and issued-at; and the nonce. It then
   finds the person (below) and mints a **login ticket**: a random one-off
   secret, stored hashed on the row, good for ten minutes.
3. **The decision.** The callback renders the page the login was for again,
   now with "Logged in as {name} with {label}" and the ticket in it: the
   consent screen with its role choice, the approve page with the service as
   the server has it, the secret form with its fields, or the connections
   list. **The callback never consents, approves or saves anything itself.**
   Core has no session, so nothing ties a callback to the browser that started
   the flow. Someone could start an approval and trick another person into
   finishing the provider login. So the decision is always the person's click
   on the page after the callback, with their name on it. That page posts the
   ticket instead of an access key. The ticket is spent once, and only on the
   page and request it was minted for: a consent ticket only for the same
   client, redirect URI, scope, state and PKCE challenge, an approve or secret
   ticket only for that request. A post that carries both a ticket and a key
   is refused. These pages are served with `Cache-Control: no-store`,
   `Referrer-Policy: no-referrer` and no framing.

The connections list decides nothing, so it is shown at the callback straight
away. Its disconnect buttons post a signed session token naming the user and
the key they logged in with (none after a provider login), whichever way they
logged in. It is good for ten minutes from the login and is never renewed. A
session from a key login stops working as soon as that key is revoked. The
list never echoes an access key into the page.

Every step after the callback checks what it checked before. Consent still
validates the client and the redirect URI. The approve page still checks
`edit_services`, the write capabilities and that the service is unchanged.
The secret form still checks the requester and the person. A refused attempt
spends a provider login's ticket, so after any refusal the person logs in
again. The provider's own session makes that a quick redirect.

## Who a login is

- **A returning person** is recognised by the provider's issuer and its
  subject id (`sub`), stored in `user_identities` (unique per issuer and
  subject). Never by email: addresses change and get reused.
- **An invite** is a user the operator created with an email
  (`POST /v1/users {"name", "email"}`, or `PATCH /v1/users/:id {"email"}` on an
  existing user) and no linked identity yet. The first login whose
  provider-verified email (`email_verified: true`, a boolean) matches claims
  it: the identity is linked, and from then on the email no longer matters.
  The claim checks the user still carries that email, so clearing or changing
  it withdraws the invite.
  Two logins claiming the same invite at once are serialised: the second finds
  it claimed. Any configured provider can claim an invite, so set an email
  only on a user you mean to invite. If several unclaimed users carry the same
  email, the login is refused until the operator sorts it out.
- **Sign-up**, only with `YAP_OIDC_SIGNUP=true`: a first login with no account
  and no invite creates one when the verified email is on `YAP_OIDC_ALLOW`,
  either as an exact address or under an `@domain` entry. A Google account can
  carry a company address without belonging to that company's Workspace. So
  for Google (`https://accounts.google.com`), a domain entry also needs the
  ID token's `hd` claim to name that domain. The new user gets a personal space
  and **no access key**; they can make one later, e.g. for the CLI. The
  allowlist only decides who may create an account. After that the user is
  recognised by their identity.
- Anyone else sees "There is no Yap account for this login."

`users.email` is nullable and not unique. It is used only for invite and
allowlist matching.

## Grants made after a provider login

Consent after a provider login mints the same authorization code and tokens as
a key login, with two differences:

- **No key.** The grant (`oauth_grants.key_id` null) belongs to the user
  directly. Revoking one of their access keys leaves it alone. It ends when the
  person disconnects it (connected apps, `DELETE /v1/oauth/grants/:id`), when
  the sysadmin revokes it (`DELETE /v1/users/:id/oauth-grants/:grantId`), or
  when the user is deleted.
- **A maximum lifetime.** `expires_at` is set at creation to
  `YAP_OIDC_<NAME>_GRANT_MAX_DAYS` (default `YAP_OIDC_GRANT_MAX_DAYS`, 30) days
  later and is never extended by refresh. Tokens are clamped to it, and past it
  refresh fails and the access token stops working, so the client must send
  the person through the login again. A person whose provider account is
  closed loses access within that window. It does not touch access keys the
  person made themselves.

Key-backed grants are unchanged: bound to their key, no end of their own.
Connected-app listings show `expiresAt` (null for a key-backed grant).

`YAP_OAUTH_MAX_ROLE` caps the role on the consent screen for both login
methods. Higher roles are not offered, and a posted one is lowered to the cap.

## In a host's frame

The approve page and the secret form can render as widgets inside an MCP
host's sandboxed frame, where a provider redirect cannot work. There, each
"Continue with {label}" link opens the start URL in a tab of its own
(`target="_blank"`). The login and the decision happen in that top-level tab.
The widget learns the providers from the server (`logins` in the view
response), never from its data. Key login keeps working in the frame.

## Not here

- **Switching key login off**, instance-wide or per user, is a separate change.
  The pages already lead with the providers, and what a page offers comes from
  one function, `loginOptions` in `src/core/oidc.ts` (`keyLogin`). A later
  switch hides the key field there.
- **Re-checking the provider on refresh** (keeping its refresh token) is not
  done. The grant lifetime bounds how long a closed provider account keeps
  access.
- **Other login methods** (GitHub OAuth, SAML, passkeys) would sit beside OIDC
  and hand back the same thing: a verified Yap user. Consent, tokens and
  capability checks never see which method was used. A method decides who
  someone is, so it belongs in Core or in code the operator installs and pins,
  never in code an agent can add.

Code: `src/core/oidc.ts` (the round trip, ID-token checks, matching the
person), `src/core/personLogin.ts` (the shared "identify the person" step,
key or ticket), `src/rest/oauth.ts` (the routes and pages), migration
`0017_oidc_login`.
