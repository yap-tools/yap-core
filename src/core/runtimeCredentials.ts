/**
 * Runtime credentials: the one shared, instance-level model-provider login per
 * runtime. The blob (refresh token included) is encrypted at rest with the
 * master key and is opaque to Core — only the runtime understands it.
 *
 * The load-bearing rule: after every refresh, persist the blob the runtime
 * returns BEFORE using the token. Providers commonly rotate the refresh token
 * on each refresh, so dropping the rotated blob kills the login on the next
 * run. Refreshes are serialized per runtime so concurrent runs cannot rotate
 * the token out from under each other.
 */
import { eq } from "drizzle-orm";

import { decryptSecret, encryptSecret } from "../crypto.js";
import type { Db } from "../db/index.js";
import { getRuntime as registryGetRuntime, listRuntimes, type CredentialBlob, type Runtime } from "../agent/runtimes/index.js";
import { YapError, invalid, notFound } from "./errors.js";
import { newId, nowIso } from "./util.js";

/** Refresh proactively when the token expires within this window. */
const EXPIRY_SKEW_MS = 60_000;

export interface RuntimeCredEnv {
  db: Db;
  config: { masterKey: Buffer };
  /** Override the runtime lookup (tests). Defaults to the built-in registry. */
  getRuntime?: (name: string) => Runtime | null;
}

interface CredRow {
  id: string;
  runtime: string;
  blobEncrypted: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

// Per-runtime async mutex: chain promises by runtime name so only one refresh
// runs at a time for a given runtime.
const refreshChains = new Map<string, Promise<unknown>>();

function withRuntimeLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = refreshChains.get(name) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Store an error-swallowing tail so a failure doesn't wedge later waiters.
  refreshChains.set(name, next.then(() => {}, () => {}));
  return next;
}

function resolveRuntime(env: RuntimeCredEnv, name: string): Runtime {
  const runtime = (env.getRuntime ?? registryGetRuntime)(name);
  if (!runtime) throw invalid(`unknown agent runtime "${name}"`);
  return runtime;
}

async function loadRow(db: Db, name: string): Promise<CredRow | null> {
  const { runtimeCredentials } = db.tables;
  const rows = await db.client.select().from(runtimeCredentials).where(eq(runtimeCredentials.runtime, name));
  return (rows[0] as CredRow | undefined) ?? null;
}

function decodeBlob(env: RuntimeCredEnv, row: CredRow): CredentialBlob {
  return JSON.parse(decryptSecret(row.blobEncrypted, env.config.masterKey)) as CredentialBlob;
}

async function persist(env: RuntimeCredEnv, name: string, blob: CredentialBlob, status: "active" | "stale"): Promise<void> {
  const { runtimeCredentials } = env.db.tables;
  const encrypted = encryptSecret(JSON.stringify(blob), env.config.masterKey);
  // A refresh may have rotated the provider's refresh token; this blob is then
  // the ONLY valid one, so a failed write loses the login. Retry a few times
  // before giving up.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await env.db.client
        .update(runtimeCredentials)
        .set({ blobEncrypted: encrypted, status, updatedAt: nowIso() })
        .where(eq(runtimeCredentials.runtime, name));
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function markStale(env: RuntimeCredEnv, name: string): Promise<void> {
  const { runtimeCredentials } = env.db.tables;
  await env.db.client
    .update(runtimeCredentials)
    .set({ status: "stale", updatedAt: nowIso() })
    .where(eq(runtimeCredentials.runtime, name));
}

/** Store (or replace) a captured credential blob, encrypted. Serialized under
 * the per-runtime lock so it can't race a concurrent refresh. */
export async function storeCredential(env: RuntimeCredEnv, name: string, blob: CredentialBlob): Promise<void> {
  resolveRuntime(env, name); // reject unknown runtimes early
  return withRuntimeLock(name, async () => {
    const existing = await loadRow(env.db, name);
    if (existing) {
      await persist(env, name, blob, "active");
      return;
    }
    const { runtimeCredentials } = env.db.tables;
    const now = nowIso();
    await env.db.client.insert(runtimeCredentials).values({
      id: newId(),
      runtime: name,
      blobEncrypted: encryptSecret(JSON.stringify(blob), env.config.masterKey),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  });
}

export interface CredentialStatus {
  runtime: string;
  status: string;
  updatedAt: string;
}

export async function getCredentialStatus(env: RuntimeCredEnv, name: string): Promise<CredentialStatus | null> {
  const row = await loadRow(env.db, name);
  return row ? { runtime: row.runtime, status: row.status, updatedAt: row.updatedAt } : null;
}

export async function revokeCredential(env: RuntimeCredEnv, name: string): Promise<void> {
  return withRuntimeLock(name, async () => {
    const row = await loadRow(env.db, name);
    if (!row) throw notFound("runtime credential", name);
    const { runtimeCredentials } = env.db.tables;
    await env.db.client.delete(runtimeCredentials).where(eq(runtimeCredentials.runtime, name));
  });
}

/** Registry descriptors joined with stored credential status, for listing. */
export async function listRuntimesWithStatus(
  env: RuntimeCredEnv,
): Promise<{ name: string; image: string; models: string[]; status: "active" | "stale" | "absent"; updatedAt: string | null }[]> {
  const out = [];
  for (const d of listRuntimes()) {
    const cred = await getCredentialStatus(env, d.name);
    out.push({
      name: d.name,
      image: d.image,
      models: d.models ?? [],
      status: (cred?.status as "active" | "stale") ?? "absent",
      updatedAt: cred?.updatedAt ?? null,
    });
  }
  return out;
}

/**
 * Run a runtime's authorize step and store the captured credential. Runs
 * server-side (the server is on the instance host in local mode), so the
 * runtime registry — server code the thin CLI never imports — stays here. The
 * common provider pattern is a human running the provider's own `login`
 * separately, then this `capture`-ing the on-disk token; a truly interactive
 * in-process login is a documented future seam.
 */
export async function authorizeRuntime(
  env: RuntimeCredEnv,
  name: string,
  log: (msg: string) => void = () => {},
): Promise<void> {
  const runtime = resolveRuntime(env, name);
  const blob = await runtime.authorize({ log });
  await storeCredential(env, name, blob);
}

/** Force a headless refresh now, persisting whatever the runtime returns. */
export async function refreshNow(env: RuntimeCredEnv, name: string): Promise<{ status: "active" | "stale" }> {
  const runtime = resolveRuntime(env, name);
  return withRuntimeLock(name, async () => {
    const row = await loadRow(env.db, name);
    if (!row) throw notFound("runtime credential", name);
    try {
      const result = await runtime.refresh(decodeBlob(env, row));
      await persist(env, name, result.blob, "active");
      return { status: "active" as const };
    } catch {
      await markStale(env, name);
      return { status: "stale" as const };
    }
  });
}

/**
 * Worker-facing: a currently-valid short-lived access token, refreshing (and
 * persisting the rotated blob) if the stored token is expired/near-expiry or
 * carries no expiry hint. Throws a stale_credential error if refresh fails.
 */
export async function resolveAccessToken(env: RuntimeCredEnv, name: string): Promise<{ accessToken: string }> {
  const runtime = resolveRuntime(env, name);
  const row = await loadRow(env.db, name);
  if (!row) {
    throw new YapError("invalid_request", `no credential for runtime "${name}" — run: yap agent-runtime ${name} authorize`);
  }
  // A token is reusable only while the credential is active AND unexpired; a
  // credential explicitly marked stale always goes through refresh.
  const current = runtime.materialize(decodeBlob(env, row));
  if (row.status === "active" && current.expiresAt !== undefined && current.expiresAt > Date.now() + EXPIRY_SKEW_MS) {
    return { accessToken: current.accessToken };
  }
  return withRuntimeLock(name, async () => {
    // Re-read inside the lock: a concurrent waiter may have just refreshed.
    const fresh = await loadRow(env.db, name);
    if (!fresh) {
      throw new YapError("invalid_request", `no credential for runtime "${name}"`);
    }
    const reread = runtime.materialize(decodeBlob(env, fresh));
    if (fresh.status === "active" && reread.expiresAt !== undefined && reread.expiresAt > Date.now() + EXPIRY_SKEW_MS) {
      return { accessToken: reread.accessToken };
    }
    try {
      const result = await runtime.refresh(decodeBlob(env, fresh));
      await persist(env, name, result.blob, "active");
      return { accessToken: result.accessToken };
    } catch {
      // Don't surface the provider's raw error — it can carry secrets.
      await markStale(env, name);
      throw new YapError(
        "invalid_request",
        `runtime "${name}" credential is stale; re-run: yap agent-runtime ${name} authorize`,
      );
    }
  });
}
