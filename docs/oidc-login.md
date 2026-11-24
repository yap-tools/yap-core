# Login providers (OpenID Connect)

Core serves a few pages itself, and on each one a person decides something:

- the OAuth consent screen (`/oauth/authorize`): connect an app;
- the connected-apps page (`/oauth/connections`): see and disconnect apps;
- a service's approve page (`/w/service-approve`): let a service an agent wrote run;
- a service's secret form (`/w/secret-input`): enter a secret.

Without configuration the person logs in on these pages by pasting a full
user access key, as before. With a provider configured, the operator can also
switch key login off ([key-login.md](key-login.md)). The operator can also configure one or more
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
| `YAP_OIDC_<NAME>_PRESET` | `generic` (`google` for `https://accounts.google.com`) | How the provider's ID token is read: `generic`, `google` or `entra` ([Provider presets](#provider-presets)) |
| `YAP_OIDC_<NAME>_EMAIL_CLAIM` | the preset's | The claim holding the email, or a comma list tried in order: the first that holds an address is used. Any claim but `email` needs `_TRUST_EMAIL=true` |
| `YAP_OIDC_<NAME>_TRUST_EMAIL` | the preset's | `true`: accept that email without `email_verified: true` |
| `YAP_OIDC_<NAME>_SUBJECT_CLAIM` | the preset's | The claim that identifies a returning person |
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

## Provider presets

Providers differ in which claims their ID tokens carry, not in how the login
works. So each provider gets a **preset**, a small table of claim-reading
defaults (`OIDC_PRESETS` in `src/config.ts`), and the three env overrides
above change single entries of it. `mapClaims` in `src/core/oidc.ts` reads the
verified ID token through that table into a subject, an email, a name and
whether the provider vouches for the email's domain. Everything after it
(invites, sign-up, returning people) sees only that result. A bad preset name,
trust value or claim name fails startup. So does an `_EMAIL_CLAIM` naming
any claim but `email` on a provider not set to trust its email:
`email_verified` speaks for the `email` claim only, so an address from another
claim is unverified by definition.

| Preset | Email from | Needs `email_verified: true` | Subject | `@domain` allowlist entries |
|---|---|---|---|---|
| `generic` | `email` | yes | `sub` | admit any address in the domain |
| `google` | `email` | yes | `sub` | also need `hd` to name the domain |
| `entra` | `email`, else `preferred_username` | no (trusted) | `oid` | admit any address in the domain |

Without `_PRESET`, a provider gets `generic`, except one whose issuer is
`https://accounts.google.com`, which gets `google`. That is how providers
behaved before presets existed.

### generic

Plain OpenID Connect, for Okta, Keycloak, Auth0 and the like. An email counts
only when the token says `email_verified: true` (a boolean). For a provider
that never sends `email_verified`, set `_TRUST_EMAIL=true`; for one that sends
its address in another claim, set `_EMAIL_CLAIM` too (it needs
`_TRUST_EMAIL=true`). Trusting the
email means anyone who can set that attribute at the provider can claim an
invite with it, so trust only a provider whose admins control it.

### google

As `generic`, plus a check on the hosted domain. A Google account can carry a
company address without belonging to that company's Workspace. So under
`google`, an `@domain` entry on `YAP_OIDC_ALLOW` admits an address only when
the ID token's `hd` claim names that domain. An exact address needs no `hd`.
The check follows the preset, not the issuer.

```sh
YAP_OIDC_PROVIDERS=google
YAP_OIDC_GOOGLE_ISSUER=https://accounts.google.com
YAP_OIDC_GOOGLE_CLIENT_ID=…
YAP_OIDC_GOOGLE_CLIENT_SECRET=…
```

### entra

Microsoft Entra ID, v2.0 tokens. They carry no `email_verified`, and `email`
only when the tenant has a mail address for the person and the app asks for it
as an optional claim. So the preset falls back to `preferred_username` (the
sign-in name, usually the UPN) and trusts the address. A returning person is
recognised by `oid`, the person's object id in the tenant. Entra's `sub` is
pairwise: it differs for each app registration, so replacing the registration
would make every existing user a stranger. `oid` stays the same.

```sh
YAP_OIDC_PROVIDERS=microsoft
YAP_OIDC_MICROSOFT_PRESET=entra
YAP_OIDC_MICROSOFT_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
YAP_OIDC_MICROSOFT_CLIENT_ID=…
YAP_OIDC_MICROSOFT_CLIENT_SECRET=…
YAP_OIDC_MICROSOFT_LABEL=Microsoft
```

- **Use the single-tenant issuer**, `https://login.microsoftonline.com/<tenant-id>/v2.0`,
  with the tenant's id. The multi-tenant endpoints (`common`, `organizations`)
  publish a templated issuer that does not equal the configured one, so
  discovery refuses them.
- **Invite people by the address the mapping produces**: `email` when the token
  has it, else `preferred_username`. The UPN can differ from the mail address
  (`ann@tenant.onmicrosoft.com` rather than `ann@example.com`), and an invite
  matches `users.email` exactly. When in doubt, look at the token's claims for
  a test user.
- **Trusting the email** means the invite and the allowlist rely on the
  tenant's admins controlling that attribute. Anyone who can change a user's
  UPN or mail in the tenant can make it match an invite.

#### Restricting login to a group

Core does not check groups, and is not meant to. Use Entra's own control: on
the app's **Enterprise application**, set **Assignment required** to **Yes**
and assign the users or groups who may log in. Entra then refuses everyone
else before the login reaches Core. Per Microsoft's documentation
([access management](https://learn.microsoft.com/entra/identity/enterprise-apps/what-is-access-management),
[assigning users and groups](https://learn.microsoft.com/entra/identity/enterprise-apps/assign-user-or-group-access-portal)):

- Assigning a **group** needs Entra ID P1 or P2. Assigning individual users
  does not.
- **Nested groups** are not honoured: only direct members of an assigned group
  get in.
- An app that requires assignment needs **tenant-wide admin consent**; users
  cannot consent to it themselves.
- **Removing someone** from the group stops their new logins, but does not
  revoke grants already issued. Those live until the grant's maximum lifetime
  (`YAP_OIDC_<NAME>_GRANT_MAX_DAYS`) or until the person or the sysadmin
  revokes them.
- **Access keys bypass Entra** entirely. If assignment is meant to be the gate,
  switch key login off, for the instance (`YAP_KEY_LOGIN=false`) or per user
  ([key-login.md](key-login.md)).

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
  subject id (the preset's subject claim: `sub`, or `oid` under `entra`),
  stored in `user_identities` (unique per issuer and subject). Never by email:
  addresses change and get reused.
- **An invite** is a user the operator created with an email
  (`POST /v1/users {"name", "email"}`, or `PATCH /v1/users/:id {"email"}` on an
  existing user) and no linked identity yet. The first login whose
  email matches claims it. The email must be one the provider vouches for:
  `email_verified: true` (a boolean), or any address from a provider set to
  trust it (the `entra` preset, or `_TRUST_EMAIL=true`). the identity is linked, and from then on the email no longer matters.
  The claim checks the user still carries that email, so clearing or changing
  it withdraws the invite.
  Two logins claiming the same invite at once are serialised: the second finds
  it claimed. Any configured provider can claim an invite, so set an email
  only on a user you mean to invite. If several unclaimed users carry the same
  email, the login is refused until the operator sorts it out.
- **Sign-up**, only with `YAP_OIDC_SIGNUP=true`: a first login with no account
  and no invite creates one when that email is on `YAP_OIDC_ALLOW`, either as
  an exact address or under an `@domain` entry. Under the `google` preset a
  domain entry also needs the ID token's `hd` claim to name that domain (see
  [google](#google)). The new user gets a personal space
  and **no access key**. The allowlist only decides who may create an account.
  After that the user is recognised by their identity.
- Anyone else sees "There is no Yap account for this login."

A user a provider login created or claimed is set to **provider login only**
([key-login.md](key-login.md)): their access keys are refused and none can be
made for them, and claiming an invite deletes the OAuth grants the invite's
keys had authorized. To give such a user a key, for the CLI say, the sysadmin
clears the flag (`PATCH /v1/users/:id {"providerLoginOnly": false}`) and then
issues one.

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
response), never from its data. Key login keeps working in the frame, unless
the operator switched it off.

## Not here

- **Switching key login off**, instance-wide or per user, is in
  [key-login.md](key-login.md). What a page offers comes from one function,
  `loginOptions` in `src/core/oidc.ts`; its `keyLogin` is false where key login
  is off for the instance.
- **Group or role checks.** Core admits by invite and allowlist only. Restrict
  who can log in at the provider (for Entra, [Assignment required](#restricting-login-to-a-group)).
- **Multi-tenant Entra** (any tenant's users, checked by `tid`) is not
  supported; configure one provider per tenant.
- **Re-checking the provider on refresh** (keeping its refresh token) is not
  done. The grant lifetime bounds how long a closed provider account keeps
  access.
- **Other login methods** (GitHub OAuth, SAML, passkeys) would sit beside OIDC
  and hand back the same thing: a verified Yap user. Consent, tokens and
  capability checks never see which method was used. A method decides who
  someone is, so it belongs in Core or in code the operator installs and pins,
  never in code an agent can add.

Code: `src/core/oidc.ts` (the round trip, ID-token checks, reading the
claims, matching the person), `src/config.ts` (the presets), `src/core/personLogin.ts` (the shared "identify the person" step,
key or ticket), `src/rest/oauth.ts` (the routes and pages), migration
`0017_oidc_login`.
