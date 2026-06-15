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
import { Agent, fetch as undiciFetch } from "undici";
import { z } from "zod";

import type { YapConfig } from "../config.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import type { Db } from "../db/index.js";
import { getBundleContext, requireBundleCapability, requireBundleReadAccess } from "./bundles.js";
import { YapError, invalid, notFound } from "./errors.js";
import { assertPublicDestination, createPinningLookup, SSRF_PIN_ERROR_CODE, type Resolver } from "./ssrf.js";
import { newId, nowIso } from "./util.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const PARAM_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

// Each hook shape is defined once: the zod schema validates the REST authoring
// boundary and the TypeScript type is inferred from it, so the public surface
// and the firing path that consumes it cannot drift (mirrors propertyConfig).
// The param-name rule is enforced semantically by validateParamSpecs.

export const hookParamSpecSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
});
export type HookParamSpec = z.infer<typeof hookParamSpecSchema>;

export const hookTransportSchema = z.object({
  url: z.string(),
  method: z.enum(METHODS),
  headers: z.record(z.string(), z.string()).optional(),
  // Raw body with `{{placeholder}}` substitution and NO escaping — the author
  // owns the encoding. Use for non-JSON bodies (form-encoded, XML, text). For
  // JSON, prefer body_json, which escapes values so they cannot break or inject
  // structure.
  body_template: z.string().optional(),
  // Structured JSON body: an arbitrary JSON value (usually an object) whose
  // string leaves may contain `{{placeholder}}` tokens. At fire time the value
  // is rebuilt and serialized with JSON.stringify, so substituted values are
  // always escaped and can never escape their string position. Mutually
  // exclusive with body_template.
  body_json: z.unknown().optional(),
});
export type HookTransport = z.infer<typeof hookTransportSchema>;

export interface HookInfo {
  id: string;
  name: string;
  description: string;
  params: HookParamSpec[];
}

export interface HookEnv {
  db: Db;
  config: YapConfig;
  resolver?: Resolver;
  fetchImpl?: typeof fetch;
}

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
  if (transport.body_template !== undefined && transport.body_json !== undefined) {
    throw invalid("hook transport may set either body_template or body_json, not both");
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
  await requireBundleCapability(db, userId, "edit_hooks", ctx);
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
  await requireBundleCapability(db, userId, "edit_hooks", ctx);
  if (patch.params) validateParamSpecs(patch.params);
  if (patch.transport) await validateTransport(patch.transport, env);
  const name = patch.name !== undefined ? patch.name.trim() : undefined;
  if (name !== undefined && !name) throw invalid("hook name cannot be empty");

  const { hooks } = db.tables;
  if (name !== undefined) {
    const clash = await db.client
      .select({ id: hooks.id })
      .from(hooks)
      .where(and(eq(hooks.bundleId, hook.bundleId), eq(hooks.name, name)));
    if (clash.some((r) => r.id !== hookId)) throw invalid(`a hook named "${name}" already exists in this bundle`);
  }

  await db.client
    .update(hooks)
    .set({
      ...(name !== undefined ? { name } : {}),
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
  await requireBundleCapability(db, userId, "edit_hooks", ctx);
  const { hooks } = db.tables;
  await db.client.delete(hooks).where(eq(hooks.id, hookId));
}

function substitute(template: string, values: Record<string, string>, encode: boolean): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values[name] ?? "";
    return encode ? encodeURIComponent(value) : value;
  });
}

/**
 * Rebuilds a `body_json` value with placeholders filled in. Substitution
 * happens only in string leaves (with raw, unescaped values); the caller then
 * `JSON.stringify`s the result, which escapes every substituted value so it
 * stays inside its string and cannot inject structure. Numbers, booleans, and
 * null pass through untouched; object keys are structure, not data, so they
 * are not substituted.
 */
function materializeJsonBody(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === "string") return substitute(value, values, false);
  if (Array.isArray(value)) return value.map((item) => materializeJsonBody(item, values));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, leaf] of Object.entries(value)) out[key] = materializeJsonBody(leaf, values);
    return out;
  }
  return value;
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
  await requireBundleCapability(db, userId, "fire_hooks", ctx);

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
  // Pre-flight re-check at fire time (DNS can change since authoring). This
  // gives a fast rejection and covers IP-literal destinations, for which undici
  // does not invoke the pinning lookup below. The detailed guard message names
  // the host/IP — fine for the REST authoring path (an operator), but the
  // firing agent must never learn the hidden transport, so collapse any guard
  // failure to a generic policy error here. The connect-time pinning lookup
  // (see the dispatcher below) closes the rebinding window between this check
  // and the actual socket connection.
  try {
    await assertPublicDestination(url, config.hookAllowHosts, env.resolver);
  } catch {
    throw new YapError(
      "forbidden",
      "hook destination is blocked by the SSRF guard; ask an operator to review this hook's configuration",
    );
  }

  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(transport.headers ?? {})) {
    const substituted = substitute(headerValue, values, false);
    // A CR/LF in a substituted value would split the header and inject
    // additional headers; reject rather than silently mangle.
    if (/[\r\n]/.test(substituted)) {
      throw invalid(`hook header "${name}" must not contain a line break after substitution`);
    }
    headers[name] = substituted;
  }

  let body: string | undefined;
  if (transport.method !== "GET") {
    if (transport.body_json !== undefined) {
      body = JSON.stringify(materializeJsonBody(transport.body_json, values));
      // Default the content-type for a JSON body unless the author set one.
      if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
        headers["content-type"] = "application/json";
      }
    } else if (transport.body_template !== undefined) {
      body = substitute(transport.body_template, values, false);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.hookTimeoutMs);
  // Pin DNS to validated addresses: undici's connect.lookup runs the SSRF
  // check on the exact address the socket uses, so a name that resolved public
  // for the pre-flight check above cannot rebind to a private address for the
  // actual connection. Skipped when a fetch is injected (tests).
  const agent = env.fetchImpl ? undefined : new Agent({ connect: { lookup: createPinningLookup(config.hookAllowHosts) } });
  try {
    const response: { status: number; text(): Promise<string> } = env.fetchImpl
      ? await env.fetchImpl(url, {
          method: transport.method,
          headers,
          ...(body !== undefined ? { body } : {}),
          signal: controller.signal,
          redirect: "manual",
        })
      : await undiciFetch(url, {
          method: transport.method,
          headers,
          ...(body !== undefined ? { body } : {}),
          signal: controller.signal,
          redirect: "manual", // redirects could bounce to private targets
          dispatcher: agent,
        });
    return { status: response.status, body: await response.text() };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new YapError(
        "internal",
        `hook timed out after ${config.hookTimeoutMs}ms (no automatic retries — retrying is the caller's decision)`,
      );
    }
    // The connect-time pinning lookup rejects rebound/private addresses; surface
    // it as the same generic SSRF error as the pre-flight check.
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code === SSRF_PIN_ERROR_CODE || (err as { code?: string }).code === SSRF_PIN_ERROR_CODE) {
      throw new YapError(
        "forbidden",
        "hook destination is blocked by the SSRF guard; ask an operator to review this hook's configuration",
      );
    }
    // The underlying fetch error can embed the hidden host (e.g.
    // "ENOTFOUND internal.corp"); keep it out of the agent-facing message.
    throw new YapError("internal", "hook request failed to reach its destination");
  } finally {
    clearTimeout(timer);
    if (agent) await agent.destroy();
  }
}
