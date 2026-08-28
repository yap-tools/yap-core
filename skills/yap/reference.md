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
| `GET/POST /v1/spaces/:id/grants`, `DELETE …/grants/:grantId` | role grants on a space |
| `GET/POST /v1/bundles/:id/grants`, `DELETE …/grants/:grantId` | role grants on a bundle |

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
| `boolean`, `date` | bool / ISO date | — |
| `item` | `item://<id>` (same bundle) | `{itemType}` — referent must be of that type |
| `file` | `file://<id>` (finalized file) | — |
| any with `multi: true` | ordered array | `{minItems, maxItems}` |
| single-valued `text` / `number` | — | `{unique}` — no two items of the type may share a value; enabling it on a property with existing duplicates is rejected |

Schemas are freely mutable (EAV): renames touch no values, removals drop values, tightened configs are not retroactive.

### Items
| Method & path | Shape |
|---|---|
| `POST /v1/bundles/:id/items` | `{"itemType": "Todo", "items": [{...}, ...]}` → 201 |
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

Ops are applied sequentially; if any fails, the entire update is rejected.

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

Then: `GET /v1/bundles/:id/files` (list), `GET /v1/files/:id/link` (mint expiring download link — always resolve `file://` refs this way before showing a user), `DELETE /v1/files/:id` (blob deleted immediately).

### Services & runs
| Method & path | Notes |
|---|---|
| `GET /v1/bundles/:id/services` | id, name, description, driver, actions (only the service's *allowed* actions, each with its callable — unpinned — params); config never returned |
| `POST /v1/bundles/:id/services` | **authoring is REST-only by design** — `{"name", "description"?, "driver"?, "params"?, "pins"?, "actions"?, "config"}`; `driver` defaults to `http` (built-ins: `http`, `mail`); `actions` is an allowlist of the driver's action names (omit = all; one allowed action becomes the implicit default); config is driver-shaped and encrypted at rest |
| `PATCH/DELETE /v1/services/:id` | patch: `{"name"?, "description"?, "params"?, "pins"?, "actions"?, "config"?}` (`pins: null` clears the pin set; `actions: null` clears the allowlist) |
| `POST /v1/services/:id/run` | `{"action"?, "params"?, "wait_ms"?}` → a run record; `wait_ms` clamped to `YAP_RUN_WAIT_CAP_MS` (25000 default) |
| `GET /v1/runs/:id` | one run: status (`queued\|running\|succeeded\|failed`), the caller's params, result/error, bundle I/O trail (file reads and item writes as metadata) |
| `GET /v1/bundles/:id/runs` | `?service=` filter, `cursor`, `limit`; newest first |

Service egress (the `http` driver, or any driver declaring `egress: true`) denies private/link-local destinations unless allowlisted via `YAP_HOOK_ALLOW_HOSTS` (still that name). The `http` driver's own timeout is `YAP_HOOK_TIMEOUT_MS` (30 s default, still that name); no automatic retries.

**Built-in drivers:** `http` (one action, `fire`: the configured request with `{{param}}` substitution) and `mail` (one IMAP/SMTP account; actions `folders`, `search`, `read`, `mark`, `send`, `draft` — a service allowlists which; recipients are `to`/`cc`/`bcc`, and pinning any one of them locks the others, so a pinned `to` fixes where mail goes; `draft` writes into the account's Drafts folder for a human to send). Mail config: `user` + `pass` or `oauth2`, `from`, `imap`/`smtp: {host, port, security?}`; a wrong password is rejected at authoring. Full reference: `docs/mail-driver.md`.

**Drivers** are also installed per instance, not authored over REST: `yap driver add <npm-spec>` / `remove <name>` / `list`, into `YAP_DRIVERS_DIR` (default `./drivers`). A driver is trusted code running in-process — the SSRF guard defends hostile *parameters* through an honest driver, not a driver written to misbehave. Explicit surfaces are injected on the run context: `reads: { files: true }` gives `ctx.reader.readFile(refOrId)` for finalized files in the run bundle (`stream()` preferred; `bytes()`/`text()` capped), and `writes: { items: true }` gives `ctx.writer.createItems(...)`; undeclared surfaces are `null`.

**Legacy hook surface (kept byte-compatible until 1.0):** a hook is exactly a service on the `http` driver, viewed through the old four-field shape (`id`, `name`, `description`, `params` — no `driver`/`action`).

| Method & path | Notes |
|---|---|
| `GET/POST /v1/bundles/:id/hooks` | list / create (forces `driver: "http"`; body takes `transport` where a service body takes `config`) |
| `PATCH/DELETE /v1/hooks/:id` | no GET single, same as services |
| `POST /v1/hooks/:id/fire` | synchronous: waits past the driver's own timeout and returns `{status, body}` or throws — never a run id |

`load_bundle` likewise returns both `services` and a legacy `hooks` projection (http-driver services only). MCP: `run_service`/`get_run`/`list_runs` are current; `fire_hook` is the deprecated alias. A few error strings changed under these compatible surfaces: a missing hook/service 404s as `service <id> not found` (was `hook <id> not found`); the SSRF guard says "service destination…" (was "hook destination…"); an unlisted call parameter says `unknown parameter "…"`.

### Users, keys, OAuth (operator lane)
| Method & path | Notes |
|---|---|
| `POST /v1/users` | **sysadmin** — provision a user |
| `GET /v1/users`, `GET/DELETE /v1/users/:id` | **sysadmin** |
| `GET/POST /v1/keys`, `POST /v1/keys/:id/rotate`, `DELETE /v1/keys/:id` | user's own access keys |
| `GET /v1/oauth/grants`, `DELETE /v1/oauth/grants/:id` | connected apps; also self-served at `/oauth/connections` |

OAuth: each instance is an OAuth 2.1 authorization server (PKCE, dynamic client registration, discovery). Scopes: `role:admin|member|read-only` + optional `space:<id>`/`bundle:<id>`; default `member`. Tokens are delegations of an access key — revoking the key revokes them. The authorize screen authenticates by access key (Yap has no passwords). `YAP_BASE_URL` must be the externally reachable origin; https is required except on loopback, so the default `http://localhost:8787` works out of the box for local clients.

## Permissions model

Capability-based: roles (e.g. `read_items`, `edit_items`, `edit_docs`, `read_files`, `edit_files`, `run_services`, `edit_services`, `manage_roles`) granted as allow/deny rows on spaces and bundles. The pre-services names `fire_hooks`/`edit_hooks` are still accepted anywhere a capability is read or written — they normalize to `run_services`/`edit_services`. Resolution: most-specific wins — bundle beats space, deny beats allow at the same level, absence inherits, default deny. Personal spaces accept no grants; the owner holds all capabilities.

## CLI

```
Instance:  init [--version v|branch] [--port n] [--no-install] | create <dir> [--user n] | upgrade [version|branch] [--no-restart] [--skip-backup]
Data:      backup [--out <path>] | backup list | restore <name|path> | --latest [--force]
Run:       serve (foreground) | start/stop/status | logs [-n N] [-f] | daemon install|uninstall [--name]
Manage:    user create <name> | api <METHOD> </path> [body|-] [--sysadmin]
           users list|delete | keys list|create|rotate|delete
           spaces list|show|create|delete | bundles list <spaceId> | show <id>
           items query <bundleId> --type t [--filters json] | get <bundleId> <ids>
           driver add <npm-spec> | remove <name> | list
           connections list | revoke <id>      (--json on any list)
```

Credentials: sysadmin + master keys live in the instance's `.env` (generated by `init`, printed once); the CLI's user access key lives in `.yap/credentials.json` (0600, shape `{"accessKey", "userId", "userName"}`). Logs at `.yap/logs/yap.log`, pid at `.yap/yap.pid`. `yap create <dir>` accepts any path (resolved absolute) and runs init + start + user create (default user `admin`).

`yap daemon install` writes the unit and prints activation commands — it does not stop a `yap start` process, so `yap stop` first. `<name>` defaults to the instance directory's basename (`--name` overrides). Both unit types auto-restart on crash (`KeepAlive` / `Restart=always`). macOS: LaunchAgent at `~/Library/LaunchAgents/tools.yap.<name>.plist`, activated with `launchctl load -w <path>` (starts at login; use a root LaunchDaemon yourself if you need boot-time start on a headless Mac). Linux: systemd user unit at `~/.config/systemd/user/yap-<name>.service` (`systemctl --user enable --now` + `loginctl enable-linger` to survive logout), or a system unit in `/etc/systemd/system` when run as root.

## Server configuration (env, `.env` fallback)

| Variable | Default | Purpose |
|---|---|---|
| `YAP_SYSADMIN_KEY` / `YAP_MASTER_KEY` | required | provisioning credential / base64 32-byte encryption+signing key |
| `YAP_PORT` / `YAP_HOST` / `YAP_BASE_URL` | `8787` / `0.0.0.0` / `http://localhost:8787` | listener + minted-link base |
| `YAP_DB` | `sqlite` | `sqlite` or `postgres` (`YAP_DATABASE_URL`) |
| `YAP_SQLITE_PATH` | `./data/yap.db` | |
| `YAP_BLOB` | `fs` | `fs` (`YAP_BLOB_FS_ROOT`, default `./data/blobs`) or `s3` (`YAP_S3_*`) |
| `YAP_MAX_FILE_SIZE_BYTES` | 50 MiB | upload cap |
| `YAP_MIME_ALLOWLIST` | `*` | comma list, `type/*` patterns |
| `YAP_UPLOAD_TTL_SECONDS` / `YAP_DOWNLOAD_TTL_SECONDS` / `YAP_WIDGET_TOKEN_TTL_SECONDS` | 600 / 14400 / 600 | link/token lifetimes |
| `YAP_HOOK_TIMEOUT_MS` / `YAP_HOOK_ALLOW_HOSTS` | 30000 / empty | http driver timeout / SSRF allowlist (still those names) |
| `YAP_RUN_WAIT_CAP_MS` | 25000 | ceiling on a caller's `wait_ms` when starting a run |
| `YAP_RUN_TIMEOUT_CAP_MS` | unset (uncapped) | operator ceiling on any driver action's own timeout |
| `YAP_RUN_RETENTION_DAYS` | 7 | terminal runs older than this are pruned |
| `YAP_DRIVERS_DIR` | `./drivers` | installed service drivers, one package folder each; loaded at startup |
| `YAP_ENV_FILE` | — | explicit env-file path (real env vars always win) |
