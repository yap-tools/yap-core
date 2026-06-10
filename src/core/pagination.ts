/**
 * Cursor pagination, uniform across all list endpoints: cursors are opaque
 * base64 tokens (offset-encoded internally — the contract is the opacity, not
 * the mechanism).
 */
import { invalid } from "./errors.js";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function clampLimit(raw?: string | number): number {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1) throw invalid(`limit must be a positive integer`);
  return Math.min(n, MAX_LIMIT);
}

export function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed.o === "number" && Number.isInteger(parsed.o) && parsed.o >= 0) return parsed.o;
  } catch {
    // fall through
  }
  throw invalid("malformed cursor");
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/** Pass rows fetched with limit+1; trims and computes the next cursor. */
export function toPage<T>(rows: T[], offset: number, limit: number): Page<T> {
  const data = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(offset + limit) : null;
  return { data, nextCursor };
}
