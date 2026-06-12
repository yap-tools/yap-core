/**
 * Where an installed (non-checkout) yap keeps its config and data. A repo
 * checkout keeps using ./.env and ./data; a global `npm install -g` gets
 * `~/.yap` (override with YAP_HOME), populated by `yap init`.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

export function yapHome(env: Env = process.env): string {
  return resolve(env.YAP_HOME || join(homedir(), ".yap"));
}

/**
 * Which env file to load at startup: explicit YAP_ENV_FILE, else ./.env
 * (checkout dev), else $YAP_HOME/.env (written by `yap init`). Missing files
 * are skipped so a pure environment-variable deployment needs no file at all.
 */
export function resolveEnvFile(env: Env = process.env, cwd: string = process.cwd()): string | undefined {
  const candidates = [env.YAP_ENV_FILE, join(cwd, ".env"), join(yapHome(env), ".env")];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}
