/**
 * Machine-readable driver config schemas.
 *
 * A driver may publish the shape of its service config as a JSON Schema plus
 * the list of paths inside it that hold secrets (passwords, tokens, private
 * keys). Clients read it to build a config form, and to know which fields to
 * mask, never echo, and keep apart from ordinary settings. It is optional: a
 * driver without one is just as valid and behaves exactly as before, and its
 * `validateConfig` stays the only authority on what a config may contain. The
 * schema describes; it does not validate at run time.
 *
 * Secret paths are dot-separated property names from the root of the config
 * object (`oauth2.client_secret`). A `*` segment stands for every key of a map
 * (a JSON Schema object with `additionalProperties`), so `headers.*` marks
 * every header value. A path must resolve inside the schema; the registry
 * refuses a driver whose path does not, so a renamed field cannot silently
 * drop its secret marking.
 *
 * Like the rest of the driver contract, an external driver's schema arrives as
 * plain JavaScript, so `validateConfigSchema` checks it structurally at load
 * time and names the offending field.
 */
import { z } from "zod";

import { invalid } from "../errors.js";

/** One field a driver marks as secret. */
export interface DriverSecretField {
  /** Dot path from the config root; `*` matches any key of a map. */
  path: string;
  /** Short human label for a form field, e.g. "App password". */
  label: string;
  /** One or two sentences on what goes there and where to get it. */
  description?: string;
  /**
   * The settings that decide where this secret is sent: dot paths of
   * non-secret fields (`url`, `smtp`). An update over MCP that changes any of
   * them drops the stored secret, so it has to be entered again by a human,
   * and an agent cannot point a credential at a server of its own. Omitted:
   * the secret stays through any settings change.
   */
  boundTo?: string[];
}

/**
 * One place a service on this driver sends data: a setting (the http `url`,
 * the mail `smtp` server) or a parameter (the mail `to` address). The approve
 * page and the secret form show these first, with their values, so a person
 * sees where data goes before they let a service run or hand it a secret.
 * Exactly one of `setting` and `param`.
 */
export interface DriverDestination {
  /** Short human label, e.g. "URL" or "SMTP server". */
  label: string;
  /** Dot path of a non-secret field of the config. */
  setting?: string;
  /** A parameter one of the driver's actions declares; shown pinned or as chosen per run. */
  param?: string;
  /** For a `param`: the actions in which it names a destination (the mail
   *  `to` of send, not of search). Omitted: every action that takes it. */
  actions?: string[];
}

export interface DriverConfigSchema {
  /** A JSON Schema (draft 2020-12) for the config object. Its `examples`
   * keyword, when present, holds configs the driver accepts. */
  jsonSchema: Record<string, unknown>;
  /** Every path in the config that holds a secret. May be empty. */
  secrets: DriverSecretField[];
  /** Where a service on this driver sends data. Omitted: the driver names none. */
  destinations?: DriverDestination[];
}

const SEGMENT = /^(?:[A-Za-z0-9_-]+|\*)$/;
const MAX_LABEL = 80;
const MAX_DESCRIPTION = 500;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Generates a driver's JSON Schema from its zod config schema. Uses the
 * *input* side (what an operator writes, before defaults and transforms), and
 * renders anything JSON Schema cannot express (a custom check, a refinement)
 * as an unconstrained `{}` instead of failing; the driver's `validateConfig`
 * still enforces those rules.
 */
export function jsonSchemaFromZod(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
}

/** True for a value JSON can carry unchanged: no functions, undefined, NaN, class instances or cycles. */
function isJsonValue(value: unknown, seen: Set<object> = new Set()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return false;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  const ok = children.every((child) => isJsonValue(child, seen));
  seen.delete(value);
  return ok;
}

/** Follows one segment of a secret path into a JSON Schema node. */
function step(node: Record<string, unknown>, segment: string): Record<string, unknown> | undefined {
  if (segment === "*") {
    return isPlainObject(node.additionalProperties) ? node.additionalProperties : undefined;
  }
  const properties = node.properties;
  if (!isPlainObject(properties)) return undefined;
  const child = properties[segment];
  return isPlainObject(child) ? child : undefined;
}

/** True when every segment of `path` names a property (or map value) that the schema declares. */
export function secretPathResolves(jsonSchema: Record<string, unknown>, path: string): boolean {
  let node: Record<string, unknown> | undefined = jsonSchema;
  for (const segment of path.split(".")) {
    node = step(node, segment);
    if (!node) return false;
  }
  return true;
}

/**
 * Structural check of a driver's `configSchema`, run by the registry for
 * built-in and external drivers alike. `field` prefixes every message so the
 * operator sees which driver and which part failed.
 */
export function validateConfigSchema(raw: unknown, field: string): DriverConfigSchema {
  if (!isPlainObject(raw)) {
    throw invalid(`${field} must be an object with jsonSchema and secrets when present`);
  }
  const { jsonSchema, secrets } = raw;
  if (!isPlainObject(jsonSchema)) {
    throw invalid(`${field}.jsonSchema must be a JSON Schema object`);
  }
  if (jsonSchema.type !== "object") {
    throw invalid(`${field}.jsonSchema must describe an object (type: "object")`);
  }
  if (!isJsonValue(jsonSchema)) {
    // A function, undefined, a class instance or a cycle would survive here and
    // then break every listing that serialises or copies the schema.
    throw invalid(`${field}.jsonSchema must be plain JSON (objects, arrays, strings, finite numbers, booleans, null)`);
  }
  if (!Array.isArray(secrets)) {
    throw invalid(`${field}.secrets must be an array (empty when nothing is secret)`);
  }
  const seen = new Set<string>();
  for (const [index, entry] of secrets.entries()) {
    const at = `${field}.secrets[${index}]`;
    if (!isPlainObject(entry)) throw invalid(`${at} must be an object with path and label`);
    const { path, label, description } = entry;
    if (typeof path !== "string" || path === "" || !path.split(".").every((s) => SEGMENT.test(s))) {
      throw invalid(`${at}.path must be a dot path of property names (or *), got ${JSON.stringify(path)}`);
    }
    if (seen.has(path)) throw invalid(`${field}.secrets lists "${path}" twice`);
    seen.add(path);
    if (!secretPathResolves(jsonSchema, path)) {
      throw invalid(`${at}.path "${path}" does not name a field in jsonSchema`);
    }
    if (typeof label !== "string" || label.trim() === "" || label.length > MAX_LABEL) {
      throw invalid(`${at}.label must be a non-empty string of at most ${MAX_LABEL} characters`);
    }
    if (description !== undefined && (typeof description !== "string" || description.length > MAX_DESCRIPTION)) {
      throw invalid(`${at}.description must be a string of at most ${MAX_DESCRIPTION} characters when present`);
    }
    const { boundTo } = entry;
    if (boundTo !== undefined) {
      if (!Array.isArray(boundTo)) throw invalid(`${at}.boundTo must be an array of dot paths when present`);
      for (const bound of boundTo) {
        if (typeof bound !== "string" || bound === "" || !bound.split(".").every((s) => SEGMENT.test(s) && s !== "*")) {
          throw invalid(`${at}.boundTo entries must be dot paths of property names, got ${JSON.stringify(bound)}`);
        }
        if (!secretPathResolves(jsonSchema, bound)) {
          throw invalid(`${at}.boundTo "${bound}" does not name a field in jsonSchema`);
        }
      }
    }
  }
  // A binding must name a setting, not a secret: checked once every secret path is known.
  const isSecret = (setting: string): boolean => {
    const b = setting.split(".");
    return [...seen].some((path) => {
      const p = path.split(".");
      return p.length <= b.length && p.every((seg, i) => seg === "*" || seg === b[i]);
    });
  };
  for (const [index, entry] of (secrets as Array<Record<string, unknown>>).entries()) {
    for (const bound of (entry.boundTo as string[] | undefined) ?? []) {
      if (isSecret(bound)) throw invalid(`${field}.secrets[${index}].boundTo "${bound}" is a secret path, not a setting`);
    }
  }
  const { destinations } = raw;
  if (destinations !== undefined) {
    if (!Array.isArray(destinations)) throw invalid(`${field}.destinations must be an array when present`);
    for (const [index, entry] of destinations.entries()) {
      const at = `${field}.destinations[${index}]`;
      if (!isPlainObject(entry)) throw invalid(`${at} must be an object with label and setting or param`);
      const { label, setting, param } = entry;
      if (typeof label !== "string" || label.trim() === "" || label.length > MAX_LABEL) {
        throw invalid(`${at}.label must be a non-empty string of at most ${MAX_LABEL} characters`);
      }
      if ((setting === undefined) === (param === undefined)) throw invalid(`${at} needs exactly one of setting and param`);
      if (setting !== undefined) {
        if (typeof setting !== "string" || setting === "" || !setting.split(".").every((s) => SEGMENT.test(s) && s !== "*")) {
          throw invalid(`${at}.setting must be a dot path of property names, got ${JSON.stringify(setting)}`);
        }
        if (!secretPathResolves(jsonSchema, setting)) throw invalid(`${at}.setting "${setting}" does not name a field in jsonSchema`);
        if (isSecret(setting)) throw invalid(`${at}.setting "${setting}" is a secret path, not a setting`);
      }
      // A param is checked against the driver's actions by the registry, which knows them.
      if (param !== undefined && (typeof param !== "string" || param === "")) {
        throw invalid(`${at}.param must be a parameter name`);
      }
      const { actions } = entry;
      if (actions !== undefined) {
        if (param === undefined) throw invalid(`${at}.actions applies to a param destination only`);
        if (!Array.isArray(actions) || actions.length === 0 || actions.some((a) => typeof a !== "string" || a === "")) {
          throw invalid(`${at}.actions must be a non-empty array of action names when present`);
        }
      }
    }
  }
  return raw as unknown as DriverConfigSchema;
}
