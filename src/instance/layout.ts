/**
 * The instance directory's shape, in one place. A Yap instance is a
 * directory: its .env (operator configuration and keys), data/ (database and
 * blobs), vendored server (node_modules/yap-core), and CLI state (.yap/:
 * pidfile, logs, saved credential, saved server source) live together, and `yap` operates on
 * whichever instance directory it runs from. Every path below resolves
 * relative to the instance directory so the whole instance stays relocatable.
 */
import { join } from "node:path";

export function envPath(dir: string): string {
  return join(dir, ".env");
}

export function dataDir(dir: string): string {
  return join(dir, "data");
}

/** CLI state the operator never edits: pidfile, logs, saved credential. */
export function stateDir(dir: string): string {
  return join(dir, ".yap");
}

export function pidPath(dir: string): string {
  return join(stateDir(dir), "yap.pid");
}

export function logsDir(dir: string): string {
  return join(stateDir(dir), "logs");
}

export function logPath(dir: string): string {
  return join(logsDir(dir), "yap.log");
}

export function credentialsPath(dir: string): string {
  return join(stateDir(dir), "credentials.json");
}

/** The instance's server source, present only when it tracks a git ref rather than releases. */
export function sourcePath(dir: string): string {
  return join(stateDir(dir), "source.json");
}
