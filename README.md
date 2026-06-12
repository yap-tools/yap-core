<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo-light.svg" alt="Yap" width="260">
  </picture>
</p>

<p align="center">
  <strong>Navigable context for AI agents — self-hosted, API-first, MCP-native.</strong>
</p>

<p align="center">
  <a href="https://github.com/yap-tools/yap-core/actions/workflows/ci.yml"><img src="https://github.com/yap-tools/yap-core/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>

---

Yap is an API-first, self-hosted, open-source system for building **navigable
contexts** that any AI agent can connect to over MCP. There is no UI: a REST
API is the entire product surface. It runs **on a single machine by
default** — SQLite and local-disk file storage, no external dependencies —
and the same codebase swaps to Postgres and S3-compatible object storage by
configuration alone.

Context is modeled as a filesystem-like tree an agent can descend:

```
context (root)
└── space            (many per system)
    └── bundle       (many per space)
        ├── docs        (one document; binding operating instructions)
        ├── item-types  (one or more schemas; each holds many items)
        ├── files       (many static files)
        └── hooks       (many named outbound calls)
```

Spaces do not nest. Combining bundles is a **runtime act** — a session loads
several bundles into an ephemeral working set; bundles are never merged on
disk. The one thing outside the tree is **user docs**: account-level guidance
that travels with a user across all their spaces (optionally autoloading at
session start).

## Quickstart

Install the CLI once (Node 22+ is the only prerequisite — the CLI package
has **zero dependencies**, ships prebuilt, no registry and no compiler
involved), then create an instance:

```sh
npm install -g https://github.com/yap-tools/yap-core/releases/latest/download/yap-cli.tgz

mkdir my-yap && cd my-yap
yap init                  # scaffold + install the server into this directory
yap start                 # serve it in the background
yap user create ada       # create your user; the CLI keeps the access key
```

Or all of that in one go: `yap create my-yap --user ada`.

**An instance is a directory.** `yap init` writes a `.env` (generated
**sysadmin key** and master key — printed once, never overwritten), a `data/`
folder for the database and files, and — the one network step — vendors the
Yap server from GitHub Releases (prebuilt) into the directory's own
`node_modules` at the latest release (`--version v0.2.0` to pin). The global
`yap` is just the manager:
`serve`/`start` always run *the directory's* copy, so every instance keeps
its own version, keys, data, and port (`--port` at init). Run as many
instances as you like — one directory each; `yap upgrade` moves a single
instance forward when you choose.

`yap user create` is the bootstrap: it reads the sysadmin key from `.env`,
creates the user over the instance's own API, and stores the returned access
key in `.yap/credentials.json` (0600). From then on the CLI — like every
other client — is just an API consumer authenticated as that user. Connect
any MCP client to `http://localhost:8787/mcp` with the same key as a bearer
token (or `?key=` as a fallback for URL-only clients — bearer is preferred;
query strings leak into logs, and Yap redacts keys from its own logs for
exactly that reason).

The server listens on `:8787` (one process, one port): REST under `/v1`, MCP
at `/mcp`, origin-hosted widget pages under `/w/`, health at `/health`.

## Teach your agent Yap

A coding agent that hasn't seen Yap will guess at endpoints. The
[Yap skill](skills/yap/SKILL.md) fixes that — one command installs it into
Claude Code, Cursor, Copilot, and most other agents via
[skills.sh](https://skills.sh):

```sh
npx skills add yap-tools/yap-core
```

## The CLI

Everything after bootstrap goes through the instance's HTTP API — the CLI
never touches the database, so it has exactly the authority of the credential
it presents. Run commands from inside the instance directory:

```sh
yap status                      # pid, health, server version
yap logs -f                     # follow .yap/logs/yap.log
yap spaces list                 # ergonomic commands (tables; --json for raw)
yap keys rotate <id>
yap connections list            # connected OAuth apps; revoke <grantId>
yap api GET /v1/spaces          # raw passthrough — the entire /v1 surface
yap api POST /v1/spaces '{"name": "Docs"}'
yap users list                  # sysadmin-lane commands read .env on demand
```

The manage commands also work against an instance running elsewhere — pass
`--url`/`--key`, or set `YAP_URL`/`YAP_KEY`:

```sh
export YAP_URL=https://yap.example.com
export YAP_KEY=yk_...                   # a key minted on that instance
yap spaces list

yap --url https://yap.example.com --key yk_... api GET /v1/spaces   # one-shot
```

The key is any access key from the remote instance (`yap keys create` there,
or the one printed by `yap user create`). Remote mode is deliberately
stateless and strict: the local `.env` and `.yap/` are never read (a
credential never travels to a host it wasn't given for), sysadmin-lane
commands (`users …`, `user create`, `api --sysadmin`) refuse and must run on
the instance host, and lifecycle commands (`start`, `logs`, `upgrade`, …)
refuse rather than silently ignoring the flag. A remote health check is just
`yap api GET /health`.

Three ways to run an instance, by how much you need it to survive:

| | Verbs | Survives logout | Survives reboot/crash |
|---|---|---|---|
| Foreground | `yap` / `yap serve` | no | no |
| Detached | `yap start` / `stop` | yes | no |
| Supervised | `yap service install` | yes | yes |

`yap service install` generates a systemd unit (Linux) or launchd plist
(macOS) pointing at the instance directory and prints the activation
commands — the OS owns supervision; the CLI deliberately is not a process
manager. `yap upgrade [version]` reinstalls the vendored server and restarts
a running instance.

Running from a checkout: the repo root is itself an instance directory
(`cp .env.example .env`, then `npm run dev` — serve runs in-process when no
vendored server is present). Config comes from the environment, with an env
file as fallback — `YAP_ENV_FILE` if set, else `./.env` (Node's built-in
parser, no dependency). Real environment variables override file entries, so
a deployment can inject secrets via the environment and leave the file for
local dev.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `YAP_ENV_FILE` | — | Explicit env-file path (beats the instance directory's `./.env`) |
| `YAP_SYSADMIN_KEY` | *(required)* | Environment credential for user provisioning over REST |
| `YAP_MASTER_KEY` | *(required)* | Base64 32 bytes: hook-secret encryption + link/token signing |
| `YAP_PORT` / `YAP_HOST` / `YAP_BASE_URL` | `8787` / `0.0.0.0` / `http://localhost:8787` | Listener + minted-link base |
| `YAP_DB` | `sqlite` | `sqlite` or `postgres` |
| `YAP_SQLITE_PATH` | `./data/yap.db` | SQLite database file |
| `YAP_DATABASE_URL` | — | Postgres connection string (when `YAP_DB=postgres`; requires Postgres 13+) |
| `YAP_BLOB` | `fs` | `fs` or `s3` |
| `YAP_BLOB_FS_ROOT` | `./data/blobs` | Local blob root |
| `YAP_S3_BUCKET` / `YAP_S3_REGION` / `YAP_S3_ENDPOINT` / `YAP_S3_ACCESS_KEY_ID` / `YAP_S3_SECRET_ACCESS_KEY` / `YAP_S3_FORCE_PATH_STYLE` | — | S3-compatible storage (R2/GCS-interop/MinIO via endpoint) |
| `YAP_MAX_FILE_SIZE_BYTES` | 50 MiB | Upload size cap |
| `YAP_MIME_ALLOWLIST` | `*` | Comma list; supports `type/*` patterns |
| `YAP_UPLOAD_TTL_SECONDS` / `YAP_DOWNLOAD_TTL_SECONDS` / `YAP_WIDGET_TOKEN_TTL_SECONDS` | 600 / 300 / 600 | Link/token lifetimes |
| `YAP_HOOK_TIMEOUT_MS` | 30000 | Hook firing timeout (no automatic retries) |
| `YAP_HOOK_ALLOW_HOSTS` | *(empty)* | SSRF-guard allowlist for intentional internal hook targets |
| `YAP_ORPHAN_SWEEP_INTERVAL_MS` / `YAP_ORPHAN_MAX_AGE_MS` | 10 min / 60 min | Reserved-placeholder cleanup |

## The MCP surface

Progressive disclosure — a small fixed tool set that reveals the tree one
layer at a time, so an agent can resolve "show me open todos" by reading
metadata and descending only into the relevant branch:

- **`load`** → reachable spaces (id, name, description, keywords, role) +
  autoloading user docs + tool specs
- **`load_space`** → the space's instructions and bundles
- **`load_bundle`** → binding docs, item-type schemas, files, hooks
  (required before calling into a bundle)
- **`call`** → the single execution verb: a batch of second-tier operations,
  each targeting a bundle (`bundle_id`) or the call's space (omit it) and
  succeeding/failing independently. Data & content: `query_items`, `get_items`,
  `create_items`, `update_items`, `delete_items`, `read_docs`, `create_doc`,
  `update_doc`, `delete_doc`,
  `list_files`, `show_file`, `upload_request`, `upload_complete`, `delete_file`,
  `fire_hook`. Management (gated by the matching capability): `update_space` /
  `delete_space`, `list_grants` / `grant_role` / `revoke_grant`,
  `update_bundle` / `delete_bundle`, `create_item_type` / `update_item_type` /
  `delete_item_type`, `add_property` / `update_property` / `delete_property`.
- **`help`**, **`show_widget`**, **`space_create`**, **`bundle_create`**, and
  five user-doc tools (`list/load/create/update/delete_user_doc`)

**Surface parity:** every per-resource role capability — content and container
(`manage_space`, `manage_roles`, `edit_bundles`, …) — is exercisable from
either surface; REST and MCP are two transports over one capability-checked
core. Two things stay REST-only by design: **hook authoring** (defining a
hook's destination and secrets is too sensitive for an agent-driven surface —
agents may fire hooks but never define them) and **operator/account actions**
that aren't role capabilities (user provisioning via the sysadmin key, and
access-key management). The REST API under `/v1` also remains the full
management plane.

## Items & schemas

Items conform to per-bundle **item-types** — a set of typed **properties**.
Datatypes: `text`, `number`, `boolean`, `date`, plus two references —
`item` (another item in the same bundle, stored as `item://<id>`) and `file`
(a finalized file, `file://<id>`). Values are validated on write and cast on
read; a reference is checked to exist in the bundle at write time (a later
delete leaves a dangling reference that resolves to `not_found`, matching the
loose EAV model). A property may be **multi-valued** (`multi: true`), holding an
ordered list of its datatype; such fields are read and written as arrays
(`{"tags": ["a", "b"]}`).

A property may declare a **`config`** of constraints, enforced at the core
(so REST and MCP can't drift):

| Datatype | `config` | Effect |
|---|---|---|
| `text` | `{ pattern }` | value must match the regex (`RegExp.test`; anchor with `^…$` for a full match) |
| `number` | `{ min, max, decimals }` | inclusive bounds; at most `decimals` fractional digits (**default 2**) — out-of-precision writes are rejected |
| `item` | `{ itemType }` | the referent must be of this item-type |
| any `multi` | `{ minItems, maxItems }` | bounds on the number of elements (when populated) |

Schemas are freely mutable after items exist (it's EAV): renaming a property
touches no values, adding one leaves existing items without it, removing one
drops its values, and tightening a `config` does not retroactively invalidate
stored values (same as the `required` flag).

Query filters AND-combine and are datatype-aware. Comparison ops — `eq`,
`neq`, `contains`, `gt`, `gte`, `lt`, `lte`, `in` — take an optional
`quantifier` for multi fields: `any` (default; some element matches), `all`
(every element matches), `none`. Set operators match a multi field's whole
set: `has` (contains a value), `has_any` / `has_all` / `has_none` (against an
array). Example: `{"property": "tags", "op": "has_all", "value": ["x", "y"]}`.

## Permissions

Capability-based. Access keys authenticate identity only; **roles** (sets of
capabilities such as `read_items`, `edit_items`, `edit_docs`, `read_files`,
`edit_files`, `fire_hooks`, `edit_hooks`, `manage_roles`) are granted on
spaces and bundles as explicit **allow/deny rows**. Resolution is
most-specific-wins: bundle beats space, deny beats allow at the same level,
absence inherits, default deny. A space grant cascades into its bundles as a
baseline; a bundle grant overrides per capability — so a user can fire hooks
in one bundle and not its sibling, with the deciding row auditable either
way. Personal spaces accept no grants; their owner implicitly holds all
capabilities.

## OAuth (connecting apps)

Every instance is its own **OAuth 2.1 authorization server** — no central
identity service. Access keys stay the root credential; tokens are
delegations of a key, issued through authorization code + PKCE with dynamic
client registration (RFC 7591) and discovery (RFC 8414/9728), so a compliant
MCP client connects with a standard authorize prompt and zero manual config.
The authorize screen — served by Core itself — authenticates by access key
(Core has no passwords) and binds the grant to that key: revoking the key
revokes every delegation made with it. Tokens are opaque, hashed at rest,
short-lived, and renewed by rotating refresh tokens (reuse kills the grant).

A token's scope is `role:admin | role:member | role:read-only` plus optional
`space:<id>` / `bundle:<id>` restrictions; every authorization resolves as
*live grants ∧ scope*, so a delegation can never out-power the key behind it
and role changes apply to outstanding tokens immediately. The default
(unrequested) scope is `member`: content work, but no credential, role, or
space management — minting keys or managing connected apps over the token
lane requires `role:admin`. Connected apps are listed and revocable at
`/v1/oauth/grants`, on the self-served `/oauth/connections` page, and via
RFC 7009 `/oauth/revoke`. Both lanes — keys and
tokens — work on every REST and MCP endpoint. OAuth needs `YAP_BASE_URL` to
be the instance's externally reachable origin (https except on loopback).

## Files, hooks, widgets

- **Files** upload in three phases (request → direct-to-storage upload →
  complete, with size read from storage) and download via mint-on-demand
  expiring links. With S3 the bytes never touch the API layer; on local disk
  Yap serves them behind its own signed-token endpoints. Deleting a file
  deletes the blob immediately.
- **Hooks** are pre-configured outbound HTTP calls: the agent sees a name,
  description, and declared parameters; the transport (URL, method, headers,
  secrets) stays encrypted at rest and is never returned by any surface.
  Private/link-local destinations are denied by default, checked at creation,
  again at fire time, and pinned at connect time (the request connects only to
  the validated address, closing DNS-rebinding).
- **Widgets** (MCP Apps / SEP-1865) are self-contained `ui://` resources
  rendered three ways: result pointers on `call`, the generic `show_widget`
  shell, or origin-hosted pages at signed expiring URLs for hosts that can't
  render widgets at all.

## Development

```sh
npm run dev          # tsx, no build step
npm run typecheck
npm test             # SQLite matrix
YAP_TEST_PG_URL=postgres://user@host/db npm test   # + Postgres matrix
npm run db:generate  # regenerate drizzle migrations after schema changes
```

Integration suites run against **both** storage adapters via
`describeEachAdapter` — that matrix (also in CI) is what enforces the
SQLite/Postgres portability promise. Architecture rules: all domain logic
lives in `src/core/`; the REST routes and MCP tools are thin transports over
it; storage is reached only through the adapter layers (`src/db/`,
`src/blob/` — Drizzle and FlyDrive live there, never inline in domain code).

## Contributing

Issues and pull requests are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for the ground rules (short version: tests
green on both database matrices, domain logic stays in `src/core/`). For
anything security-sensitive, follow [SECURITY.md](SECURITY.md) instead of
opening a public issue.

## License

[MIT](LICENSE)
