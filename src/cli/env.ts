/**
 * A Yap instance is a directory: its .env (written by `yap init`) and data/
 * live together, and `yap` serves whichever instance directory it runs from.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

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
