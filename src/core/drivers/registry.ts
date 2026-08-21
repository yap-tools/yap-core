/**
 * The driver registry: the in-process table of installed drivers, plus the
 * structural validation that guards it.
 *
 * Driver modules are plain JavaScript from outside the type system — an
 * operator's file, a package, or a built-in — so nothing about the shape in
 * types.ts can be assumed at runtime. `validateDriverDefinition` is the
 * boundary check: it runs when a driver is registered at boot AND when an
 * operator runs `yap driver add`, so a malformed module fails at install time
 * with a message naming the offending field, rather than at fire time with a
 * TypeError deep inside a run. That is why the checks are hand-written rather
 * than zod: the errors an operator reads have to point at
 * `actions.send.timeoutMs`, not at a schema path.
 */
import { MAX_TIMER_MS } from "../../config.js";
import { invalid, notFound } from "../errors.js";
import { DRIVER_API, type DriverActionSpec, type DriverDefinition, type DriverParamSpec } from "./types.js";

/** Stable identifier used in service records and CLI (also enforced by `yap driver add`). */
export const DRIVER_NAME = /^[a-z][a-z0-9-]{1,63}$/;
const ACTION_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
/** The rule for a parameter name, wherever one is declared: in a driver's own
 *  action specs (checked here) or on a service record (services.ts). One rule,
 *  because a spec from either source ends up in the same allowlist. */
export const PARAM_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireBoolean(value: unknown, field: string): void {
  if (typeof value !== "boolean") {
    throw invalid(`driver ${field} must be a boolean, got ${describe(value)}`);
  }
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return JSON.stringify(value);
}

function validateParams(params: unknown, field: string): void {
  if (params === null) return; // specs come from the service record
  if (!Array.isArray(params)) {
    throw invalid(`driver ${field} must be an array of parameter specs or null, got ${describe(params)}`);
  }
  const seen = new Set<string>();
  for (const [index, raw] of params.entries()) {
    if (!isPlainObject(raw)) {
      throw invalid(`driver ${field}[${index}] must be an object, got ${describe(raw)}`);
    }
    const spec = raw as unknown as DriverParamSpec;
    if (typeof spec.name !== "string" || !PARAM_NAME.test(spec.name)) {
      throw invalid(
        `driver ${field}[${index}].name must match ${PARAM_NAME.source}, got ${describe(spec.name)}`,
      );
    }
    if (seen.has(spec.name)) throw invalid(`driver ${field} has a duplicate parameter "${spec.name}"`);
    seen.add(spec.name);
    if (spec.description !== undefined && typeof spec.description !== "string") {
      throw invalid(`driver ${field}[${index}].description must be a string when present`);
    }
    if (spec.required !== undefined && typeof spec.required !== "boolean") {
      throw invalid(`driver ${field}[${index}].required must be a boolean when present`);
    }
  }
}

function validateAction(name: string, raw: unknown): void {
  const field = `actions.${name}`;
  if (!ACTION_NAME.test(name)) {
    throw invalid(`driver action name "${name}" must match ${ACTION_NAME.source}`);
  }
  if (!isPlainObject(raw)) {
    throw invalid(`driver ${field} must be an object, got ${describe(raw)}`);
  }
  const action = raw as unknown as DriverActionSpec;
  if (typeof action.description !== "string" || action.description.trim() === "") {
    throw invalid(`driver ${field}.description must be a non-empty string`);
  }
  if (!("params" in raw)) {
    throw invalid(`driver ${field}.params is required (use null to take specs from the service record)`);
  }
  validateParams(action.params, `${field}.params`);
  if (typeof action.timeoutMs !== "number" || !Number.isInteger(action.timeoutMs) || action.timeoutMs <= 0) {
    throw invalid(`driver ${field}.timeoutMs must be a positive integer, got ${describe(action.timeoutMs)}`);
  }
  // The budget becomes a setTimeout delay in the runner, and Node stores that
  // as a 32-bit signed int: anything above the ceiling silently wraps to ~1ms,
  // turning "a very generous budget" into "aborts immediately". Refused here,
  // where the message can still name the field, rather than at fire time.
  if (action.timeoutMs > MAX_TIMER_MS) {
    throw invalid(
      `driver ${field}.timeoutMs must be at most ${MAX_TIMER_MS} (the longest delay a timer can hold), got ${action.timeoutMs}`,
    );
  }
}

/**
 * Structural check of an untrusted driver module's default export. Returns the
 * same object, narrowed, so callers can `const def = validateDriverDefinition(mod)`.
 */
export function validateDriverDefinition(def: unknown): DriverDefinition {
  if (!isPlainObject(def)) {
    throw invalid(`driver definition must be an object, got ${describe(def)}`);
  }
  if (typeof def.name !== "string" || !DRIVER_NAME.test(def.name)) {
    throw invalid(`driver name must match ${DRIVER_NAME.source}, got ${describe(def.name)}`);
  }
  if (def.api !== DRIVER_API) {
    throw invalid(
      `driver "${def.name}" declares api ${describe(def.api)}; this build supports driver api ${DRIVER_API}`,
    );
  }
  if (typeof def.description !== "string" || def.description.trim() === "") {
    throw invalid(`driver "${def.name}" description must be a non-empty string`);
  }
  requireBoolean(def.egress, `"${def.name}" egress`);
  if (def.writes !== undefined) {
    if (!isPlainObject(def.writes)) {
      throw invalid(`driver "${def.name}" writes must be an object when present, got ${describe(def.writes)}`);
    }
    for (const surface of ["items", "files"] as const) {
      const value = def.writes[surface];
      if (value !== undefined && typeof value !== "boolean") {
        throw invalid(`driver "${def.name}" writes.${surface} must be a boolean when present`);
      }
    }
    // The field is part of the declared shape but nothing is wired behind it:
    // a driver declaring it would still get a writer with no file surface on
    // it, and would fail at run time believing it had been granted one. Say so
    // at install time instead.
    if (def.writes.files === true) {
      throw invalid(`driver "${def.name}" writes.files is reserved and not yet supported`);
    }
  }
  if (def.configDoc !== undefined && typeof def.configDoc !== "string") {
    throw invalid(`driver "${def.name}" configDoc must be a string when present`);
  }
  if (typeof def.validateConfig !== "function") {
    throw invalid(`driver "${def.name}" must export a validateConfig(config) function`);
  }
  if (def.validateConfigOnline !== undefined && typeof def.validateConfigOnline !== "function") {
    throw invalid(`driver "${def.name}" validateConfigOnline must be a function when present`);
  }
  if (!isPlainObject(def.actions)) {
    throw invalid(`driver "${def.name}" actions must be an object of action specs, got ${describe(def.actions)}`);
  }
  for (const [name, action] of Object.entries(def.actions)) {
    validateAction(name, action);
  }
  if (typeof def.run !== "function") {
    throw invalid(`driver "${def.name}" must export a run(ctx) function`);
  }
  return def as unknown as DriverDefinition;
}

/** The set of drivers this server knows about, keyed by driver name. */
export class DriverRegistry {
  private readonly drivers = new Map<string, DriverDefinition>();

  register(def: DriverDefinition): void {
    const validated = validateDriverDefinition(def);
    if (this.drivers.has(validated.name)) {
      throw invalid(`driver "${validated.name}" is already registered`);
    }
    this.drivers.set(validated.name, validated);
  }

  get(name: string): DriverDefinition {
    const def = this.drivers.get(name);
    if (!def) throw notFound("driver", name);
    return def;
  }

  has(name: string): boolean {
    return this.drivers.has(name);
  }

  /** All registered drivers, name-sorted for stable CLI and boot output. */
  list(): DriverDefinition[] {
    return [...this.drivers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
