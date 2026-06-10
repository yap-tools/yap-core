/**
 * Hooks: named, outbound, parameterized HTTP calls owned by a bundle. The
 * transport (URL, method, headers, secrets) is stored encrypted and is never
 * returned by any surface — agents see only name, description, and declared
 * parameters. (Authoring, the SSRF guard, and firing land with M5; the
 * listing here is what load_bundle and hook discovery expose.)
 */
import { asc, eq } from "drizzle-orm";

import type { Db } from "../db/index.js";

export interface HookParamSpec {
  name: string;
  description?: string;
  required?: boolean;
}

export interface HookInfo {
  id: string;
  name: string;
  description: string;
  params: HookParamSpec[];
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
