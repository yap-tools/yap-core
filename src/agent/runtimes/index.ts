/**
 * Agent runtime registry. A runtime is a Docker image plus a host-side auth
 * contract (authorize / capture / refresh / materialize) that owns ALL
 * model-provider OAuth knowledge — Core never learns a provider's endpoints or
 * client ids. Runtimes are system-defined (the built-ins below) but
 * operator-registerable from a configured directory at boot.
 *
 * The contract is split by where each step runs:
 *  - authorize / capture: interactive or filesystem-bound, run host-side by the
 *    CLI (`yap agent-runtime <name> authorize`).
 *  - refresh / materialize: headless, run inside the server during a run.
 */
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import type { YapLogger } from "../../logger.js";
import { mockRuntime } from "./mock.js";

export interface RuntimeDescriptor {
  /** Stable name an agent references via its `runtime` field. */
  name: string;
  /** Docker image the run executes in. */
  image: string;
  /** Allowed model ids; empty/undefined means the runtime accepts any model. */
  models?: string[];
  /** Container env var carrying the injected Yap access key. */
  yapKeyEnv: string;
  /** Container env var carrying the injected short-lived model access token. */
  modelTokenEnv: string;
  /** Container entry command that drives the model. */
  command: string[];
}

/** Opaque to Core; only the runtime understands its shape. */
export type CredentialBlob = Record<string, unknown>;

export interface RefreshResult {
  /** The (possibly rotated) credential blob Core MUST persist. */
  blob: CredentialBlob;
  /** Short-lived access token to inject into a run container. */
  accessToken: string;
  /** Epoch milliseconds the access token expires, if known. */
  expiresAt?: number;
}

export interface Runtime {
  descriptor: RuntimeDescriptor;
  /** Interactive, host-side, one-time: produce the initial credential blob. */
  authorize(ctx: { log: (msg: string) => void }): Promise<CredentialBlob>;
  /** Read the provider login from its on-disk location (used by authorize). */
  capture(ctx: { log: (msg: string) => void }): Promise<CredentialBlob>;
  /** Headless: exchange the stored blob for a current one. Core persists what
   * this returns — refresh tokens may rotate. */
  refresh(blob: CredentialBlob): Promise<RefreshResult>;
  /** Extract the current access token from a blob without any network call. */
  materialize(blob: CredentialBlob): { accessToken: string; expiresAt?: number };
}

const registry = new Map<string, Runtime>();

export function registerRuntime(runtime: Runtime): void {
  registry.set(runtime.descriptor.name, runtime);
}

export function getRuntime(name: string): Runtime | null {
  return registry.get(name) ?? null;
}

export function listRuntimes(): RuntimeDescriptor[] {
  return [...registry.values()].map((r) => r.descriptor).sort((a, b) => a.name.localeCompare(b.name));
}

/** Does this runtime accept this model? Empty allowlist = accepts any. */
export function runtimeAcceptsModel(runtime: Runtime, model: string): boolean {
  const models = runtime.descriptor.models;
  return !models || models.length === 0 || models.includes(model);
}

/**
 * Best-effort load of operator-provided runtimes from a directory. Each *.js /
 * *.mjs module should export a `runtime` (or default) implementing Runtime.
 * Failures are logged and skipped — a bad descriptor never blocks boot.
 */
export async function loadOperatorRuntimes(dir: string, logger?: YapLogger): Promise<void> {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));
  } catch {
    return; // directory absent or unreadable — nothing to load
  }
  for (const entry of entries) {
    try {
      const mod = (await import(pathToFileURL(join(dir, entry)).href)) as {
        runtime?: Runtime;
        default?: Runtime;
      };
      const runtime = mod.runtime ?? mod.default;
      if (!runtime?.descriptor?.name) {
        logger?.warn(`agent runtime in ${entry} has no descriptor.name — skipped`);
        continue;
      }
      registerRuntime(runtime);
    } catch (err) {
      logger?.warn(`failed to load agent runtime ${entry}: ${(err as Error).message}`);
    }
  }
}

// Built-in runtimes.
registerRuntime(mockRuntime);
