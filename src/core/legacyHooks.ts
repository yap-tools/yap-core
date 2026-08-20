/**
 * The legacy hook compatibility layer — one module, so the old shape lives in
 * exactly one place and dies in one edit at 1.0.
 *
 * A hook *was* a service with the built-in `http` driver: a name, a
 * description, and one flat list of parameters. Everything the pre-services
 * surfaces still promise is a translation of that fact, and all of it is here:
 *
 * - `LEGACY_DRIVER` — the driver a hook was, and the only one these surfaces
 *   speak for. It is the same constant as the services layer's default driver
 *   (a service naming no driver gets the one every hook had), not a second
 *   literal that could drift from it.
 * - `toLegacyHookView` — the old four-field projection, used by both the REST
 *   hook mounts and `load_bundle`'s `hooks` array.
 * - `requireLegacyHook` — the http-only gate in front of the old mounts.
 * - `fireLegacyHook` — the synchronous fire the old contract promised, on top
 *   of the async runner.
 *
 * Two rules hold across all of it. A service on any other driver has no old
 * shape to be rendered, edited, deleted, or fired through, so it must read as
 * *no hook at all* rather than being reshaped into one. And that driver check
 * always sits behind a capability gate: the two `notFound` messages it can
 * raise ("service … not found" from resolving the row, "hook … not found" from
 * the driver check) are distinguishable, so an ungated check would hand a
 * caller with no access to the bundle an existence oracle — "this id is a
 * service, just not an http one" — that the core's own capability checks would
 * never let them have.
 */
import type { Db } from "../db/index.js";
import { getBundleContext, requireBundleCapability } from "./bundles.js";
import { type ErrorCode, notFound, YapError } from "./errors.js";
import { resolveServiceRow, runService, type RunEnv, type RunRecord } from "./runs.js";
import { DEFAULT_DRIVER, getServiceRef, type ServiceInfo, type ServiceParamSpec } from "./services.js";

/**
 * The driver every hook was. Shared with the services layer's default rather
 * than re-declared: "the driver a service gets when it names none" and "the
 * driver a hook was" are the same fact, and one of them moving without the
 * other would silently unhook the legacy surfaces.
 */
export const LEGACY_DRIVER = DEFAULT_DRIVER;

/** The old hook view of a service: its single http action's parameters. */
export function toLegacyHookView(info: ServiceInfo): {
  id: string;
  name: string;
  description: string;
  params: ServiceParamSpec[];
} {
  return {
    id: info.id,
    name: info.name,
    description: info.description,
    params: info.actions[0]?.params ?? [],
  };
}

/**
 * The http-only gate in front of every legacy hook surface. Returns the
 * resolved bundle so a caller that started from a bare hook id (the
 * `/v1/hooks/:id` mounts) does not have to fetch the row a second time.
 *
 * Two entries, because the two adapters know different things:
 *
 * - No `bundleId` (REST, which routes on the service id alone): the row is
 *   what says which bundle to gate on, so it is fetched first — one read that
 *   yields both the bundle and the driver — and an id that names nothing is
 *   the ordinary `service … not found`.
 * - With a `bundleId` (MCP, whose call is already scoped to a bundle and whose
 *   `ref` may be a name): the bundle gate is checked *before* the reference is
 *   resolved, in the same order `runService` checks it, so this cannot become
 *   an existence oracle for a caller without the capability.
 */
export async function requireLegacyHook(
  db: Db,
  userId: string,
  ref: string,
  capability: "edit_services" | "run_services",
  bundleId?: string,
): Promise<{ bundleId: string }> {
  if (bundleId === undefined) {
    const service = await getServiceRef(db, ref);
    const ctx = await getBundleContext(db, service.bundleId);
    await requireBundleCapability(db, userId, capability, ctx);
    if (service.driver !== LEGACY_DRIVER) throw notFound("hook", ref);
    return { bundleId: service.bundleId };
  }
  const ctx = await getBundleContext(db, bundleId);
  await requireBundleCapability(db, userId, capability, ctx);
  const service = await resolveServiceRow(db, bundleId, ref);
  if (service.driver !== LEGACY_DRIVER) throw notFound("hook", ref);
  return { bundleId };
}

/**
 * Turns a non-succeeded run back into a thrown error, for the legacy fire
 * surfaces whose contract is synchronous: they promised a result or an error,
 * never a run id.
 *
 * The verdict comes from `run.errorCode`, which the executor copied off the
 * driver's own `YapError` — so a destination the guard refused is still a 403
 * and a call the driver rejected (a CRLF in a substituted header, say) is
 * still a 400, rather than both collapsing into a 500. Codes outside that pair
 * are deliberately flattened to `internal`: a timeout, an unserializable
 * result, or a driver bug are all "the server could not complete this", and a
 * 404/409 leaking out here would read as a statement about the *hook*.
 */
export function runFailureError(run: RunRecord, fallbackMessage: string): YapError {
  const message = run.error ?? fallbackMessage;
  const code: ErrorCode =
    run.errorCode === "forbidden" || run.errorCode === "invalid_request" ? run.errorCode : "internal";
  return new YapError(code, message);
}

/**
 * The whole legacy fire, for both adapters: gate, run, translate.
 *
 * A fire is synchronous by contract, so this internal caller waits past the
 * action's own budget (deliberately uncapped — see the clamp note in runs.ts)
 * and therefore always has a terminal run to translate: the driver's result on
 * success, the driver's own verdict re-thrown on failure.
 *
 * `bundleId` is optional for the same reason `requireLegacyHook` takes it that
 * way — REST arrives with a hook id and nothing else, and the gate is what
 * tells it which bundle the run belongs to.
 */
export async function fireLegacyHook(
  env: RunEnv,
  userId: string,
  ref: string,
  params: Record<string, unknown> | undefined,
  bundleId?: string,
): Promise<unknown> {
  const target = await requireLegacyHook(env.db, userId, ref, "run_services", bundleId);
  const waitMs = env.config.hookTimeoutMs + 500;
  const run = await runService(env, userId, target.bundleId, { service: ref, params, waitMs });
  if (run.status === "succeeded") return run.result;
  // The run's error is already agent-safe (the driver sanitizes it), so it is
  // what the caller sees, unchanged.
  throw runFailureError(run, `hook did not finish within ${waitMs}ms`);
}
