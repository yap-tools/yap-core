---
name: yap
description: Use when working with a Yap (yap-core) instance — connecting an agent or MCP client, storing or querying context (spaces, bundles, item-types, items, docs, files, hooks) over REST or MCP, or installing, running, upgrading, and administering an instance with the yap CLI. Triggers include "store this in Yap", "my Yap instance", yap init/start/serve, port 8787, or yap-tools/yap-core.
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
    └── hooks        (pre-configured outbound HTTP calls; agents fire, never define)
```

Autoloaded bundle docs are where binding operating instructions belong; non-autoloaded bundle docs stay available to read on demand. Outside the tree: **user docs** — account-level notes that travel with the user (optionally autoloaded). A free-form note with no bundle context → user doc. Structured data → items of an item-type inside a bundle. If several spaces or bundles could match the user's intent, ask the user rather than guessing.

## Connect

**MCP** (preferred for agents): streamable HTTP at `http://<host>:8787/mcp`, access key as bearer token (`?key=` works as a fallback for URL-only clients):

```sh
claude mcp add --transport http yap http://localhost:8787/mcp \
  --header "Authorization: Bearer <access-key>"
```

Tools disclose progressively: `load` → `load_space` → `load_bundle` (required before calling into a bundle) → `call`. Compliant clients can also connect with zero config via OAuth — each instance is its own authorization server.

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
yap create my-yap --user ada      # mkdir + init + start + user create
```

Or stepwise, from inside the directory: `yap init` (writes `.env` with generated sysadmin + master keys — printed once; vendors the server into the directory at the latest release, `--version vX.Y.Z` to pin, `--port n` to change 8787) → `yap start` → `yap user create ada`.

`yap user create` **prints the user's access key once** — that's the credential to give MCP/REST clients — and saves it to `.yap/credentials.json` (field `accessKey`, mode 0600), making the CLI an API client as that user. Mint additional keys later with `yap keys create`.

All commands resolve the instance from the current directory — run them inside it. To target a **remote** instance instead, pass `--url <url> --key <accessKey>` (or set `YAP_URL`/`YAP_KEY`): manage commands only — sysadmin-lane (`users …`, `user create`, `api --sysadmin`) and lifecycle commands (`start`, `logs`, `upgrade`, …) refuse remotely and must run on the instance host. Local `.env`/`.yap/` are never read in remote mode; the key must be explicit.

| Need | Command |
|---|---|
| Foreground / detached / supervised | `yap serve` / `yap start`+`stop` / `yap service install` |
| Survive reboots | `yap service install` — writes a systemd unit (Linux) or launchd LaunchAgent (macOS, starts at login) and prints the activation commands to run. Do not hand-roll one. Run `yap stop` first so the port is free. |
| Health, logs, version bump | `yap status`, `yap logs -f`, `yap upgrade [version]` |
| Any API call from the instance dir | `yap api GET /v1/spaces` — authenticated passthrough; prefer it over curl |

## Gotchas

| Trap | Reality |
|---|---|
| Inventing endpoints (`/v1/notes`, `/v1/todos`) | Only the tree resources exist — see reference.md |
| Using the sysadmin key as a user credential | Rejected. It only provisions users (`yap user create`, `--sysadmin`) |
| Showing `item://<id>` / `file://<id>` values to users | Opaque references — resolve them first (get items / `GET /v1/files/<id>/link`) |
| Defining hook URLs via MCP or as an agent | Hook authoring is deliberately REST-only; agents may only fire hooks |
| Expecting open access | Default deny. Grants resolve most-specific-wins: bundle beats space, deny beats allow |
