# Yap reference

Verified against yap-core source. Base URL defaults to `http://localhost:8787`; every REST request carries `Authorization: Bearer <access-key>` unless marked **sysadmin** (then the bearer is `YAP_SYSADMIN_KEY` from the instance's `.env`).

## REST endpoint map (`/v1`)

### Spaces & bundles
| Method & path | Notes |
|---|---|
| `GET/POST /v1/spaces` | list / create (`{"name": "..."}`) |
| `GET/PATCH/DELETE /v1/spaces/:id` | |
| `GET/POST /v1/spaces/:id/bundles` | list / create |
| `GET/PATCH/DELETE /v1/bundles/:id` | |
| `GET/POST /v1/spaces/:id/grants`, `DELETE …/grants/:grantId` | role grants on a space. POST body `{userId \| email, capabilities, effect}`: the grantee as exactly one of `userId` or `email` (`400` for both or neither; the email is matched case-insensitively, a user invited by email who has not logged in yet counts, an unknown address is `404` "no user with that email" and creates nobody), `capabilities` a name or an array, `effect` `"allow"` \| `"deny"`; `201` with the new rows. GET lists the rows |
| `GET/POST /v1/bundles/:id/grants`, `DELETE …/grants/:grantId` | role grants on a bundle, same bodies |

Space and bundle reads (`GET /v1/spaces`, `GET /v1/spaces/:id`, `GET /v1/spaces/:id/bundles`, `GET /v1/bundles/:id`) carry a top-level `role`: the array of capability names the calling credential holds there, the same set MCP `load`, `load_space` and `load_bundle` return. It is never omitted and may be empty. A space's `role` ignores bundle-level grants, so a user with only a bundle grant sees `[]` on the space and the granted set on the bundle. An OAuth token's role scope and `space:` / `bundle:` limits, and a scoped key's role, are already applied. Account-level `deniedCapabilities` are separate and live on `GET /v1/whoami`.

### Bundle docs & user docs
| Method & path | Body |
|---|---|
| `GET /v1/bundles/:id/docs` | list named bundle docs |
| `POST /v1/bundles/:id/docs` | create: `{"name", "content"?, "autoload"?}` |
| `GET/PATCH/DELETE /v1/bundles/:id/docs/:docRef` | read, update (`{"name"?, "content"?, "autoload"?}`), or delete by id or name; PATCH also accepts `{"edits": [EditOp, ...]}` for surgical edits instead of full content replacement |
| `GET/POST /v1/user-docs` | create: `{"name", "content"?, "autoload"?}` |
| `GET/PATCH/DELETE /v1/user-docs/:id` | PATCH: `{"name"?, "content"?, "autoload"?}` or `{"edits": [EditOp, ...]}` |

### Item-types & properties
| Method & path | Body |
|---|---|
| `GET/POST /v1/bundles/:id/item-types` | create: `{"name", "properties"?: [...]}` |
| `GET/PATCH/DELETE /v1/item-types/:id` | |
| `POST /v1/item-types/:id/properties` | add a property |
| `PATCH/DELETE /v1/item-types/:id/properties/:propId` | |

Property: `{"name", "datatype", "required"?, "multi"?, "config"?}`.

| Datatype | Stored as | `config` constraints |
|---|---|---|
| `text` | string | `{pattern}` — regex via `RegExp.test`; anchor `^…$` for full match; `{enum}` — one of the listed strings (multi-select when `multi`) |
| `number` | number | `{min, max, decimals}` — inclusive bounds; default 2 decimals, excess precision rejected |
| `boolean` | bool | — |
| `date` | default (an instant): send `YYYY-MM-DD` (stored as midnight UTC) or a timestamp with `Z` or an offset (`2026-11-16T09:00:00+01:00`, stored as that instant); read back as UTC ISO-8601 (`2026-11-16T08:00:00.000Z`). Anything else, a zoneless timestamp included, is refused — on writes and filter values alike. With `{precision: "day"}`: send only `YYYY-MM-DD` (`2026-11-16`), stored and read back as sent; a timestamp is refused (`docs/dates.md`) | `{precision}` — `"day"` for a calendar day (a due date, a birthday), `"instant"` (or omitted) for a moment. Switching an existing property converts values that are all exactly midnight UTC; any other value refuses the switch and the error names the items |
| `item` | `item://<id>` (same bundle) | `{itemType}` — referent must be of that type; send a name or id of a type in the bundle, it is stored and read back as the id (renames never break it; an unknown one is refused) |
| `file` | `file://<id>` (finalized file) | — |
| any with `multi: true` | ordered array | `{minItems, maxItems}` |
| single-valued `text` / `number` | — | `{unique}` — no two items of the type may share a value; enabling it on a property with existing duplicates is rejected |

Schemas are freely mutable (EAV): renames touch no values, removals drop values, tightened configs are not retroactive. Two exceptions look at stored data: enabling `unique` is rejected while duplicates exist, and switching a date's `precision` rewrites its values (to `day` only when all are exactly midnight UTC, else rejected naming the items). `config` is replaced whole on update, so keep `precision` in it when changing another key.

### Items
| Method & path | Shape |
|---|---|
| `POST /v1/bundles/:id/items` | `{"itemType": "Todo", "items": [{...}, ...]}` → 201; all-or-nothing: one invalid item or a failed write creates none |
| `GET /v1/bundles/:id/items?itemType=T` | query; or `?ids=a,b,c` to fetch by id |
| `PATCH /v1/items/:id` | `{"set"?: {"prop": value}, "edits"?: {"textProp": [EditOp, ...]}}` — at least one required; `set` replaces values, `edits` applies surgical ops to text properties |
| `DELETE /v1/items/:id` | |

**EditOp** — surgical edit operations (used in `edits` on doc and item PATCH endpoints, and in the MCP `patch_doc` / `patch_user_doc` / `update_items` tools):

| `op` | Required fields | Notes |
|---|---|---|
| `prepend` / `append` | `content` | |
| `search_replace` | `search`, `replace`, `all`? | Error if not exactly one match; `all: true` replaces all occurrences |
| `insert_before` / `insert_after` | `target`, `content` | Anchor ops: splice at the raw character offset — include newlines in `content` yourself |
| `delete` | `target` | Anchor op — removes first occurrence of `target` |
| `replace_lines` | `from`, `to`, `content` | 1-based inclusive line range; line-aware |
| `delete_lines` | `from`, `to` | 1-based inclusive line range; line-aware |

Each op takes exactly the fields in its row (plus `op`). The whole array is checked before anything is applied: a missing, `null` or wrong-typed field, or a field the op does not take (`{"op": "prepend", "value": "..."}`), is refused with `400 invalid_request` naming the op index and the field, e.g. `edits[0]: unknown key "value" for op "prepend"; expected {op, content}`. Ops are then applied sequentially; if any fails, the entire update is rejected and nothing is written.

**MCP-only doc tools** (via `call`): `get_doc {id}` — read a single bundle doc by name or id. `patch_doc {id, edits}` — surgical edits on a bundle doc. First-tier: `get_user_doc {id}`, `patch_user_doc {id, edits}`.

Query parameters: `itemType` (required unless `ids=`; use the exact name from the item-types listing), `filters` (URL-encoded JSON array), `sort=<property>`, `direction=asc|desc`, `cursor`, `limit`.

Response envelopes: list endpoints return `{"data": [...]}`; paginated queries return `{"data": [...], "nextCursor": "..."}` — pass `nextCursor` back as `cursor=` until it's absent. An item materializes as `{"id", "itemType", "createdAt", "updatedAt", "values": {"<property>": <value>, ...}}`.

Filters AND-combine: `{"property", "op", "value", "quantifier"?}`.

| Ops | Meaning |
|---|---|
| `eq, neq, contains, gt, gte, lt, lte, in` | comparisons; on `multi` fields take `quantifier`: `any` (default) / `all` / `none` |
| `has` | multi field contains value |
| `has_any / has_all / has_none` | multi field vs an array, e.g. `{"property": "tags", "op": "has_all", "value": ["x", "y"]}` |

### Files (three-phase upload)
1. `POST /v1/bundles/:id/files/upload-request` → upload URL + file id
2. Upload bytes to that URL (direct to storage; local-disk mode serves `PUT /v1/files/:id/upload`)
3. `POST /v1/files/:id/complete` (size read from storage)

Or in one call, from a URL: `POST /v1/bundles/:id/files/sideload` `{"url", "name"?, "mime_type"?}` → 201 with the finalized file. The server downloads it (plain GET, http(s) only, no credentials or headers; private addresses refused). Pass a direct link to the file, not a share or preview page, and check the returned `mimeType` and `size`. 502 = the URL failed or answered non-2xx, 504 = timed out, 403 "sideloading is disabled on this instance" = switched off by the operator.

Then: `GET /v1/bundles/:id/files` (list), `GET /v1/files/:id/link` (mint expiring download link — always resolve `file://` refs this way before showing a user), `DELETE /v1/files/:id` (blob deleted immediately).

### Services & runs
| Method & path | Notes |
|---|---|
| `GET /v1/bundles/:id/services` | id, name, description, driver, actions (only the service's *allowed* actions, each with its callable — unpinned — params), `approved` (false while a service written over MCP waits for a person; it does not run). A caller with `edit_services` also gets `approvedAt` / `approvedBy`, and `settings` (the config minus its secrets) and `secretsSet` (the secret paths that hold a value); both null while the config is one sealed blob (driver without a config schema, or a config the boot split could not split). Secret values are never returned |
| `POST /v1/bundles/:id/services` | the whole config, secrets included (MCP authoring takes settings only; see below) — `{"name", "description"?, "driver"?, "params"?, "pins"?, "actions"?, "config"}`; `driver` defaults to `http` (built-ins: `http`, `mail`); `actions` is an allowlist of the driver's action names (omit = all; one allowed action becomes the implicit default); config is driver-shaped; split by the driver's config schema into readable settings and encrypted, write-only secrets (no schema = one encrypted blob) |
| `PATCH/DELETE /v1/services/:id` | patch: `{"name"?, "description"?, "params"?, "pins"?, "actions"?, "config"?}` (`pins: null` clears the pin set; `actions: null` clears the allowlist; `config` replaces the settings and keeps every secret it leaves out, `null` at a secret path removes it; see `docs/service-config.md`). A patch that sends `config` approves the service; one without leaves its approval as it is. With a scoped key neither approves: a create or a `config` patch waits, and so does a patch that changes params, pins or actions |
| `POST /v1/services/:id/approval-request` | `edit_services`: opens a one-off approve page for a service that waits → `{"request_id", "service", "expires_in", "origin_url"}` (201); refused for one already approved. See `docs/service-approval.md` |
| `POST /v1/service-approvals/:id/view` | public, gated by the page's own signed token: `{"token"}` → `{"view", "fingerprint", "logins"}`, the service as the server has it (destinations first, actions, params, pins, settings, set secret paths). What the `service-approve` widget reads before it shows anything |
| `POST /v1/service-approvals/:id/decide` | public, same token: `{"token", "decision": "approve" \| "reject", "access_key"? \| "login_ticket"?, "fingerprint"?}` → `{"decision", "service"}`. Approve needs a login: a full user access key (never the sysadmin key, an OAuth token or a scoped key; 401), or the ticket of a provider login made for this page (`docs/oidc-login.md`) whose user holds `edit_services` (403), and the view's fingerprint (409 if the service changed); a refused approve leaves the page open. Reject needs no key. One decision per page (409), expires like a secret form (401) |
| `POST /v1/secret-requests/:id/view` | public, same token as submit: `{"token"}` → the form as the server has it (`service_name`, `fields`, `destinations`: where the requested secrets are sent). What the widget in a host's frame shows |
| `POST /v1/secret-requests/:id/submit` | public, gated by the form's own signed token plus a login: `{"token", "access_key" \| "login_ticket", "values": {"<secret path>": "<value>"}}` (a full user access key, or a provider login's ticket for this form, whose user holds `edit_services`; never the sysadmin key, an OAuth token or a scoped key: 401 / 403, the form stays open) → `{"saved": true, "paths"}`. What the `secret-input` widget and its `/w/secret-input?token=` page post; 401 expired/invalid, 409 already used, 400 a value the driver refuses (the form stays open) |
| `POST /v1/services/:id/run` | `{"action"?, "params"?, "wait_ms"?}` → a run record; `wait_ms` clamped to `YAP_RUN_WAIT_CAP_MS` (25000 default) |
| `GET /v1/runs/:id` | one run: status (`queued\|running\|succeeded\|failed`), the caller's params, result/error, bundle I/O trail (file/item reads and item/file writes as metadata) |
| `GET /v1/bundles/:id/runs` | `?service=` filter, `cursor`, `limit`; newest first |
| `GET/POST /v1/bundles/:id/schedules` | list (`?service=` filter; needs `run_services`) / create `{service, action?, params?, cron, timezone?, enabled?}` (needs `run_services` only; the creator becomes the owner the schedule runs as) |
| `GET/PATCH/DELETE /v1/schedules/:id` | needs `run_services`; only the owner may change action/params/cron/timezone or re-enable; anyone else with `run_services` may disable or delete |

A run records `userId`, `source` (`mcp`/`rest`/`hook`/`schedule`) and `scheduleId`. **Schedules** fire a service on a 5-field cron in an IANA timezone (default UTC), as their owner: `run_services` is re-checked on each tick (losing it disables the schedule, reason in `lastError`); a tick while the previous run is still `queued`/`running` is skipped (`lastSkippedAt`); missed ticks are not caught up. MCP has `create_schedule` `{service, action?, params?, cron, timezone?, enabled?}`, `update_schedule` `{id, action?, params?, cron?, timezone?, enabled?}`, `delete_schedule` `{id}` and `list_schedules` `{service?}` — same gate and rules as REST, any OAuth role that can run services; `load_bundle` lists them too. `YAP_SCHEDULER=on|off` (default `on`) — on in exactly one process per database.

Service egress (the `http` driver, or any driver declaring `egress: true`) denies private/link-local destinations unless allowlisted via `YAP_EGRESS_ALLOW_HOSTS` (exact host names or IPs only; an allowed name stands for every address it resolves to). The `http` driver's own timeout is `YAP_HTTP_TIMEOUT_MS` (30 s default); no automatic retries. The older `YAP_HOOK_ALLOW_HOSTS` / `YAP_HOOK_TIMEOUT_MS` are still read, with a startup warning.

**Built-in drivers:** `http` (one action, `fire`: the configured request with `{{param}}` substitution) and `mail` (one IMAP/SMTP account; actions `folders`, `search`, `read`, `mark`, `send`, `draft`, `delete_draft`, `attachment` — a service allowlists which; `attachment` stores one attachment of a read message as a bundle file, and `draft`/`send` take `attachments` (comma-separated `file://` refs or ids of files in the service's own bundle, at most 10 and 17 MiB), switched off per service by pinning `attachments` to `""`; recipients are `to`/`cc`/`bcc`, and pinning any one of them locks the others, so a pinned `to` fixes where mail goes; `draft` writes into the account's Drafts folder for a human to send). Mail config: `user` + `pass` or `oauth2`, `from`, `imap`/`smtp: {host, port, security?}`; a wrong password is rejected at authoring. Full reference: `docs/mail-driver.md`.

**Service authoring over MCP** (second-tier `call` tools, `edit_services` on the bundle): `get_service` `{id}` (name or id) returns one service; to an `edit_services` holder it adds the record's `params`, `pins`, `settings` and `secretsSet` (never a value), to anyone else it is the listing view. `load_bundle` never carries settings. `create_service` `{name, driver?, description?, params?, pins?, actions?, settings}` and `update_service` `{id, name?, description?, params?, pins?, actions?, settings?}` take **settings only**: a value at a secret path is refused with an error pointing to `secret_request`; `null` at a secret path removes a stored secret; `settings` on update replaces the settings and keeps a secret while the object holding it stays, unless a setting the secret is bound to changes (http headers ↔ `url`; mail secrets ↔ `imap`, `smtp`, `allow_plaintext_auth`, `oauth2.token_url`): then it is dropped and must be entered again. The driver's checks run as if missing secrets were filled in; its online check (http SSRF guard) runs once nothing is missing. A driver without a config schema cannot be authored over MCP, nor a service whose config is one sealed blob. `delete_service` `{id}`. `secret_request` `{id, paths?}` reserves a one-off form (paths default to the secrets the service still lacks, e.g. `pass`, or an `oauth2` block's two; a map path is named with its key, e.g. `headers.authorization`) and returns `request_id`, `fields` (path, label, description, set), `expires_in` and `origin_url` (a signed page to give the user), plus a `secret-input` widget pointer in `_meta` (render with `show_widget(widget="secret-input", params=<_meta.data>)`). One successful submission, expires after `YAP_SECRET_REQUEST_TTL_SECONDS`, and closes when the service's config changes; the requester's `edit_services` is re-checked on submit. A driver declaring `writes.items` / `writes.files` also needs `edit_items` / `edit_files` to author (REST too): its runs write with the service's authority. The form shows where its secrets are sent (`destinations` in the widget data: the settings they are bound to, pins filled in). **Approval:** a service created over MCP, or changed there in params, pins, actions, settings or set secrets, is off (`approved: false`) until a person approves it; `run_service` and schedules refuse it (403, "waiting for approval"). `approval_request` `{id}` returns `request_id`, `service`, `expires_in`, `origin_url`, plus a `service-approve` widget pointer in `_meta` whose data is only `{request_id, token}` (render with `show_widget(widget="service-approve", params=<_meta.data>)`); the person approves on that page with a user access key and `edit_services`. Renames, a no-op update and a secret entered through the form keep the approval. Full flow: `docs/mcp-service-authoring.md` and `docs/service-approval.md`.

**Driver contracts and config schemas** (read-only, any valid credential): `GET /v1/drivers` → `{data: [...]}` sorted by name, `GET /v1/drivers/:name` → one or 404; MCP `list_drivers` `{names?}` returns the same. Each entry: `name`, `description`, `egress`, `reads`, `writes`, `actions` (name, description, params or null when the service record declares them, `timeoutMs`), `configDoc`, and `configSchema` — `{jsonSchema, secrets: [{path, label, description?, boundTo?}], destinations?: [{label, setting? | param?, actions?}]}` or null; `boundTo` lists the settings that decide where the secret is sent, `destinations` where a service sends data (http `url`; mail `imap`, `smtp`, `oauth2.token_url`, and the `to`/`cc`/`bcc` of `send`). Secret paths are dot paths from the config root; `*` stands for every key of a map (`headers.*`). Built-ins: `http` marks `headers.*`; `mail` marks `pass`, `oauth2.client_secret`, `oauth2.refresh_token`. Never any service's config values. Contract: `docs/driver-config-schema.md`.

**Drivers** are also installed per instance, not authored over REST: `yap driver add <npm-spec>` / `remove <name>` / `list`, into `YAP_DRIVERS_DIR` (default `./drivers`). A driver is trusted code running in-process — the SSRF guard defends hostile *parameters* through an honest driver, not a driver written to misbehave. Explicit surfaces are injected on the run context: `reads: { files: true }` gives `ctx.reader.readFile(refOrId)` for finalized files in the run bundle (`stream()` preferred; `bytes()`/`text()` capped), `reads: { items: true }` gives `ctx.reader.getItems(ids)` for items in the run bundle, `writes: { items: true }` gives `ctx.writer.createItems(...)` plus `ctx.writer.updateItems([{id, set?, edits?}])`, and `writes: { files: true }` gives `ctx.writer.writeFile({name, mimeType?, bytes})` returning a `file://` ref; undeclared read/write surfaces are `null` unless another surface created the handle, in which case undeclared handle methods reject.

**Legacy hook surface (kept byte-compatible until 1.0):** a hook is exactly a service on the `http` driver, viewed through the old four-field shape (`id`, `name`, `description`, `params` — no `driver`/`action`).

| Method & path | Notes |
|---|---|
| `GET/POST /v1/bundles/:id/hooks` | list / create (forces `driver: "http"`; body takes `transport` where a service body takes `config`) |
| `PATCH/DELETE /v1/hooks/:id` | no GET single, same as services |
| `POST /v1/hooks/:id/fire` | synchronous: waits past the driver's own timeout and returns `{status, body}` or throws — never a run id |

`load_bundle` likewise returns both `services` and a legacy `hooks` projection (http-driver services only). MCP: `run_service`/`get_run`/`list_runs` (and the schedule tools) are current; `fire_hook` is the deprecated alias. A few error strings changed under these compatible surfaces: a missing hook/service 404s as `service <id> not found` (was `hook <id> not found`); the SSRF guard says "service destination…" (was "hook destination…"); an unlisted call parameter says `unknown parameter "…"`.

### Users, keys, OAuth (operator lane)
| Method & path | Notes |
|---|---|
| `POST /v1/users` | **sysadmin** — provision a user. Body `{name, externalId?, deniedCapabilities?, email?, providerLoginOnly?}` (`email` invites them: the first provider login with that address, verified by the provider or trusted for it, claims the account; an address another user already has is a `409` `conflict` naming that user in `details.userId`; `providerLoginOnly: true` makes a user who logs in only through a provider). Creates the user, their personal space and an initial key as one transaction; `201` with `{user, personalSpaceId, initialKey}` (the key is shown once). No key is made, and `initialKey` is absent, for a `providerLoginOnly` user or where `YAP_KEY_LOGIN=false`. With an `externalId` that already names a user, nothing is created: `200` with `{user, personalSpaceId}` and no key |
| `GET /v1/users` | **sysadmin** — paginated list; `?externalId=…` narrows it to the one user carrying that id (an empty `data` if none) |
| `GET/DELETE /v1/users/:id` | **sysadmin** |
| `PATCH /v1/users/:id` | **sysadmin** — set the user's account-level restrictions, email and provider-login-only flag. Body `{deniedCapabilities?: [...], email?: "…" \| null, providerLoginOnly?: boolean}`, at least one; the list is replaced whole (`[]` clears it), `null` clears the email, and an address another user has is a `409`; `providerLoginOnly: true` refuses the user's access keys everywhere and deletes the OAuth grants their keys authorized; returns the user. Nothing else about a user is patchable: any other field is a `400` |
| `POST /v1/users/:id/keys` | **sysadmin** — issue an access key for the user. Body `{name?, scope?}` (the body itself is optional; `scope` as below); `201` with `{id, name, issuer: "sysadmin", scope, createdAt, key}` — the key is shown once and stored only as a hash |
| `GET /v1/users/:id/keys` | **sysadmin** — the user's active keys as `{data: [{id, name, issuer, scope, createdAt}]}`; metadata only, never a key or its hash |
| `DELETE /v1/users/:id/keys/:keyId` | **sysadmin** — revoke one of the user's keys, with the OAuth authorizations made with it. `404` if the user does not exist or does not hold that active key |
| `GET/POST /v1/keys`, `POST /v1/keys/:id/rotate`, `DELETE /v1/keys/:id` | user's own access keys; same key shape, `POST` (body `{name?, scope?}`) and rotate return it with the secret `key` once. Refused (403) to a scoped key and to a non-admin OAuth token. Creating and rotating (and the sysadmin's `POST /v1/users/:id/keys`) are refused (403, `details.reason` `key_login_off` or `provider_login_only`) where key login is off for the instance or the user; revoking always works |
| `GET /v1/oauth/grants`, `DELETE /v1/oauth/grants/:id` | connected apps, each `{id, client, scope, createdAt, lastUsedAt, expiresAt}` (`expiresAt` set only for a grant made after a provider login); also self-served at `/oauth/connections` |
| `GET /v1/users/:id/oauth-grants`, `DELETE /v1/users/:id/oauth-grants/:grantId` | **sysadmin** — any user's connected apps, and revoking one, whatever the user's own `deniedCapabilities` |

A user is `{id, name, externalId, deniedCapabilities, email, providerLoginOnly, createdAt}` (`email` lowercased, unique per instance when set, `null` unless the operator set one or a provider sign-up created the user; it matches a first provider login to an invite and lets a grant name its grantee, and never recognises a returning login); `GET /v1/whoami` and the MCP `whoami` tool report the caller's own `externalId`, `deniedCapabilities` and `providerLoginOnly` alongside `id` and `name`, plus `keyScope` (`{role}`) when the caller authenticated with a scoped key — absent otherwise. `externalId` is an optional correlation id for whatever system created the user — Yap attaches no meaning to it. It is a non-empty string of at most 255 characters, matched exactly, unique per instance when set, `null` otherwise, and fixed at creation (nothing updates it). It is what makes `POST /v1/users` safe to retry: a repeated create with the same `externalId` is a read — same user back, the `name` in the repeated body ignored, no key minted, nothing written — and concurrent creates with the same `externalId` yield exactly one user (one `201`, the rest `200`). Without an `externalId` every call creates a new user.

`deniedCapabilities` is the operator's per-user deny list of account-level capabilities — the things a user does with their own account rather than inside a space. There are two: `manage_keys` (every self-service credential operation as one switch: `GET/POST /v1/keys`, rotate, `DELETE /v1/keys/:id`, `GET /v1/oauth/grants`, `DELETE /v1/oauth/grants/:id` and the `/oauth/connections` page) and `create_spaces` (`POST /v1/spaces` and the MCP `space_create` tool). It is `[]` for every user unless the sysadmin sets it, on `POST /v1/users` or with `PATCH /v1/users/:id`; any subset is accepted, in any order, and reads back deduplicated as `manage_keys` then `create_spaces`. Anything that is not an array of those names is a `400` (`details.unknown` lists the offending values, `details.allowed` the valid ones) and writes nothing. On a repeated `POST /v1/users` with an existing `externalId` the list in the body is ignored like `name` is. A denied operation is a `403` `forbidden` with message `account capability <name> is denied for this user` and `details: {capability, decidedBy: "account_restriction"}`; over MCP the tool error carries the same code, message and details. The denial is read on every call, so it binds whatever the request authenticated with — any access key, any OAuth token including `role:admin` — and takes effect on the user's next request with no token reissued and no MCP session reconnected. It only removes authority: no key, token or content is revoked or deleted, and clearing it restores just what the credential's own scope and grants allow (a `role:member` token still cannot manage keys). It does not touch user docs, grants, or work in spaces the user already reaches, and it does not reach the sysadmin lane: `/v1/users/:id/keys` works the same for a restricted user, and is then the only way their keys are issued, listed or revoked. A user denied `manage_keys` therefore cannot cut off a compromised key or app themself — that is the operator's to do. Two things stay outside it, because neither is the user managing credentials: authorizing a new app on the consent screen (the token it gets is bound by the same denials), and an app giving up its own token at `/oauth/revoke`.

An access key is `{id, name, issuer, scope, createdAt}`. `issuer` records who issued it and is set once: `user` for a key the user minted over `POST /v1/keys` or got from rotating any key, `sysadmin` for the initial key from `POST /v1/users` and for keys issued over `POST /v1/users/:id/keys`. It is a fact about the key's origin, not a kind of key: an unscoped sysadmin-issued key carries the same full authority as the user, always appears in the user's own `GET /v1/keys` with its `issuer` and `name`, and can be rotated or revoked by the user like any other (rotation keeps the `name` and yields a `user` key). The sysadmin key lane is how an operator reaches a user whose keys are lost — issue a new one — or cuts off a compromised key; when and why to do either is the operator's or client's policy. On upgrade, existing keys are backfilled: a user's initial key (named `default`, created with the user) becomes `sysadmin`, every other key `user`.

Key login can be switched off (`docs/key-login.md`): for the whole instance with `YAP_KEY_LOGIN=false`, or for one user with `providerLoginOnly`. A refused key gets `401` on `/v1` with `details.reason` (`key_login_off`: "Access keys can't be used on this instance. Connect with {provider}."; `provider_login_only`: the account logs in only with its provider), the same message on `/mcp` (bearer and `?key=`), and a "Sign in with {provider}" message on the pages. OAuth tokens from a provider login keep working; tokens of a grant made with a refused key do not (setting a user's flag deletes those grants; the instance switch only refuses them). The sysadmin key is unaffected.

`scope` is `null` for a full key, which carries its user's whole authority, or `{"role": "admin" | "member" | "read-only"}` for a scoped key: the same role masks as an OAuth token, applied over the user's grants (read-only = `read_items` / `read_files`; member = the content capabilities, services included, plus `create_bundles` / `edit_bundles`; admin masks nothing). It is fixed at creation and kept on rotation. Only `role` is accepted: a scope with `spaces` or `bundles`, an unknown role or any other field is a `400` — a key scope limits what, never where; use a separate user with grants to limit where. A denial by the mask is a `403` with `details.decidedBy: "key_scope"`. At every role a scoped key cannot manage keys or connected apps (`403`), creates spaces only at `admin`, and is refused (`401`, "This key is limited. Log in with a full key.") by the consent screen, `/oauth/connections`, the secret form and the approve page. `deniedCapabilities` apply to it as to any key. A schedule created with a scoped key runs as its owner, like any schedule, and keeps running after that key is revoked: delete it as well. Every key from before the column is a full key.

OAuth: each instance is an OAuth 2.1 authorization server (PKCE, dynamic client registration, discovery). Scopes: `role:admin|member|read-only` + optional `space:<id>`/`bundle:<id>`; default `member`. Tokens are delegations of an access key — revoking the key revokes them. The authorize screen authenticates by a full (unscoped) access key (Yap has no passwords), or by a login provider the operator configured (`YAP_OIDC_*`, `docs/oidc-login.md`): a grant made that way has no key, belongs to the user and ends `YAP_OIDC_GRANT_MAX_DAYS` (default 30) after it was made. `YAP_OAUTH_MAX_ROLE` caps the role the screen offers. `YAP_BASE_URL` must be the externally reachable origin; https is required except on loopback, so the default `http://localhost:8787` works out of the box for local clients.

## Permissions model

Capability-based: roles (e.g. `read_items`, `edit_items`, `edit_docs`, `read_files`, `edit_files`, `run_services`, `edit_services`, `manage_roles`) granted as allow/deny rows on spaces and bundles. A grant row is `{id, userId, userName, userEmail, resourceType, resourceId, capability, effect, createdAt}`: `userName` and `userEmail` (`null` when the user has none) name the grantee, so whoever holds `manage_roles` sees who has what. MCP `list_grants` and `grant_role` return the same rows; `grant_role` takes `user_id` or `email`, exactly one. The pre-services names `fire_hooks`/`edit_hooks` are still accepted anywhere a capability is read or written — they normalize to `run_services`/`edit_services`. Resolution: most-specific wins — bundle beats space, deny beats allow at the same level, absence inherits, default deny. Personal spaces accept no grants; the owner holds all capabilities.

## CLI

```
Instance:  init [--version v|branch] [--port n] [--no-install] | create <dir> [--user n] | upgrade [version|branch] [--check] [--no-restart] [--skip-backup] | preflight
Data:      backup [--out <path>] | backup list | restore <name|path> | --latest [--force]
Run:       serve (foreground) | start/stop/status | logs [-n N] [-f] | daemon install|uninstall [--name]
Manage:    user create <name> [--save] | api <METHOD> </path> [body|-] [--sysadmin]
           users list|delete | keys list|create [--role r]|rotate|delete
           spaces list|show|create|delete | bundles list <spaceId> | show <id>
           items query <bundleId> --type t [--filters json] | get <bundleId> <ids>
           driver add <npm-spec> | remove <name> | list
           connections list | revoke <id>      (--json on any list)
```

Credentials: sysadmin + master keys live in the instance's `.env` (generated by `init`, printed once); the CLI's user access key lives in `.yap/credentials.json` (0600, shape `{"accessKey", "userId", "userName"}`). Logs at `.yap/logs/yap.log`, pid at `.yap/yap.pid`. `yap create <dir>` accepts any path (resolved absolute) and runs init + start + user create --save (default user `admin`).

`yap daemon install` writes the unit and prints activation commands — it does not stop a `yap start` process, so `yap stop` first. `<name>` defaults to the instance directory's basename (`--name` overrides). Both unit types auto-restart on crash (`KeepAlive` / `Restart=always`). macOS: LaunchAgent at `~/Library/LaunchAgents/tools.yap.<name>.plist`, activated with `launchctl load -w <path>` (starts at login; use a root LaunchDaemon yourself if you need boot-time start on a headless Mac). Linux: systemd user unit at `~/.config/systemd/user/yap-<name>.service` (`systemctl --user enable --now` + `loginctl enable-linger` to survive logout), or a system unit in `/etc/systemd/system` when run as root.

## Server configuration (env, `.env` fallback)

| Variable | Default | Purpose |
|---|---|---|
| `YAP_SYSADMIN_KEY` / `YAP_MASTER_KEY` | required | operator credential (users and their keys) / base64 32-byte encryption+signing key |
| `YAP_PORT` / `YAP_HOST` / `YAP_BASE_URL` | `8787` / `0.0.0.0` / `http://localhost:8787` | listener + minted-link base |
| `YAP_DB` | `sqlite` | `sqlite` or `postgres` (`YAP_DATABASE_URL`) |
| `YAP_SQLITE_PATH` | `./data/yap.db` | |
| `YAP_BLOB` | `fs` | `fs` (`YAP_BLOB_FS_ROOT`, default `./data/blobs`) or `s3` (`YAP_S3_*`) |
| `YAP_MAX_FILE_SIZE_BYTES` | 50 MiB | upload cap |
| `YAP_MIME_ALLOWLIST` | `*` | comma list, `type/*` patterns |
| `YAP_SIDELOAD_ENABLED` / `YAP_SIDELOAD_TIMEOUT_MS` | `true` / 60000 | `false` turns sideloading off instance-wide / time budget for one sideload |
| `YAP_KEY_LOGIN` | `true` | `false` switches access-key login off instance-wide: user keys are refused on pages, `/v1` and `/mcp` (`401`, `details.reason: "key_login_off"`) and none can be made; needs a login provider |
| `YAP_UPLOAD_TTL_SECONDS` / `YAP_DOWNLOAD_TTL_SECONDS` / `YAP_WIDGET_TOKEN_TTL_SECONDS` / `YAP_SECRET_REQUEST_TTL_SECONDS` | 600 / 14400 / 600 / 600 | link/token lifetimes; the last is how long a secret form or a service approve page stays open |
| `YAP_HTTP_TIMEOUT_MS` / `YAP_EGRESS_ALLOW_HOSTS` | 30000 / empty | http driver timeout / SSRF allowlist of exact hosts and IPs |
| `YAP_RUN_WAIT_CAP_MS` | 25000 | ceiling on a caller's `wait_ms` when starting a run |
| `YAP_RUN_TIMEOUT_CAP_MS` | unset (uncapped) | operator ceiling on any driver action's own timeout |
| `YAP_RUN_RETENTION_DAYS` | 7 | terminal runs older than this are pruned |
| `YAP_DRIVERS_DIR` | `./drivers` | installed service drivers, one package folder each; loaded at startup |
| `YAP_ENV_FILE` | — | explicit env-file path (real env vars always win) |
