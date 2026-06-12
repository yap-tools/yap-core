# Contributing to Yap

Thanks for considering a contribution. Yap is young (pre-1.0) and the surface
is still settling — for anything beyond a bug fix, open an issue first so we
can agree on the shape before you invest in an implementation.

## Setup

```sh
git clone https://github.com/yap-tools/yap-core.git
cd yap-core
npm install
cp .env.example .env     # fill in YAP_MASTER_KEY (openssl rand -base64 32)
npm run dev
```

Node 22+ is required (the server uses `process.loadEnvFile` and other modern
built-ins).

## Tests and checks

```sh
npm run typecheck
npm test                                            # SQLite matrix
YAP_TEST_PG_URL=postgres://user@host/db npm test    # + Postgres matrix
```

Every integration suite runs against **both** storage dialects via
`describeEachAdapter`; CI runs the Postgres matrix against a real Postgres 16,
so a change that only passes on SQLite will not merge. New behavior needs
tests in the same style as the existing suites (`tests/unit/` for pure logic,
`tests/integration/` for anything that touches the server or storage).

## Architecture rules

These are load-bearing, not preferences:

- **All domain logic lives in `src/core/`.** REST routes (`src/rest/`) and MCP
  tools (`src/mcp/`) are thin transports over it — a capability check or
  validation that exists in only one transport is a bug.
- **Storage is reached only through the adapter layers** (`src/db/`,
  `src/blob/`). Drizzle and FlyDrive imports stay there, never in domain code.
- **The two Drizzle schemas are twins.** Any change to
  `src/db/schema-sqlite.ts` must land identically in `src/db/schema-pg.ts`,
  followed by `npm run db:generate` to regenerate migrations for both.

## Commits and pull requests

- Keep commits focused; write messages that explain why, not just what.
- A PR should leave `npm run typecheck` and both test matrices green.
- Update README/`.env.example` when you add or change configuration.
