/**
 * The driver contract. A service is a bundle-owned, named capability whose
 * behaviour comes from a *driver*: a plain JavaScript module the operator
 * installs. Drivers are trusted code running in-process, so the contract is
 * deliberately small and every crossing is explicit:
 *
 * - Egress: a driver that declares `egress: true` receives an `Egress` handle
 *   and MUST reach the network only through it — the handle is the single
 *   SSRF-guarded door (see egress.ts). A driver declaring `egress: false`
 *   receives `null` and has no sanctioned way out.
 * - Writes: a driver receives a `writer` only for the write surfaces it
 *   declared. Undeclared writes are simply not reachable — `writer` is null.
 * - Config: the decrypted service config reaches the driver only inside
 *   `run`, never any listing or agent-visible surface (mirrors hook
 *   transports).
 *
 * Because driver modules are plain JS from outside the type system, the shape
 * is checked structurally at load time by `validateDriverDefinition` in
 * registry.ts rather than trusted from the declaration here.
 */
import type { Egress } from "./egress.js";

/**
 * The guarded egress handle. Implemented by `createEgress` (egress.ts); the
 * interface lives beside it and is re-exported here so a driver module can
 * import the whole contract from one place.
 */
export type { Egress };

/** Contract version. A driver must declare exactly this; bumping it is how a
 * breaking change to the shape below is signalled to installed drivers. */
export const DRIVER_API = 1;

export interface DriverParamSpec {
  name: string;
  description?: string;
  required?: boolean;
}

export interface DriverActionSpec {
  description: string;
  /** null → param specs come from the service record (http driver). */
  params: DriverParamSpec[] | null;
  /** Wall-clock budget for one call; a positive integer number of ms. */
  timeoutMs: number;
}

/** Write surfaces a driver may reach through `RunContext.writer`. */
export interface DriverWrites {
  items?: boolean;
  files?: boolean;
}

/**
 * The bundle-scoped write handle handed to a driver that declared writes.
 * Implemented in the bundle writer module; declared minimally here so the
 * contract does not depend on it.
 */
export interface BundleWriter {
  createItems(itemTypeName: string, values: Array<Record<string, unknown>>): Promise<string[]>;
}

/** Everything one driver invocation gets. Nothing else is reachable. */
export interface RunContext {
  /** Decrypted service config — in memory, for this call only. */
  config: unknown;
  action: string;
  params: Record<string, string>;
  /** The guarded network door; null when the driver declared `egress: false`. */
  egress: Egress | null;
  /** Bundle-scoped writes; null when the driver declared no writes. */
  writer: BundleWriter | null;
  /** Fires when the action's timeoutMs elapses. */
  signal: AbortSignal;
  log: (message: string) => void;
}

export interface DriverDefinition {
  /** Stable identifier used in service records and CLI: /^[a-z][a-z0-9-]{1,63}$/ */
  name: string;
  /** Must equal DRIVER_API. */
  api: number;
  description: string;
  egress: boolean;
  writes?: DriverWrites;
  /** Operator-facing help for the config shape, shown by the CLI. */
  configDoc?: string;
  /** Throw an Error whose message names the offending field on invalid config. */
  validateConfig(config: unknown): void;
  /** Optional authoring-time network validation (e.g. http SSRF pre-check). */
  validateConfigOnline?(config: unknown, egress: Egress): Promise<void>;
  actions: Record<string, DriverActionSpec>;
  run(ctx: RunContext): Promise<unknown>;
}
