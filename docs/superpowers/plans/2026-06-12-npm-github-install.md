# GitHub-direct npm install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm install -g github:yap-tools/yap-core` (and `npx github:yap-tools/yap-core`) produce a working `yap` command, with an explicit `yap init` that scaffolds config and keys under `~/.yap`.

**Architecture:** npm's git-install path clones the repo, installs devDependencies, runs `prepare`, and packs per the `files` whitelist — so a `prepare: npm run build` plus a `bin` entry is the whole distribution story. Runtime gains a tiny CLI dispatcher in the entry point (`init` / `version` / `help` / default = serve), a shared "yap home" module (`YAP_HOME` ?? `~/.yap`), and a three-step env-file resolution (explicit `YAP_ENV_FILE` → `./.env` → `$YAP_HOME/.env`). `yap init` writes a fully explicit `.env` with generated keys and absolute data paths, never overwriting an existing one. Repo-checkout workflows (`npm run dev`, `npm start`, `.env` in cwd) are unchanged.

**Tech Stack:** plain Node (no new dependencies): `node:crypto` for key generation, `node:fs`/`node:os` for home scaffolding, existing `generateSecret` helper.

---

### Task 1: yap home + env-file resolution module

**Files:**
- Create: `src/cli/home.ts`
- Test: `tests/unit/cli.test.ts`

- [ ] **Step 1: Write failing tests** for `yapHome` (env override, `~/.yap` default) and `resolveEnvFile` (explicit > cwd > home, undefined when none exist; explicit wins even if missing so the operator notices a typo — return it regardless of existence? No: keep current semantics, skip-if-missing, but explicit path that is missing returns undefined and the caller warns).
- [ ] **Step 2: Run** `npx vitest run tests/unit/cli.test.ts` — fails (module missing).
- [ ] **Step 3: Implement** `src/cli/home.ts`:

```ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The directory holding config + data for installed (non-checkout) use. */
export function yapHome(env: Record<string, string | undefined> = process.env): string {
  return resolve(env.YAP_HOME || join(homedir(), ".yap"));
}

/**
 * Which env file to load: explicit YAP_ENV_FILE, else ./.env (checkout dev),
 * else $YAP_HOME/.env (created by `yap init`). Missing files are skipped so a
 * bare environment-variable deployment needs no file at all.
 */
export function resolveEnvFile(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string | undefined {
  const candidates = [env.YAP_ENV_FILE, join(cwd, ".env"), join(yapHome(env), ".env")];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}
```

- [ ] **Step 4: Run the test** — passes.

### Task 2: `yap init`

**Files:**
- Create: `src/cli/init.ts`
- Test: `tests/unit/cli.test.ts` (same file)

- [ ] **Step 1: Write failing tests**: fresh dir → `.env` created (mode 0600, `YAP_MASTER_KEY` decodes to 32 bytes, `YAP_SYSADMIN_KEY` starts `yap_sys_`, absolute `YAP_SQLITE_PATH`/`YAP_BLOB_FS_ROOT` under `<home>/data`); second run → `created: false`, file byte-identical.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement** `initYapHome(home: string): InitResult` returning `{ envPath, created, sysadminKey }`:
  - `mkdirSync(home, { recursive: true })`
  - if `<home>/.env` exists → `{ created: false, envPath, sysadminKey: "" }`
  - generate `generateSecret("yap_sys_")` + `randomBytes(32).toString("base64")`
  - write `.env` (mode 0o600) with the two keys, absolute sqlite/blob paths, commented `YAP_PORT`/`YAP_BASE_URL` lines, pointer to `.env.example` for the rest.
- [ ] **Step 4: Run the test** — passes.

### Task 3: CLI dispatch in the entry point

**Files:**
- Modify: `src/index.ts` (shebang + dispatch; server boot moves to `src/serve.ts`)
- Create: `src/serve.ts` (current index.ts body, env file resolved via `resolveEnvFile`)

- [ ] **Step 1:** Move the server-boot body of `src/index.ts` into `src/serve.ts` as `export async function serve(): Promise<void>`, replacing the cwd-only `.env` check with `resolveEnvFile()`. Wrap `loadConfig()` so a `ConfigError` prints one friendly line plus a `Run \`yap init\`…` hint and exits 1 (no stack trace).
- [ ] **Step 2:** Rewrite `src/index.ts` as:

```ts
#!/usr/bin/env node
const command = process.argv[2];
switch (command) {
  case undefined: case "serve": → (await import("./serve.js")).serve()
  case "init": → run initYapHome(yapHome()), print sysadmin key + next steps (or "already exists" + exit 1)
  case "version": case "--version": case "-v": → print package.json version
  case "help": case "--help": case "-h": → usage, exit 0
  default: → usage, exit 1
}
```

  Version is read with `createRequire(import.meta.url)("../package.json")` — resolves from both `src/` (tsx) and `dist/` (built).
- [ ] **Step 3:** `npm run typecheck` and full `npm test` — green.
- [ ] **Step 4:** Manual: `npx tsx src/index.ts init` with `YAP_HOME=/tmp/yap-init-test`, then `YAP_HOME=/tmp/yap-init-test YAP_PORT=8788 npx tsx src/index.ts` boots and `/health` answers.

### Task 4: package.json distribution fields

**Files:**
- Modify: `package.json`

- [ ] **Step 1:** Add:

```json
"bin": { "yap": "dist/index.js" },
"files": ["dist", "drizzle", ".env.example"],
"scripts": { "prepare": "npm run build", ... }
```

- [ ] **Step 2:** `npm pack --dry-run` — tarball contains `dist/**`, `drizzle/**` (including `meta/`), `.env.example`, `README.md`, `package.json`, and nothing else.

### Task 5: end-to-end install verification

- [ ] **Step 1:** `npm pack` → install the tarball into a throwaway prefix (`npm install -g --prefix /tmp/yap-prefix ./yap-core-0.1.0.tgz`), run `/tmp/yap-prefix/bin/yap init` + `yap` with `YAP_HOME` set, curl `/health`, provision a user. This exercises exactly what a `github:` install produces (same pack pipeline).
- [ ] **Step 2:** Clean up the throwaway prefix and tarball.

### Task 6: README + .env.example

**Files:**
- Modify: `README.md` (new install-first quickstart: `npm install -g github:yap-tools/yap-core`, `yap init`, `yap`; current checkout flow moves under Development), `.env.example` (note that `yap init` generates this for installed use).

- [ ] **Step 1:** Rewrite Quickstart; document `YAP_HOME` and the env-file resolution order in the Configuration section.
- [ ] **Step 2:** Commit.

## Out of scope (flagged, deferred)

- Publishing to the npm registry; prebuilt release tarballs on GitHub Releases (upgrade path if build-on-install gets annoying).
- `yap` process management (daemonizing, launchd/systemd units).
- Swapping better-sqlite3 for `node:sqlite` to drop the native dependency.
- A LICENSE file (package.json says MIT but no file exists — worth adding separately).
