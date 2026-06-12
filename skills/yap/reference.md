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

### Docs (one per bundle) & user docs
| Method & path | Body |
|---|---|
| `GET /v1/bundles/:id/docs` | |
| `PUT /v1/bundles/:id/docs` | `{"docs": "<markdown>"}` |
| `GET/POST /v1/user-docs` | create: `{"name", "content"?, "autoload"?}` |
| `GET/PATCH/DELETE /v1/user-docs/:id` | |

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
| `text` | string | `{pattern}` — regex via `RegExp.test`; anchor `^…$` for full match |
| `number` | number | `{min, max, decimals}` — inclusive bounds; default 2 decimals, excess precision rejected |
| `boolean`, `date` | bool / ISO date | — |
| `item` | `item://<id>` (same bundle) | `{itemType}` — referent must be of that type |
| `file` | `file://<id>` (finalized file) | — |
| any with `multi: true` | ordered array | `{minItems, maxItems}` |

Schemas are freely mutable (EAV): renames touch no values, removals drop values, tightened configs are not retroactive.

### Items
| Method & path | Shape |
|---|---|
| `POST /v1/bundles/:id/items` | `{"itemType": "Todo", "items": [{...}, ...]}` → 201 |
| `GET /v1/bundles/:id/items?itemType=T` | query; or `?ids=a,b,c` to fetch by id |
| `PATCH /v1/items/:id` | `{"set": {"prop": value}}` |
| `DELETE /v1/items/:id` | |

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

### Hooks
| Method & path | Notes |
|---|---|
| `GET /v1/bundles/:id/hooks` | name, description, declared params — transport never returned |
| `POST /v1/bundles/:id/hooks` | **authoring is REST-only by design** — URL/method/headers/secrets, encrypted at rest |
| `GET/PATCH/DELETE /v1/hooks/:id` | |
| `POST /v1/hooks/:id/fire` | the only hook verb agent surfaces get |

Private/link-local destinations denied unless allowlisted via `YAP_HOOK_ALLOW_HOSTS`. No automatic retries; timeout `YAP_HOOK_TIMEOUT_MS` (30 s default).

### Users, keys, OAuth (operator lane)
| Method & path | Notes |
|---|---|
| `POST /v1/users` | **sysadmin** — provision a user |
| `GET /v1/users`, `GET/DELETE /v1/users/:id` | **sysadmin** |
| `GET/POST /v1/keys`, `POST /v1/keys/:id/rotate`, `DELETE /v1/keys/:id` | user's own access keys |
| `GET /v1/oauth/grants`, `DELETE /v1/oauth/grants/:id` | connected apps; also self-served at `/oauth/connections` |

OAuth: each instance is an OAuth 2.1 authorization server (PKCE, dynamic client registration, discovery). Scopes: `role:admin|member|read-only` + optional `space:<id>`/`bundle:<id>`; default `member`. Tokens are delegations of an access key — revoking the key revokes them. The authorize screen authenticates by access key (Yap has no passwords). `YAP_BASE_URL` must be the externally reachable origin; https is required except on loopback, so the default `http://localhost:8787` works out of the box for local clients.

## Permissions model

Capability-based: roles (e.g. `read_items`, `edit_items`, `edit_docs`, `read_files`, `edit_files`, `fire_hooks`, `edit_hooks`, `manage_roles`) granted as allow/deny rows on spaces and bundles. Resolution: most-specific wins — bundle beats space, deny beats allow at the same level, absence inherits, default deny. Personal spaces accept no grants; the owner holds all capabilities.

## CLI

```
Instance:  init [--version v] [--port n] [--no-install] | create <dir> [--user n] | upgrade [version]
Run:       serve (foreground) | start/stop/status | logs [-n N] [-f] | service install|uninstall
Manage:    user create <name> | api <METHOD> </path> [body|-] [--sysadmin]
           users list|delete | keys list|create|rotate|delete
           spaces list|show|create|delete | bundles list <spaceId> | show <id>
           items query <bundleId> --type t [--filters json] | get <bundleId> <ids>
           connections list | revoke <id>      (--json on any list)
```

Credentials: sysadmin + master keys live in the instance's `.env` (generated by `init`, printed once); the CLI's user access key lives in `.yap/credentials.json` (0600, shape `{"accessKey", "userId", "userName"}`). Logs at `.yap/logs/yap.log`, pid at `.yap/yap.pid`. `yap create <dir>` accepts any path (resolved absolute) and runs init + start + user create (default user `admin`).

`yap service install` writes the unit and prints activation commands — it does not stop a `yap start` process, so `yap stop` first. `<name>` defaults to the instance directory's basename (`--name` overrides). Both unit types auto-restart on crash (`KeepAlive` / `Restart=always`). macOS: LaunchAgent at `~/Library/LaunchAgents/tools.yap.<name>.plist`, activated with `launchctl load -w <path>` (starts at login; use a root LaunchDaemon yourself if you need boot-time start on a headless Mac). Linux: systemd user unit at `~/.config/systemd/user/yap-<name>.service` (`systemctl --user enable --now` + `loginctl enable-linger` to survive logout), or a system unit in `/etc/systemd/system` when run as root.

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
| `YAP_UPLOAD_TTL_SECONDS` / `YAP_DOWNLOAD_TTL_SECONDS` | 600 / 300 | link lifetimes |
| `YAP_HOOK_TIMEOUT_MS` / `YAP_HOOK_ALLOW_HOSTS` | 30000 / empty | hook firing |
| `YAP_ENV_FILE` | — | explicit env-file path (real env vars always win) |
