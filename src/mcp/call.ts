/**
 * The second-tier catalog: tools dispatched through `call`, each a thin
 * adapter over the core (which enforces the capability gates itself). The
 * table also carries the metadata `load` and `load_bundle` use to advertise
 * the catalog. File and hook tools register here in their milestones.
 */
import type { YapConfig } from "../config.js";
import type { Db } from "../db/index.js";
import * as docsCore from "../core/docs.js";
import * as itemsCore from "../core/items.js";
import { YapError } from "../core/errors.js";

export interface CallEnv {
  db: Db;
  config: YapConfig;
  userId: string;
  bundleId: string;
  baseUrl: string;
}

export interface SecondTierResult {
  result: unknown;
  /** Widget pointer (ui:// resource + data) for hosts that render result UI. */
  _meta?: { widget: string; data: Record<string, unknown> };
}

export interface SecondTierTool {
  description: string;
  /** Capability the core enforces — advertised so agents can reason about access. */
  capability: string;
  handler: (env: CallEnv, params: Record<string, unknown>) => Promise<SecondTierResult>;
}

export const secondTier: Record<string, SecondTierTool> = {
  query_items: {
    description:
      "Filtered, sorted, paginated item retrieval. Params: item_type (name or id), filters (array of {property, op, value}; ops: eq, neq, contains, gt, gte, lt, lte, in; AND-combined), sort ({property, direction}), cursor, limit.",
    capability: "read_items",
    handler: async (env, params) => {
      const page = await itemsCore.queryItems(env.db, env.userId, env.bundleId, {
        itemType: String(params.item_type ?? params.itemType ?? ""),
        filters: params.filters as itemsCore.ItemFilter[] | undefined,
        sort: params.sort as itemsCore.ItemSort | undefined,
        cursor: params.cursor as string | undefined,
        limit: params.limit as number | undefined,
      });
      return { result: page };
    },
  },
  get_items: {
    description: "Fetch specific items by id. Params: ids (array of item ids).",
    capability: "read_items",
    handler: async (env, params) => ({
      result: await itemsCore.getItems(env.db, env.userId, env.bundleId, params.ids as string[]),
    }),
  },
  create_items: {
    description:
      "Batch-create items of an item-type with write-time validation. Params: item_type, items (array of {propertyName: value} objects).",
    capability: "edit_items",
    handler: async (env, params) => ({
      result: await itemsCore.createItems(env.db, env.userId, env.bundleId, {
        itemType: String(params.item_type ?? params.itemType ?? ""),
        items: params.items as Record<string, unknown>[],
      }),
    }),
  },
  update_items: {
    description:
      "Batch-update item values. Params: updates (array of {id, set: {propertyName: value | null}}; null clears an optional property).",
    capability: "edit_items",
    handler: async (env, params) => ({
      result: await itemsCore.updateItems(
        env.db,
        env.userId,
        env.bundleId,
        params.updates as { id: string; set: Record<string, unknown> }[],
      ),
    }),
  },
  delete_items: {
    description: "Delete items by id. Params: ids (array of item ids).",
    capability: "edit_items",
    handler: async (env, params) => ({
      result: { deleted: await itemsCore.deleteItems(env.db, env.userId, env.bundleId, params.ids as string[]) },
    }),
  },
  read_docs: {
    description: "Return the bundle's docs (also returned by load_bundle). No params.",
    capability: "(bundle read access)",
    handler: async (env) => ({ result: await docsCore.readDocs(env.db, env.userId, env.bundleId) }),
  },
  update_docs: {
    description: "Replace the bundle's docs. Params: docs (string).",
    capability: "edit_docs",
    handler: async (env, params) => ({
      result: await docsCore.updateDocs(env.db, env.userId, env.bundleId, String(params.docs ?? "")),
    }),
  },
};

export interface PerCallResult {
  bundle_id: string;
  tool: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
  _meta?: { widget: string; data: Record<string, unknown> };
}

/** Executes one call from a batch; never throws — failures are per-call results. */
export async function executeCall(
  env: Omit<CallEnv, "bundleId">,
  spaceId: string,
  call: { bundle_id: string; tool: string; params?: Record<string, unknown> },
  bundleSpaceLookup: (bundleId: string) => Promise<string | null>,
): Promise<PerCallResult> {
  const base = { bundle_id: call.bundle_id, tool: call.tool };
  try {
    const tool = secondTier[call.tool];
    if (!tool) {
      throw new YapError(
        "invalid_request",
        `unknown tool "${call.tool}" (available: ${Object.keys(secondTier).join(", ")})`,
      );
    }
    const bundleSpace = await bundleSpaceLookup(call.bundle_id);
    if (bundleSpace === null) throw new YapError("not_found", `bundle ${call.bundle_id} not found`);
    if (bundleSpace !== spaceId) {
      throw new YapError("invalid_request", `bundle ${call.bundle_id} is not in space ${spaceId}`);
    }
    const { result, _meta } = await tool.handler({ ...env, bundleId: call.bundle_id }, call.params ?? {});
    return { ...base, ok: true, result, ...(_meta ? { _meta } : {}) };
  } catch (err) {
    if (err instanceof YapError) {
      return {
        ...base,
        ok: false,
        error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
      };
    }
    return { ...base, ok: false, error: { code: "internal", message: (err as Error).message } };
  }
}
