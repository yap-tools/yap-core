/**
 * Hooks: named, outbound, parameterized HTTP calls owned by a bundle. The
 * security model rests on two asymmetries:
 *
 * - Visibility: agents see only a hook's name, description, and declared
 *   parameters. The transport (URL, method, headers, body template, secrets)
 *   is AES-256-GCM-encrypted at rest with the master key from configuration,
 *   decrypted only in memory at fire time, and never returned by any surface.
 * - Privilege: discovery needs only bundle read access; firing needs the
 *   privileged fire_hooks capability. Authoring is REST-only (edit_hooks) —
 *   agents fire hooks but never define them.
 *
 * Firing slots allowlisted parameter values into the server-side template
 * (the agent fills blanks in a request it never sees), re-checks the SSRF
 * guard, runs synchronously with a fixed timeout and no automatic retries,
 * and returns the raw status + body.
 */
import { and, asc, eq } from "drizzle-orm";

import type { YapConfig } from "../config.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import type { Db } from "../db/index.js";
import { bundleCapabilityCtx, getBundleContext, requireBundleReadAccess } from "./bundles.js";
import { requireCapability } from "./capabilities.js";
import { YapError, invalid, notFound } from "./errors.js";
import { assertPublicDestination, type Resolver } from "./ssrf.js";
import { newId, nowIso } from "./util.js";

export interface HookParamSpec {
  name: string;
  description?: string;
  required?: boolean;
}

export interface HookInfo {
  id: string;
  name: string;
  description: string;
  params: HookParamSpec[];
}

export interface HookTransport {
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body_template?: string;
}

export interface HookEnv {
  db: Db;
  config: YapConfig;
  resolver?: Resolver;
  fetchImpl?: typeof fetch;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const PARAM_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** Agent-visible hook listing: never includes transport. */
export async function listHooksUnchecked(db: Db, bundleId: string): Promise<HookInfo[]> {
  const { hooks } = db.tables;
  const rows = await db.client
    .select({ id: hooks.id, name: hooks.name, description: hooks.description, params: hooks.params })
    .from(hooks)
    .where(eq(hooks.bundleId, bundleId))
    .orderBy(asc(hooks.createdAt), asc(hooks.id));
  return rows.map((row) => ({ ...row, params: JSON.parse(row.params) as HookParamSpec[] }));
}

export async function listHooks(db: Db, userId: string, bundleId: string): Promise<HookInfo[]> {
  const ctx = await getBundleContext(db, bundleId);
  await requireBundleReadAccess(db, userId, ctx);
  return listHooksUnchecked(db, bundleId);
}

function validateParamSpecs(params: HookParamSpec[]): void {
  const seen = new Set<string>();
  for (const param of params) {
    if (!param.name || !PARAM_NAME.test(param.name)) {
      throw invalid(`invalid hook parameter name ${JSON.stringify(param.name)}`);
    }
    if (seen.has(param.name)) throw invalid(`duplicate hook parameter "${param.name}"`);
    seen.add(param.name);
  }
}

async function validateTransport(transport: HookTransport, env: HookEnv): Promise<void> {
  if (!transport || typeof transport.url !== "string") throw invalid("hook transport.url is required");
  if (!METHODS.includes(transport.method)) {
    throw invalid(`hook transport.method must be one of ${METHODS.join(", ")}`);
  }
  // The host must be static — placeholders may appear in path/query/body, but
  // never in the part the SSRF guard vouches for.
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(transport.url)?.[1] ?? "";
  if (authority.includes("{{")) {
    throw invalid("hook destination host cannot contain parameters");
  }
  let parsed: URL;
  try {
    parsed = new URL(transport.url.replace(PLACEHOLDER, "param"));
  } catch {
    throw invalid(`hook transport.url is not a valid URL`);
  }
  await assertPublicDestination(parsed.origin, env.config.hookAllowHosts, env.resolver);
}

export async function createHook(
  env: HookEnv,
  userId: string,
  bundleId: string,
  input: { name: string; description?: string; params?: HookParamSpec[]; transport: HookTransport },
): Promise<HookInfo> {
  const { db } = env;
  const ctx = await getBundleContext(db, bundleId);
  await requireCapability(db, userId, "edit_hooks", bundleCapabilityCtx(ctx));
  const name = input.name?.trim();
  if (!name) throw invalid("hook name is required");
  const params = input.params ?? [];
  validateParamSpecs(params);
  await validateTransport(input.transport, env);

  const { hooks } = db.tables;
  const clash = await db.client
    .select({ id: hooks.id })
    .from(hooks)
    .where(and(eq(hooks.bundleId, bundleId), eq(hooks.name, name)));
  if (clash.length > 0) throw invalid(`a hook named "${name}" already exists in this bundle`);

  const now = nowIso();
  const id = newId();
  await db.client.insert(hooks).values({
    id,
    bundleId,
    name,
    description: input.description ?? "",
    params: JSON.stringify(params),
    transportEncrypted: encryptSecret(JSON.stringify(input.transport), env.config.masterKey),
    createdAt: now,
    updatedAt: now,
  });
  return { id, name, description: input.description ?? "", params };
}

/** Resolves a hook id to its owning bundle (transport helper for /v1/hooks/:id/fire). */
export async function getHookBundleId(db: Db, hookId: string): Promise<string> {
  return (await getHookRow(db, hookId)).bundleId;
}

async function getHookRow(db: Db, hookId: string) {
  const { hooks } = db.tables;
  const rows = await db.client.select().from(hooks).where(eq(hooks.id, hookId));
  if (rows.length === 0) throw notFound("hook", hookId);
  return rows[0]!;
}

export async function updateHook(
  env: HookEnv,
  userId: string,
  hookId: string,
  patch: { name?: string; description?: string; params?: HookParamSpec[]; transport?: HookTransport },
): Promise<HookInfo> {
  const { db } = env;
  const hook = await getHookRow(db, hookId);
  const ctx = await getBundleContext(db, hook.bundleId);
  await requireCapability(db, userId, "edit_hooks", bundleCapabilityCtx(ctx));
  if (patch.params) validateParamSpecs(patch.params);
  if (patch.transport) await validateTransport(patch.transport, env);
  if (patch.name !== undefined && !patch.name.trim()) throw invalid("hook name cannot be empty");

  const { hooks } = db.tables;
  await db.client
    .update(hooks)
    .set({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.params !== undefined ? { params: JSON.stringify(patch.params) } : {}),
      ...(patch.transport !== undefined
        ? { transportEncrypted: encryptSecret(JSON.stringify(patch.transport), env.config.masterKey) }
        : {}),
      updatedAt: nowIso(),
    })
    .where(eq(hooks.id, hookId));
  const updated = await getHookRow(db, hookId);
  return {
    id: updated.id,
    name: updated.name,
    description: updated.description,
    params: JSON.parse(updated.params),
  };
}

export async function deleteHook(env: HookEnv, userId: string, hookId: string): Promise<void> {
  const { db } = env;
  const hook = await getHookRow(db, hookId);
  const ctx = await getBundleContext(db, hook.bundleId);
  await requireCapability(db, userId, "edit_hooks", bundleCapabilityCtx(ctx));
  const { hooks } = db.tables;
  await db.client.delete(hooks).where(eq(hooks.id, hookId));
}

function substitute(template: string, values: Record<string, string>, encode: boolean): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values[name] ?? "";
    return encode ? encodeURIComponent(value) : value;
  });
}

export interface FireResult {
  status: number;
  body: string;
}

/**
 * Fires a hook: allowlisted params only, server-side template, SSRF re-check,
 * synchronous fetch with a fixed timeout, no retries, raw status + body back.
 */
export async function fireHook(
  env: HookEnv,
  userId: string,
  bundleId: string,
  input: { hook: string; params?: Record<string, unknown> },
): Promise<FireResult> {
  const { db, config } = env;
  const ctx = await getBundleContext(db, bundleId);
  await requireCapability(db, userId, "fire_hooks", bundleCapabilityCtx(ctx));

  const { hooks } = db.tables;
  const byId = await db.client
    .select()
    .from(hooks)
    .where(and(eq(hooks.bundleId, bundleId), eq(hooks.id, input.hook)));
  const byName =
    byId.length > 0
      ? byId
      : await db.client
          .select()
          .from(hooks)
          .where(and(eq(hooks.bundleId, bundleId), eq(hooks.name, input.hook)));
  const hook = byName[0];
  if (!hook) throw notFound("hook", input.hook);

  // Parameter allowlisting: the safety hinge. Supplied values must match the
  // declared specs exactly — nothing can be added, renamed, or injected.
  const specs = JSON.parse(hook.params) as HookParamSpec[];
  const supplied = input.params ?? {};
  const values: Record<string, string> = {};
  for (const key of Object.keys(supplied)) {
    if (!specs.some((s) => s.name === key)) {
      throw invalid(`unknown hook parameter "${key}" (declared: ${specs.map((s) => s.name).join(", ") || "none"})`);
    }
    const value = supplied[key];
    if (value !== null && value !== undefined) {
      if (typeof value === "object") throw invalid(`hook parameter "${key}" must be a scalar`);
      values[key] = String(value);
    }
  }
  for (const spec of specs) {
    if (spec.required && values[spec.name] === undefined) {
      throw invalid(`required hook parameter "${spec.name}" is missing`);
    }
  }

  // Decrypted transport exists only in memory, only here.
  const transport = JSON.parse(decryptSecret(hook.transportEncrypted, config.masterKey)) as HookTransport;
  const url = substitute(transport.url, values, true);
  await assertPublicDestination(url, config.hookAllowHosts, env.resolver); // DNS can change: re-check at fire time

  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(transport.headers ?? {})) {
    headers[name] = substitute(headerValue, values, false);
  }
  const body =
    transport.body_template !== undefined && transport.method !== "GET"
      ? substitute(transport.body_template, values, false)
      : undefined;

  const fetchImpl = env.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.hookTimeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: transport.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
      redirect: "manual", // redirects could bounce to private targets
    });
    return { status: response.status, body: await response.text() };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new YapError(
        "internal",
        `hook timed out after ${config.hookTimeoutMs}ms (no automatic retries — retrying is the caller's decision)`,
      );
    }
    throw invalid(`hook request failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
