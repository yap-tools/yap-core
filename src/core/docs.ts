/**
 * Bundle docs: the one documentation document a bundle carries. Docs are
 * operating instructions the agent must follow — load_bundle and read_docs
 * return them; update_docs / PUT replaces them.
 */
import { eq } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { bundleCapabilityCtx, getBundleContext, requireBundleReadAccess } from "./bundles.js";
import { requireCapability } from "./capabilities.js";
import { invalid } from "./errors.js";
import { nowIso } from "./util.js";

export async function readDocs(db: Db, userId: string, bundleId: string): Promise<{ docs: string }> {
  const ctx = await getBundleContext(db, bundleId);
  await requireBundleReadAccess(db, userId, ctx);
  return { docs: ctx.bundle.docs };
}

export async function updateDocs(db: Db, userId: string, bundleId: string, docs: string): Promise<{ docs: string }> {
  if (typeof docs !== "string") throw invalid("docs must be a string");
  const ctx = await getBundleContext(db, bundleId);
  await requireCapability(db, userId, "edit_docs", bundleCapabilityCtx(ctx));
  const { bundles } = db.tables;
  await db.client.update(bundles).set({ docs, updatedAt: nowIso() }).where(eq(bundles.id, bundleId));
  return { docs };
}
