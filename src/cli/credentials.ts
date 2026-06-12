/**
 * The CLI's credential for talking to the instance API: a user access key in
 * .yap/credentials.json inside the instance directory. Never the sysadmin
 * key — that stays in .env and is read on demand for the few operations that
 * need it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Credentials {
  accessKey: string;
  userId?: string;
  userName?: string;
}

export function credentialsPath(dir: string): string {
  return join(dir, ".yap", "credentials.json");
}

export function readCredentials(dir: string): Credentials | undefined {
  const path = credentialsPath(dir);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Credentials;
  return parsed.accessKey ? parsed : undefined;
}

export function writeCredentials(dir: string, creds: Credentials): void {
  mkdirSync(join(dir, ".yap"), { recursive: true });
  writeFileSync(credentialsPath(dir), JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
}
