/**
 * Property constraints ("config"). One source of truth for the per-datatype
 * limits a schema may declare and how they are validated — both at schema
 * authoring time (here) and at item write time (items.ts). REST and MCP both
 * funnel through that core path, so the two surfaces cannot drift.
 *
 * Config is persisted as a JSON-text column on `properties` (empty string =
 * no constraints), mirroring `hooks.params` and staying inside the
 * SQLite∩Postgres subset (no jsonb).
 */
import { z } from "zod";

/** Number properties round-trip with at most this many decimals unless the
 *  schema overrides it; out-of-precision writes are rejected. */
export const NUMBER_DEFAULT_DECIMALS = 2;

export interface PropertyConfig {
  /** text: values must match this regular expression (RegExp.test — anchor
   *  with ^…$ for a full match, JSON-Schema-style unanchored otherwise). */
  pattern?: string;
  /** number: inclusive bounds. */
  min?: number;
  max?: number;
  /** number: maximum fractional digits accepted (default NUMBER_DEFAULT_DECIMALS). */
  decimals?: number;
  /** any multi-valued property: bounds on the number of elements. */
  minItems?: number;
  maxItems?: number;
  /** item: constrain the referent to a target item-type (name or id). */
  itemType?: string;
}

/** Loose shape accepted at the transport boundary; semantics are checked by
 *  validatePropertyConfig so REST and MCP share one rule set. */
export const propertyConfigSchema = z
  .object({
    pattern: z.string(),
    min: z.number(),
    max: z.number(),
    decimals: z.number().int().min(0),
    minItems: z.number().int().min(0),
    maxItems: z.number().int().min(0),
    itemType: z.string(),
  })
  .partial();

/** Which config keys each datatype understands (multi adds minItems/maxItems). */
const KEYS_BY_DATATYPE: Record<string, (keyof PropertyConfig)[]> = {
  text: ["pattern"],
  number: ["min", "max", "decimals"],
  boolean: [],
  date: [],
  item: ["itemType"],
  file: [],
};

export function parseConfig(stored: string | null | undefined): PropertyConfig {
  if (!stored) return {};
  try {
    const parsed = JSON.parse(stored);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PropertyConfig) : {};
  } catch {
    return {};
  }
}

/** Drops undefined/null keys; an empty config serializes to "" (the column default). */
export function serializeConfig(config: PropertyConfig | undefined): string {
  if (!config) return "";
  const entries = Object.entries(config).filter(([, v]) => v !== undefined && v !== null);
  return entries.length === 0 ? "" : JSON.stringify(Object.fromEntries(entries));
}

/**
 * Validates a config object for a datatype + multi flag at schema-authoring
 * time. Returns human-readable error strings (empty = ok) so callers can
 * prefix them with a location and batch-report.
 */
export function validatePropertyConfig(datatype: string, multi: boolean, config: PropertyConfig): string[] {
  const errors: string[] = [];
  const allowed = new Set<string>([...(KEYS_BY_DATATYPE[datatype] ?? []), ...(multi ? ["minItems", "maxItems"] : [])]);
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null) continue;
    if (!allowed.has(key)) {
      errors.push(`config.${key} is not valid for a ${multi ? "multi " : ""}${datatype} property`);
    }
  }
  if (config.pattern !== undefined) {
    try {
      new RegExp(config.pattern);
    } catch {
      errors.push(`config.pattern is not a valid regular expression`);
    }
  }
  if (config.decimals !== undefined && (!Number.isInteger(config.decimals) || config.decimals < 0)) {
    errors.push(`config.decimals must be a non-negative integer`);
  }
  if (config.min !== undefined && config.max !== undefined && config.min > config.max) {
    errors.push(`config.min (${config.min}) cannot exceed config.max (${config.max})`);
  }
  if (config.minItems !== undefined && config.maxItems !== undefined && config.minItems > config.maxItems) {
    errors.push(`config.minItems (${config.minItems}) cannot exceed config.maxItems (${config.maxItems})`);
  }
  return errors;
}

/** Counts fractional digits, robust to exponent notation (e.g. 1e-7). */
export function countDecimals(n: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n)) return 0;
  const s = Math.abs(n).toString();
  if (s.includes("e-")) {
    const [mantissa = "", exp = "0"] = s.split("e-");
    const mantDecimals = mantissa.includes(".") ? mantissa.split(".")[1]!.length : 0;
    return mantDecimals + Number(exp);
  }
  if (s.includes("e")) return 0; // large magnitude — integral for our purposes
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}
