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
import { invalid, notFound } from "../errors.js";
import { DRIVER_API, type DriverActionSpec, type DriverDefinition, type DriverParamSpec } from "./types.js";

const DRIVER_NAME = /^[a-z][a-z0-9-]{1,63}$/;
const ACTION_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const PARAM_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

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
