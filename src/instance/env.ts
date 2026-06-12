/**
 * The instance's effective configuration: .env entries with real environment
 * variables taking precedence — the same precedence the server itself
 * applies. Used by the CLI, by serve() at startup, and by the in-process
 * backup/restore implementations.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

import { CliError } from "./errors.js";
import { envPath } from "./layout.js";

type Env = Record<string, string | undefined>;

/**
 * Which env file to load at startup: explicit YAP_ENV_FILE, else the
 * instance directory's ./.env. Missing files are skipped so a pure
 * environment-variable deployment needs no file at all.
 */
export function resolveEnvFile(env: Env = process.env, cwd: string = process.cwd()): string | undefined {
  const candidates = [env.YAP_ENV_FILE, join(cwd, ".env")];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function loadInstanceEnv(dir: string, env: Env = process.env): Env {
  const path = envPath(dir);
  const fileEnv = existsSync(path) ? (parseEnv(readFileSync(path, "utf8")) as Env) : {};
  return { ...fileEnv, ...env };
}

export function instanceBaseUrl(env: Env): string {
  return (env.YAP_BASE_URL || `http://localhost:${env.YAP_PORT || 8787}`).replace(/\/$/, "");
}

export function instanceSysadminKey(env: Env): string {
  const key = env.YAP_SYSADMIN_KEY;
  if (!key) {
    throw new CliError("no YAP_SYSADMIN_KEY found — run this from an instance directory (see `yap init`)");
  }
  return key;
}
