/**
 * The value index on `item_values` covers a prefix of each value, not the
 * whole value.
 *
 * A `text` value has no length limit, but Postgres refuses a btree index entry
 * larger than about 2,700 bytes (a third of a page, measured after
 * compression), so indexing the full value made a long, poorly compressible
 * value fail on insert. SQLite has no such limit; it gets the same index shape
 * so the twin schemas stay twins and both adapters plan queries alike.
 *
 * The index is `(property_id, substr(value, 1, VALUE_INDEX_PREFIX))`.
 * `substr` counts characters on both dialects. UTF-8 needs at most 4 bytes
 * per character, so 600 characters is at most 2,400 bytes; with the
 * property id (a 36-character uuid) and tuple overhead the entry stays under
 * the 2,704-byte btree limit even for incompressible 4-byte text.
 *
 * Queries that want the index compare the prefix next to the full value:
 * `substr(iv.value, 1, N) = substr(?, 1, N) AND iv.value = ?`. The prefix
 * test lets the planner use the index; the full test keeps the result exact
 * when two values share their first N characters. This is only sound for
 * equality (and therefore IN): under a deterministic collation equal values
 * have equal prefixes, but under a linguistic collation such as Postgres's
 * default en_US ordering is not prefix-consistent, so range filters keep the
 * full comparison alone. (The equality argument needs a deterministic
 * collation. `value` declares no collation, so it gets the database default,
 * and Postgres only allows deterministic collations as a database default.)
 *
 * Migration 0012 swaps the old full-value index for this one. drizzle-kit
 * (0.31) renders the expression correctly for Postgres but quotes it as if it
 * were column names for SQLite, so the SQLite statement in
 * drizzle/sqlite/0012_value_index_prefix.sql was corrected by hand; the
 * snapshot is as generated and a later `npm run db:generate` sees no drift.
 */
import { type SQL, sql } from "drizzle-orm";

/** Characters of each value covered by the value index. */
export const VALUE_INDEX_PREFIX = 600;

/**
 * The indexed prefix of a value expression: a column, or an operand. Operands
 * are cut by the same SQL `substr` as the index rather than in JS, so the two
 * can never disagree (SQLite's substr, for one, stops at a NUL character).
 */
export function valueIndexPrefix(value: unknown): SQL {
  return sql`substr(${value}, 1, ${sql.raw(String(VALUE_INDEX_PREFIX))})`;
}

/**
 * `column IN (operands)` stated twice: on the indexed prefix, so the planner
 * can use the value index, and on the full value, so the result stays exact
 * past the prefix. One operand is plain equality.
 */
export function indexedValueIn(column: unknown, operands: string[]): SQL {
  const list = (wrap: (v: string) => SQL) => sql.join(operands.map(wrap), sql.raw(", "));
  return sql`${valueIndexPrefix(column)} IN (${list(valueIndexPrefix)}) AND ${column} IN (${list((v) => sql`${v}`)})`;
}
