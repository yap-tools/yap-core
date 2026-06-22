import { z } from "zod";

import { invalid } from "./errors.js";

export type EditOp =
  | { op: "prepend"; content: string }
  | { op: "append"; content: string }
  | { op: "search_replace"; search: string; replace: string; all?: boolean }
  | { op: "insert_before"; target: string; content: string }
  | { op: "insert_after"; target: string; content: string }
  | { op: "delete"; target: string }
  | { op: "replace_lines"; from: number; to: number; content: string }
  | { op: "delete_lines"; from: number; to: number }

const OP_NAMES = [
  "prepend",
  "append",
  "search_replace",
  "insert_before",
  "insert_after",
  "delete",
  "replace_lines",
  "delete_lines",
] as const;

export const editOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("prepend"), content: z.string() }),
  z.object({ op: z.literal("append"), content: z.string() }),
  z.object({ op: z.literal("search_replace"), search: z.string(), replace: z.string(), all: z.boolean().optional() }),
  z.object({ op: z.literal("insert_before"), target: z.string(), content: z.string() }),
  z.object({ op: z.literal("insert_after"), target: z.string(), content: z.string() }),
  z.object({ op: z.literal("delete"), target: z.string() }),
  z.object({
    op: z.literal("replace_lines"),
    from: z.number().int().positive(),
    to: z.number().int().positive(),
    content: z.string(),
  }),
  z.object({
    op: z.literal("delete_lines"),
    from: z.number().int().positive(),
    to: z.number().int().positive(),
  }),
]);

function applyOp(text: string, op: EditOp, idx: number): string {
  const lbl = `edits[${idx}]`;
  switch (op.op) {
    case "prepend":
      return op.content + text;
    case "append":
      return text + op.content;
    case "search_replace": {
      if (!op.search) throw invalid(`${lbl}: search must be non-empty`);
      if (op.all) {
        if (!text.includes(op.search)) throw invalid(`${lbl}: search string not found`);
        return text.split(op.search).join(op.replace);
      }
      const first = text.indexOf(op.search);
      if (first === -1) throw invalid(`${lbl}: search string not found`);
      const second = text.indexOf(op.search, first + 1);
      if (second !== -1) {
        throw invalid(`${lbl}: search string matches more than once; use all: true to replace all occurrences`);
      }
      return text.slice(0, first) + op.replace + text.slice(first + op.search.length);
    }
    case "insert_before": {
      if (!op.target) throw invalid(`${lbl}: target must be non-empty`);
      const i = text.indexOf(op.target);
      if (i === -1) throw invalid(`${lbl}: target string not found`);
      return text.slice(0, i) + op.content + text.slice(i);
    }
    case "insert_after": {
      if (!op.target) throw invalid(`${lbl}: target must be non-empty`);
      const i = text.indexOf(op.target);
      if (i === -1) throw invalid(`${lbl}: target string not found`);
      const end = i + op.target.length;
      return text.slice(0, end) + op.content + text.slice(end);
    }
    case "delete": {
      if (!op.target) throw invalid(`${lbl}: target must be non-empty`);
      const i = text.indexOf(op.target);
      if (i === -1) throw invalid(`${lbl}: target string not found`);
      return text.slice(0, i) + text.slice(i + op.target.length);
    }
    case "replace_lines": {
      if (op.from > op.to) throw invalid(`${lbl}: from (${op.from}) must be <= to (${op.to})`);
      const lines = text.split("\n");
      if (op.from > lines.length) {
        throw invalid(`${lbl}: from (${op.from}) exceeds document length (${lines.length} lines)`);
      }
      if (op.to > lines.length) {
        throw invalid(`${lbl}: to (${op.to}) exceeds document length (${lines.length} lines)`);
      }
      const replacement = op.content === "" ? [] : op.content.split("\n");
      return [...lines.slice(0, op.from - 1), ...replacement, ...lines.slice(op.to)].join("\n");
    }
    case "delete_lines": {
      if (op.from > op.to) throw invalid(`${lbl}: from (${op.from}) must be <= to (${op.to})`);
      const lines = text.split("\n");
      if (op.from > lines.length) {
        throw invalid(`${lbl}: from (${op.from}) exceeds document length (${lines.length} lines)`);
      }
      if (op.to > lines.length) {
        throw invalid(`${lbl}: to (${op.to}) exceeds document length (${lines.length} lines)`);
      }
      return [...lines.slice(0, op.from - 1), ...lines.slice(op.to)].join("\n");
    }
    default:
      throw invalid(
        `edits[${idx}]: unknown op "${(op as { op: string }).op}" (expected one of: ${OP_NAMES.join(", ")})`,
      );
  }
}

export function applyEdits(content: string, ops: EditOp[]): string {
  if (!Array.isArray(ops) || ops.length === 0) throw invalid("edits must be a non-empty array");
  let result = content;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (typeof (op as { op?: unknown }).op !== "string") {
      throw invalid(`edits[${i}]: each edit must have an "op" field`);
    }
    result = applyOp(result, op, i);
  }
  return result;
}
