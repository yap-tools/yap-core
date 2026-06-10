# Yap

Yap is an API-first, self-hosted, open-source system for building **navigable
contexts** that any AI agent can connect to over MCP. There is no UI: a REST
API is the entire product surface. It runs **onbox by default** — SQLite and
local-disk file storage on a single machine with no external dependencies —
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

## Quickstart (onbox)

```sh
npm install
npm run build

YAP_SYSADMIN_KEY="change-me-at-least-16-chars" \
YAP_MASTER_KEY="$(openssl rand -base64 32)" \
npm start
```

The server listens on `:8787` (one process, one port): REST under `/v1`, MCP
at `/mcp`, origin-hosted widget pages under `/w/`, health at `/health`.

Provision a user (sysadmin key, REST only — never MCP):

```sh
curl -s -X POST localhost:8787/v1/users \
  -H "Authorization: Bearer $YAP_SYSADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Ada"}'
```

The response includes the user's **personal space** and a one-time **access
key** (`yap_…`). Connect any MCP client to `http://localhost:8787/mcp` with
that key as a bearer token (or `?key=` as a fallback for URL-only clients —
bearer is preferred; query strings leak into logs, and Yap redacts keys from
its own logs for exactly that reason).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `YAP_SYSADMIN_KEY` | *(required)* | Environment credential for user provisioning over REST |
| `YAP_MASTER_KEY` | *(required)* | Base64 32 bytes: hook-secret encryption + link/token signing |
| `YAP_PORT` / `YAP_HOST` / `YAP_BASE_URL` | `8787` / `0.0.0.0` / `http://localhost:8787` | Listener + minted-link base |
| `YAP_DB` | `sqlite` | `sqlite` or `postgres` |
| `YAP_SQLITE_PATH` | `./data/yap.db` | SQLite database file |
| `YAP_DATABASE_URL` | — | Postgres connection string (when `YAP_DB=postgres`) |
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
- **`call`** → the single execution verb: a batch of second-tier operations
  (`query_items`, `get_items`, `create_items`, `update_items`,
  `delete_items`, `read_docs`, `update_docs`, `list_files`, `show_file`,
  `upload_request`, `upload_complete`, `delete_file`, `fire_hook`), each
  succeeding or failing independently
- **`help`**, **`show_widget`**, **`space_create`**, **`bundle_create`**, and
  five user-doc tools (`list/load/create/update/delete_user_doc`)

The REST API under `/v1` is the management plane: everything MCP can do plus
the authoring MCP deliberately doesn't expose — user/key administration,
role grants, item-type/property CRUD, and **hook authoring** (REST-only;
agents may fire hooks but never see or define their transport).

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
