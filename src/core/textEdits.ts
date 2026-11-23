import { z } from "zod";

import { invalid } from "./errors.js";

/**
 * Surgical text edits: the ops every edit path (item text properties, bundle
 * docs, user docs, a service driver's write-back) applies through
 * `applyEdits`. The ops arrive from callers as untyped JSON, so `applyEdits`
 * validates the whole array strictly before applying any op: an unknown op, an
 * unknown key, or a missing, null or wrong-typed operand is refused with an
 * `invalid_request` that names the op index and the key, and nothing is
 * written. Transports pass the array through unchecked; this is the one check.
 */

export type EditOp =
  | { op: "prepend"; content: string }
  | { op: "append"; content: string }
  | { op: "search_replace"; search: string; replace: string; all?: boolean }
  | { op: "insert_before"; target: string; content: string }
  | { op: "insert_after"; target: string; content: string }
  | { op: "delete"; target: string }
  | { op: "replace_lines"; from: number; to: number; content: string }
  | { op: "delete_lines"; from: number; to: number };

type OpName = EditOp["op"];

const line = z.number().int().positive();

/**
 * One strict schema per op: a key the op does not take is refused rather than
 * stripped, since a silently dropped key (a guessed `value` for `content`) is
 * how a malformed op used to slip through.
 */
const OP_SCHEMAS = {
  prepend: z.strictObject({ op: z.literal("prepend"), content: z.string() }),
  append: z.strictObject({ op: z.literal("append"), content: z.string() }),
  search_replace: z.strictObject({
    op: z.literal("search_replace"),
    search: z.string(),
    replace: z.string(),
    all: z.boolean().optional(),
  }),
  insert_before: z.strictObject({ op: z.literal("insert_before"), target: z.string(), content: z.string() }),
  insert_after: z.strictObject({ op: z.literal("insert_after"), target: z.string(), content: z.string() }),
  delete: z.strictObject({ op: z.literal("delete"), target: z.string() }),
  replace_lines: z.strictObject({ op: z.literal("replace_lines"), from: line, to: line, content: z.string() }),
  delete_lines: z.strictObject({ op: z.literal("delete_lines"), from: line, to: line }),
} satisfies Record<OpName, z.ZodType>;

const OP_NAMES = Object.keys(OP_SCHEMAS) as OpName[];

/** The keys each op takes besides `op`, optional ones marked with `?`. */
const OP_KEYS = Object.fromEntries(
  OP_NAMES.map((name) => [
    name,
    Object.entries(OP_SCHEMAS[name].shape as Record<string, z.ZodType>)
      .filter(([key]) => key !== "op")
      .map(([key, schema]) => (schema.safeParse(undefined).success ? `${key}?` : key)),
  ]),
) as Record<OpName, string[]>;

const KEY_TYPES: Record<string, string> = {
  content: "a string",
  search: "a string",
  replace: "a string",
  target: "a string",
  all: "a boolean",
  from: "a positive integer",
  to: "a positive integer",
};

/**
 * Every op's exact shape, for tool descriptions, so a client reads the keys
 * rather than guessing them: `prepend {op, content}; …`.
 */
export const EDIT_OP_SHAPES = OP_NAMES.map((name) => `${name} ${shape(name)}`).join("; ");

/** The rule a client most needs, said once for every description. */
export const EDIT_OP_RULES =
  "Each op is an object with exactly its own keys: a missing, null or wrong-typed operand, or a key the op does not take, is refused with invalid_request and nothing is written. from/to are 1-based line numbers, inclusive.";

function shape(name: OpName): string {
  return `{${["op", ...OP_KEYS[name]].join(", ")}}`;
}

/** One op's problem as one line, or null when it is well-formed. */
function checkOp(raw: unknown, idx: number, issues: unknown[]): string | null {
  const lbl = `edits[${idx}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return `${lbl}: each edit must be an object with an "op" field`;
  }
  const name = (raw as { op?: unknown }).op;
  if (typeof name !== "string") return `${lbl}: each edit must have an "op" field`;
  if (!Object.hasOwn(OP_SCHEMAS, name)) {
    return `${lbl}: unknown op "${name}" (expected one of: ${OP_NAMES.join(", ")})`;
  }
  const op = name as OpName;
  const result = OP_SCHEMAS[op].safeParse(raw);
  if (result.success) return null;
  issues.push(...result.error.issues.map((issue) => ({ ...issue, path: [idx, ...issue.path] })));
  // An unknown key comes first: it is usually a guess at a key's name, and the
  // expected shape it prints names the key that was missed.
  const unknown = result.error.issues.find((issue) => issue.code === "unrecognized_keys");
  if (unknown && unknown.code === "unrecognized_keys") {
    const keys = unknown.keys.map((k) => `"${k}"`).join(", ");
    const noun = unknown.keys.length === 1 ? "key" : "keys";
    return `${lbl}: unknown ${noun} ${keys} for op "${op}"; expected ${shape(op)}`;
  }
  const key = String(result.error.issues[0]!.path[0]);
  const optional = OP_KEYS[op].includes(`${key}?`);
  return optional
    ? `${lbl}: "${op}" takes ${key} as ${KEY_TYPES[key]}, or leave it out`
    : `${lbl}: "${op}" needs ${key} (${KEY_TYPES[key]})`;
}

/**
 * Validate an untyped ops array. Every bad op is reported, in one message; the
 * zod issues (paths prefixed with the op index) ride along in `details`.
 */
function parseEditOps(ops: unknown): EditOp[] {
  if (!Array.isArray(ops) || ops.length === 0) throw invalid("edits must be a non-empty array");
  const problems: string[] = [];
  const issues: unknown[] = [];
  // An indexed loop, not forEach: a hole in a sparse array must be checked too.
  for (let idx = 0; idx < ops.length; idx++) {
    const problem = checkOp(ops[idx], idx, issues);
    if (problem) problems.push(problem);
  }
  if (problems.length > 0) {
    throw invalid(problems.join("; "), issues.length > 0 ? { issues } : undefined);
  }
  return ops as EditOp[];
}

// Second line of defence: applyOp never concatenates or slices with an operand
// that is not what the op needs, even if a caller reached it unvalidated.
function str(op: EditOp, key: string, lbl: string): string {
  const value = (op as Record<string, unknown>)[key];
  if (typeof value !== "string") throw invalid(`${lbl}: "${op.op}" needs ${key} (a string)`);
  return value;
}

function lineNo(op: EditOp, key: "from" | "to", lbl: string): number {
  const value = (op as Record<string, unknown>)[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw invalid(`${lbl}: "${op.op}" needs ${key} (a positive integer)`);
  }
  return value;
}

function lineRange(op: EditOp, text: string, lbl: string): { lines: string[]; from: number; to: number } {
  const from = lineNo(op, "from", lbl);
  const to = lineNo(op, "to", lbl);
  if (from > to) throw invalid(`${lbl}: from (${from}) must be <= to (${to})`);
  const lines = text.split("\n");
  if (from > lines.length) throw invalid(`${lbl}: from (${from}) exceeds document length (${lines.length} lines)`);
  if (to > lines.length) throw invalid(`${lbl}: to (${to}) exceeds document length (${lines.length} lines)`);
  return { lines, from, to };
}

function findTarget(op: EditOp, text: string, lbl: string): { at: number; target: string } {
  const target = str(op, "target", lbl);
  if (!target) throw invalid(`${lbl}: target must be non-empty`);
  const at = text.indexOf(target);
  if (at === -1) throw invalid(`${lbl}: target string not found`);
  return { at, target };
}

function applyOp(text: string, op: EditOp, idx: number): string {
  const lbl = `edits[${idx}]`;
  switch (op.op) {
    case "prepend":
      return str(op, "content", lbl) + text;
    case "append":
      return text + str(op, "content", lbl);
    case "search_replace": {
      const search = str(op, "search", lbl);
      const replace = str(op, "replace", lbl);
      if (!search) throw invalid(`${lbl}: search must be non-empty`);
      if (op.all !== undefined && typeof op.all !== "boolean") {
        throw invalid(`${lbl}: "search_replace" takes all as a boolean, or leave it out`);
      }
      if (op.all) {
        if (!text.includes(search)) throw invalid(`${lbl}: search string not found`);
        return text.split(search).join(replace);
      }
      const first = text.indexOf(search);
      if (first === -1) throw invalid(`${lbl}: search string not found`);
      const second = text.indexOf(search, first + search.length);
      if (second !== -1) {
        throw invalid(`${lbl}: search string matches more than once; use all: true to replace all occurrences`);
      }
      return text.slice(0, first) + replace + text.slice(first + search.length);
    }
    case "insert_before": {
      const content = str(op, "content", lbl);
      const { at } = findTarget(op, text, lbl);
      return text.slice(0, at) + content + text.slice(at);
    }
    case "insert_after": {
      const content = str(op, "content", lbl);
      const { at, target } = findTarget(op, text, lbl);
      const end = at + target.length;
      return text.slice(0, end) + content + text.slice(end);
    }
    case "delete": {
      const { at, target } = findTarget(op, text, lbl);
      return text.slice(0, at) + text.slice(at + target.length);
    }
    case "replace_lines": {
      const content = str(op, "content", lbl);
      const { lines, from, to } = lineRange(op, text, lbl);
      const replacement = content === "" ? [] : content.split("\n");
      return [...lines.slice(0, from - 1), ...replacement, ...lines.slice(to)].join("\n");
    }
    case "delete_lines": {
      const { lines, from, to } = lineRange(op, text, lbl);
      return [...lines.slice(0, from - 1), ...lines.slice(to)].join("\n");
    }
    default:
      throw invalid(`${lbl}: unknown op "${(op as { op: string }).op}" (expected one of: ${OP_NAMES.join(", ")})`);
  }
}

/**
 * Apply ops in order to `content`. All-or-nothing: the whole array is
 * validated first, and any op that fails while applying throws before the
 * caller writes anything. Takes `unknown` because the ops come from callers.
 */
export function applyEdits(content: string, ops: unknown): string {
  const parsed = parseEditOps(ops);
  let result = content;
  for (let i = 0; i < parsed.length; i++) result = applyOp(result, parsed[i]!, i);
  return result;
}
