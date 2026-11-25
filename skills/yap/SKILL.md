---
name: yap
description: Use when working with a Yap (yap-core) instance — connecting an agent or MCP client, storing or querying context (spaces, bundles, item-types, items, docs, files, services — the driver-backed capabilities that generalized hooks) over REST or MCP, or installing, running, upgrading, and administering an instance with the yap CLI. Triggers include "store this in Yap", "my Yap instance", yap init/start/serve, port 8787, or yap-tools/yap-core.
---

# Yap

Self-hosted, API-first context store for AI agents. One server, one port (default **8787**): REST under `/v1`, MCP at `/mcp`, health at `/health`. There is no UI.

## Context model

Do not invent resources like `/notes` or `/todos` — they don't exist. Everything lives in a tree:

```
space                (top level; spaces do not nest)
└── bundle
    ├── docs         (named bundle docs; autoloaded binding instructions and read-on-demand docs)
    ├── item-types   (schemas; each holds many items — this is where "todos" live)
    ├── files
    └── services     (named, driver-backed capabilities; agents run them, and author them with settings only)
```

Autoloaded bundle docs are where binding operating instructions belong; non-autoloaded bundle docs stay available to read on demand. Outside the tree: **user docs** — account-level notes that travel with the user (optionally autoloaded). A free-form note with no bundle context → user doc. Structured data → items of an item-type inside a bundle. If several spaces or bundles could match the user's intent, ask the user rather than guessing.

## Connect

**MCP** (preferred for agents): streamable HTTP at `http://<host>:8787/mcp`, access key as bearer token (`?key=` works as a fallback for URL-only clients; where the operator switched key login off, keys are refused and clients connect through OAuth):

```sh
claude mcp add --transport http yap http://localhost:8787/mcp \
  --header "Authorization: Bearer <access-key>"
```

Tools disclose progressively: `load` → `load_space` → `load_bundle` (required before calling into a bundle) → `get_tools` (full second-tier descriptions and param specs; `load` carries only a lightweight manifest) → `call`. Compliant clients can also connect with zero config via OAuth — each instance is its own authorization server.

**REST**: every request needs `Authorization: Bearer <access-key>` (header only — no query-string auth on REST). Discover, don't guess:

```sh
curl -H "Authorization: Bearer $KEY" http://localhost:8787/v1/spaces
curl -H "Authorization: Bearer $KEY" http://localhost:8787/v1/spaces/<id>/bundles
curl -H "Authorization: Bearer $KEY" http://localhost:8787/v1/bundles/<id>/item-types
# query items (filters = JSON array, URL-encoded):
curl -H "Authorization: Bearer $KEY" \
  "http://localhost:8787/v1/bundles/<id>/items?itemType=Todo&filters=%5B%7B%22property%22%3A%22done%22%2C%22op%22%3A%22eq%22%2C%22value%22%3Afalse%7D%5D"
# create items:
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  http://localhost:8787/v1/bundles/<id>/items \
  -d '{"itemType": "Todo", "items": [{"title": "Ship it", "done": false}]}'
# store a free-form note for the account:
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  http://localhost:8787/v1/user-docs -d '{"name": "Standup", "content": "Moved to 10:30"}'
```

Full endpoint map, query operators, datatypes: [reference.md](reference.md)

## Run an instance

Install the CLI (Node 22+; **not on the npm registry** — prebuilt, dependency-free tarball from GitHub Releases):

```sh
npm install -g https://github.com/yap-tools/yap-core/releases/latest/download/yap-cli.tgz
```

**An instance is a directory.** One-shot setup:

```sh
yap create my-yap --user ada      # mkdir + init + start + user create --save
```

Or stepwise, from inside the directory: `yap init` (writes `.env` with generated sysadmin + master keys — printed once; vendors the server into the directory at the latest release, `--version vX.Y.Z` to pin, `--port n` to change 8787) → `yap start` → `yap user create ada --save`.

`yap user create` **prints the user's access key once** — that's the credential to give MCP/REST clients — and saves nothing by default. With `--save` it also writes the key to `.yap/credentials.json` (field `accessKey`, mode 0600), making the CLI an API client as that user; an existing credential is never overwritten. `yap create` passes `--save`. Mint additional keys later with `yap keys create`. `--email <address>` records an email on the user, which invites them: when the operator configured a login provider (`YAP_OIDC_*`, see the repo's `docs/oidc-login.md`), the first provider login with that address (verified by the provider, or trusted for it) claims the account. An email is unique: an address another user already has is refused (`409`). A role can then be granted to that person by address before they first log in: `grant_role` with `email` (REST `POST …/grants {"email", "capabilities", "effect"}`).

All commands resolve the instance from the current directory — run them inside it. To target a **remote** instance instead, pass `--url <url> --key <accessKey>` (or set `YAP_URL`/`YAP_KEY`): manage commands only — sysadmin-lane (`users …`, `user create`, `api --sysadmin`) and lifecycle commands (`start`, `logs`, `upgrade`, …) refuse remotely and must run on the instance host. Local `.env`/`.yap/` are never read in remote mode; the key must be explicit.

| Need | Command |
|---|---|
| Foreground / detached / supervised | `yap serve` / `yap start`+`stop` / `yap daemon install` |
| Survive reboots | `yap daemon install` — writes a systemd unit (Linux) or launchd LaunchAgent (macOS, starts at login) and prints the activation commands to run. Do not hand-roll one. Run `yap stop` first so the port is free. |
| Health, logs, version bump | `yap status`, `yap logs -f`, `yap upgrade [version]` |
| Any API call from the instance dir | `yap api GET /v1/spaces` — authenticated passthrough; prefer it over curl |

## Gotchas

| Trap | Reality |
|---|---|
| Inventing endpoints (`/v1/notes`, `/v1/todos`) | Only the tree resources exist — see reference.md |
| Using the sysadmin key as a user credential | Rejected. It is the operator credential: it provisions users and manages their access keys (`yap user create`, `--sysadmin`), and never reads or writes content |
| Showing `item://<id>` / `file://<id>` values to users | Opaque references — resolve them first (get items / `GET /v1/files/<id>/link`); driver-internal file reads use `ctx.reader.readFile` only when the driver declares `reads.files`; driver item reads use `ctx.reader.getItems` only when it declares `reads.items`; driver item write-backs use `ctx.writer.createItems` / `ctx.writer.updateItems` only when it declares `writes.items`; driver file write-backs use `ctx.writer.writeFile` only when it declares `writes.files` |
| Putting a password, token or API-key header into a service over MCP | Refused. `create_service` / `update_service` take settings only; call `secret_request` and give the user its form (widget or `origin_url`), so the secret goes from them straight to the server (they save it with their own full access key). Never ask the user to paste a secret into the chat. `get_service` shows `secretsSet`, never a value |
| Running a service an agent just wrote over MCP | Refused until a person approves it (`approved: false` in listings). Enter its secrets, then call `approval_request` and give the user its page (widget or `origin_url`); they approve with their own access key. Changing its params, pins, actions or settings over MCP turns it off again; a REST write of the config with a full key approves it (with a scoped key it waits). Never ask the user for an access key in the chat |
| Giving an agent or a machine a key | Prefer a scoped key: `POST /v1/keys` with `{"name", "scope": {"role": "member"}}` (or `yap keys create <name> --role member`). It acts as the user narrowed to that role, cannot manage keys, and cannot approve a service or enter its secrets, so the person keeps those decisions. A scope limits what, never where: for "only this space", create a separate user with grants there |
| Expecting open access | Default deny. Grants resolve most-specific-wins: bundle beats space, deny beats allow |
