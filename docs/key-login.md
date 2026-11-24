# Switching access-key login off

By default a person proves who they are with a user access key: pasted into
the pages Core serves itself (the consent screen, connected apps, a service's
approve page and its secret form), or sent as a bearer credential to `/v1` and
`/mcp`. Once the operator has configured a login provider
([oidc-login.md](oidc-login.md)), keys can be switched off, for the whole
instance or for one user. An instance can then have users who only ever log in
through their provider and never see an access key.

Both switches use one refusal, `keyRefusal` in `src/core/keyLogin.ts`. Every
presented key goes through `authenticateKey` (`src/core/keys.ts`), which asks
it, and so does every place a key is made.

## Instance-wide: `YAP_KEY_LOGIN=false`

On unless set to `false`. With it off:

- **Pages and widgets** show only the "Continue with {provider}" buttons: no
  key field, no "or use an access key", no mention of keys. The button that
  decides (Approve, Save) appears on the page rendered after the provider
  login. Deny and Reject need no login and stay. A key posted anyway is
  refused with "Sign in with {provider} to …".
- **No user key can be made.** `POST /v1/keys`, `POST /v1/keys/:id/rotate`,
  the sysadmin's `POST /v1/users/:id/keys` and a new user's initial key are
  all refused (`403`, `details.reason: "key_login_off"`). `POST /v1/users`
  creates the user without a key (`201`, no `initialKey`). A refused rotation
  leaves the old key alone. Revoking a key still works.
- **A key is refused as an API credential**, on `/v1` and on `/mcp`, bearer
  and `?key=` alike: `401` with "Access keys can't be used on this instance.
  Connect with {provider}." in each surface's usual error shape, and
  `details.reason: "key_login_off"` on `/v1`. Every key gets that answer
  before any lookup, so it does not reveal which keys exist.
- **OAuth tokens from a provider login keep working.** A grant made with a key
  counts as made with a refused key: its tokens are refused and it cannot be
  refreshed or exchanged. Nothing is deleted, so switching key login back on
  brings those grants back.
- **The sysadmin key is unaffected.** It is not a user key: it keeps working
  on the sysadmin endpoints and stays refused over MCP, as always.
- **Agent-facing text** (the `help` tool, tool and second-tier descriptions,
  the widget resources) words the login steps without keys.

Starting with `YAP_KEY_LOGIN=false` and no `YAP_OIDC_PROVIDERS` fails at
startup: nobody could log in.

## Per user: `providerLoginOnly`

A flag on the user (`users.provider_login_only`). For that user:

- a key pasted into a page is refused with "This account logs in with
  {provider}, not with an access key. Use the {provider} button.";
- their keys are refused on `/v1` and `/mcp` (`401`,
  `details.reason: "provider_login_only"`);
- no key can be made or rotated for them, by them or by the sysadmin (`403`,
  naming the flag).

The sysadmin sets and clears it with `PATCH /v1/users/:id
{"providerLoginOnly": true}`, and can give it on `POST /v1/users` (the user is
then created without a key). `GET /v1/users/:id` and `whoami` report it. A
user created through a provider login gets it on: a sign-up, and an invite the
moment it is claimed. To give such a user a key (for the CLI, say), the
sysadmin clears the flag first and then issues one.

Setting the flag deletes, in the same transaction, every OAuth grant and
unexchanged authorization code of that user that one of their keys authorized,
so a client connected through a key stops working and reconnects through the
provider. Grants made after a provider login carry no key and stay. The keys
themselves stay stored but refused. Clearing the flag makes them work again
and brings no grant back.

A page cannot know who someone is before they log in, so on an instance with
key login on the key field still shows; only the instance switch removes it.

## Open sessions

The MCP transport authenticates every HTTP request, not only the one that
opens a session. A key refused by either switch, or a grant deleted by the
flag, stops an open MCP session on its next request.

## The CLI

The CLI's user lane only knows an access key (`.yap/credentials.json`, or
`--key`/`YAP_KEY`): the OAuth server has no grant a terminal can use. Where a
key is refused, the CLI prints that the instance accepts only provider login
(or that the account does) instead of a bare `401`, and `yap user create`
reports a user created without a key. The sysadmin lane, which reads the
sysadmin key from `.env`, is unaffected.

Code: `src/core/keyLogin.ts` (the refusal and its wording), `src/core/keys.ts`
(`authenticateKey`, the creation guard), `src/core/users.ts` (the flag and the
grant revocation), `src/core/oauth.ts` (key-backed grants), migration
`0018_provider_login_only`.
