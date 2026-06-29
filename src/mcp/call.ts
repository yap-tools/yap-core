/**
 * The second-tier catalog: tools dispatched through `call`, each a thin
 * adapter over the core (which enforces the capability gates itself). The
 * table also carries the metadata `load` and `load_bundle` use to advertise
 * the catalog. File and hook tools register here in their milestones.
 */
import type { BlobStore } from "../blob/index.js";
import type { YapConfig } from "../config.js";
import type { Db } from "../db/index.js";
import * as bundlesCore from "../core/bundles.js";
import * as bundleDocsCore from "../core/bundleDocs.js";
import type { BundleDoc } from "../core/bundleDocs.js";
import type { EditOp } from "../core/textEdits.js";
import * as filesCore from "../core/files.js";
import * as grantsCore from "../core/grants.js";
import * as hooksCore from "../core/hooks.js";
import * as itemTypesCore from "../core/itemTypes.js";
import * as itemsCore from "../core/items.js";
import * as spacesCore from "../core/spaces.js";
import type { PropertyConfig } from "../core/propertyConfig.js";
import { YapError } from "../core/errors.js";

/** A second-tier call targets either a bundle (the default) or its space. */
export type TargetKind = "bundle" | "space";

export interface CallEnv {
  db: Db;
  config: YapConfig;
  blob: BlobStore;
  userId: string;
  /** Always the call's space. */
  spaceId: string;
  /** The targeted bundle for bundle-scoped calls; "" for space-scoped calls. */
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
  /** Top-level call params accepted by this tool; nested payloads stay core-owned. */
  params?: Record<string, { required?: boolean; aliases?: string[] }>;
  /** Which target(s) this tool operates on. Defaults to ["bundle"]. */
  targets?: TargetKind[];
  handler: (env: CallEnv, params: Record<string, unknown>) => Promise<SecondTierResult>;
}

/** Maps a core BundleDoc row to the MCP view (autoload as boolean). */
const docView = (d: BundleDoc) => ({ ...d, autoload: d.autoload === 1 });

const noParams: Record<string, never> = {};
const docLookupParams = { doc: { required: true, aliases: ["id"] } };

function formatKeys(keys: string[]): string {
  return `[${keys.join(", ")}]`;
}

function formatExpectedParams(tool: SecondTierTool): string {
  const params = tool.params ?? noParams;
  const names = Object.entries(params).map(([name, spec]) =>
    spec.aliases?.length ? `${name} (aliases: ${spec.aliases.join(", ")})` : name,
  );
  return formatKeys(names);
}

function sameParamValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeParams(toolName: string, tool: SecondTierTool, rawParams: Record<string, unknown>): Record<string, unknown> {
  const specs = tool.params ?? noParams;
  const allowed = new Set<string>();
  for (const [name, spec] of Object.entries(specs)) {
    allowed.add(name);
    for (const alias of spec.aliases ?? []) allowed.add(alias);
  }

  const receivedKeys = Object.keys(rawParams);
  for (const key of receivedKeys) {
    if (!allowed.has(key)) {
      throw new YapError(
        "invalid_request",
        `unknown param '${key}' for tool '${toolName}'; expected params: ${formatExpectedParams(tool)}`,
      );
    }
  }

  const normalized = { ...rawParams };
  for (const [name, spec] of Object.entries(specs)) {
    const provided = [name, ...(spec.aliases ?? [])].filter((key) => Object.prototype.hasOwnProperty.call(rawParams, key));

    if (provided.length > 0) {
      const firstKey = provided[0]!;
      const firstValue = rawParams[firstKey];
      for (const key of provided.slice(1)) {
        if (!sameParamValue(firstValue, rawParams[key])) {
          throw new YapError(
            "invalid_request",
            `conflicting params for '${name}' on tool '${toolName}': received ${formatKeys(provided)}`,
          );
        }
      }
      normalized[name] = firstValue;
    } else if (spec.required) {
      throw new YapError(
        "invalid_request",
        `missing required param '${name}' (params.${name}) for tool '${toolName}'; received keys: ${formatKeys(receivedKeys)}`,
      );
    }
  }

  for (const [name, spec] of Object.entries(specs)) {
    for (const alias of spec.aliases ?? []) {
      if (alias !== name) delete normalized[alias];
    }
  }
  return normalized;
}

/** Builds a grant target from the call's resource (bundle if present, else space). */
function grantTargetFor(env: CallEnv): Promise<grantsCore.GrantTarget> {
  return env.bundleId
    ? bundlesCore.bundleGrantTarget(env.db, env.bundleId)
    : grantsCore.spaceGrantTarget(env.db, env.spaceId);
}

function grantCapabilities(params: Record<string, unknown>): string[] {
  const caps = (params.capabilities as string[] | undefined) ?? (params.capability ? [String(params.capability)] : []);
  if (caps.length === 0) throw new YapError("invalid_request", "capability or capabilities is required");
  return caps;
}

export const secondTier: Record<string, SecondTierTool> = {
  query_items: {
    description:
      'Filtered, sorted, paginated item retrieval. Params: item_type (name or id), filters (array of {property, op, value, quantifier?}; AND-combined), sort ({property, direction}), cursor, limit. Comparison ops: eq, neq, contains, gt, gte, lt, lte, in — e.g. filters: [{property: "status", op: "eq", value: "open"}, {property: "due", op: "lt", value: "2026-07-01"}]. For multi-valued properties a comparison op takes quantifier any (default; some element matches) | all (every element matches) | none (no element matches); set ops match the value set directly: has (contains value), has_any (contains any of an array), has_all (contains all of an array), has_none (contains none of an array) — e.g. {property: "tags", op: "has_any", value: ["work", "urgent"]}.',
    capability: "read_items",
    params: {
      item_type: { aliases: ["itemType"] },
      filters: {},
      sort: {},
      cursor: {},
      limit: {},
    },
    handler: async (env, params) => {
      const page = await itemsCore.queryItems(env.db, env.userId, env.bundleId, {
        itemType: String(params.item_type ?? ""),
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
    params: { ids: { required: true } },
    handler: async (env, params) => ({
      result: await itemsCore.getItems(env.db, env.userId, env.bundleId, params.ids as string[]),
    }),
  },
  create_items: {
    description:
      'Batch-create items of an item-type with write-time validation. Params: item_type, items (array of {propertyName: value} objects; for a multi-valued property pass an array of values) — e.g. items: [{title: "Book travel", status: "open", tags: ["work", "urgent"]}].',
    capability: "edit_items",
    params: { item_type: { aliases: ["itemType"] }, items: { required: true } },
    handler: async (env, params) => ({
      result: await itemsCore.createItems(env.db, env.userId, env.bundleId, {
        itemType: String(params.item_type ?? ""),
        items: params.items as Record<string, unknown>[],
      }),
    }),
  },
  update_items: {
    description:
      "Batch-update item values. Params: updates — array of {id, set?, edits?}. set: {propertyName: value | null} does a full property replacement (null clears an optional property). edits: {propertyName: EditOp[]} applies surgical ops to text properties without replacing the whole value — ops: prepend/append {content}, search_replace {search, replace, all?}, insert_before/insert_after/delete {target[, content]}, replace_lines/delete_lines {from, to[, content]} (1-based). Note: insert_before/insert_after/delete splice at the raw character offset — newlines are your responsibility; replace_lines/delete_lines are line-aware. A property must not appear in both set and edits for the same item. Applied all-or-nothing per item.",
    capability: "edit_items",
    params: { updates: { required: true } },
    handler: async (env, params) => ({
      result: await itemsCore.updateItems(
        env.db,
        env.userId,
        env.bundleId,
        params.updates as { id: string; set?: Record<string, unknown>; edits?: Record<string, EditOp[]> }[],
      ),
    }),
  },
  delete_items: {
    description: "Delete items by id. Params: ids (array of item ids).",
    capability: "edit_items",
    params: { ids: { required: true } },
    handler: async (env, params) => ({
      result: { deleted: await itemsCore.deleteItems(env.db, env.userId, env.bundleId, params.ids as string[]) },
    }),
  },
  get_doc: {
    description: "Read a single bundle doc by name or id. Returns id, name, content, autoload, createdAt, updatedAt. Params: doc (name or id).",
    capability: "(bundle read access)",
    params: docLookupParams,
    handler: async (env, params) => ({
      result: docView(await bundleDocsCore.getDoc(env.db, env.userId, env.bundleId, String(params.doc))),
    }),
  },
  read_docs: {
    description:
      "Read bundle doc content. Params: refs? (array of doc ids or names; omit to read every doc). load_bundle lists what exists and inlines the autoloaded ones — use this for the rest.",
    capability: "(bundle read access)",
    params: { refs: {} },
    handler: async (env, params) => ({
      result: { data: (await bundleDocsCore.readDocs(env.db, env.userId, env.bundleId, params.refs as string[] | undefined)).map(docView) },
    }),
  },
  create_doc: {
    description:
      "Create a named doc in the bundle. Set autoload: true for binding operating instructions that load_bundle should always return in full. Params: name, content?, autoload?.",
    capability: "edit_docs",
    params: { name: { required: true }, content: {}, autoload: {} },
    handler: async (env, params) => ({
      result: docView(await bundleDocsCore.createDoc(env.db, env.userId, env.bundleId, {
        name: String(params.name),
        content: params.content as string | undefined,
        autoload: params.autoload as boolean | undefined,
      })),
    }),
  },
  update_doc: {
    description: "Update a doc. Params: doc (name or id), name?, content?, autoload?.",
    capability: "edit_docs",
    params: { ...docLookupParams, name: {}, content: {}, autoload: {} },
    handler: async (env, params) => ({
      result: docView(await bundleDocsCore.updateDoc(env.db, env.userId, env.bundleId, String(params.doc), {
        name: params.name as string | undefined,
        content: params.content as string | undefined,
        autoload: params.autoload as boolean | undefined,
      })),
    }),
  },
  patch_doc: {
    description:
      "Surgically edit a bundle doc without replacing the entire content. Applied in order, all-or-nothing. Params: doc (name or id), edits — array of: prepend/append {content}, search_replace {search, replace, all?} (default: error if not exactly one match; all:true replaces all occurrences), insert_before/insert_after {target, content}, delete {target}, replace_lines/delete_lines {from, to[, content]} (1-based line numbers, inclusive). Note: insert_before/insert_after/delete splice at the raw character offset — newlines are your responsibility (e.g. insert_before a line you must include the trailing \\n in content). replace_lines/delete_lines are line-aware and handle newlines automatically.",
    capability: "edit_docs",
    params: { ...docLookupParams, edits: { required: true } },
    handler: async (env, params) => ({
      result: docView(
        await bundleDocsCore.patchDoc(env.db, env.userId, env.bundleId, String(params.doc), params.edits as EditOp[]),
      ),
    }),
  },
  delete_doc: {
    description: "Delete a doc. Params: doc (name or id).",
    capability: "edit_docs",
    params: docLookupParams,
    handler: async (env, params) => {
      await bundleDocsCore.deleteDoc(env.db, env.userId, env.bundleId, String(params.doc));
      return { result: { deleted: true } };
    },
  },
  list_files: {
    description: "List the bundle's file records (finalized files: id, name, mime type, size). No params.",
    capability: "read_files",
    params: noParams,
    handler: async (env) => ({
      result: { data: await filesCore.listFiles(env, env.userId, env.bundleId) },
    }),
  },
  show_file: {
    description:
      "Display a stored file or URL. Params: ref — a file://{uuid} reference or a direct http(s) URL. Returns a fresh expiring link plus a media-card widget pointer; share the link, never a durable location. On a widget-capable host, render the card with show_widget(widget=\"media-card\", params=<this result>) — show_widget carries the CSP that lets the card load the file bytes; the in-band pointer/link is the fallback for hosts that don't render widgets.",
    capability: "read_files",
    params: { ref: { required: true } },
    handler: async (env, params) => {
      const result = await filesCore.showFile(env, env.userId, String(params.ref));
      return {
        result,
        _meta: { widget: "ui://yap/media-card", data: { ...result } },
      };
    },
  },
  upload_request: {
    description:
      "Phase 1 of the 3-step upload lifecycle (request → upload bytes → complete). Reserves a placeholder file record and returns, in the result JSON: upload_url (short-lived, single-use — PUT the bytes there, then call upload_complete), origin_upload_url (a momentary signed upload page — give this link to a human to upload from a browser; nothing else needed), file_id, and complete_url. A dropzone widget pointer also rides in the result _meta for widget-capable hosts, but the links above work everywhere. On a widget-capable host, render the dropzone with show_widget(widget=\"upload-dropzone\", params={file_id, upload_url, complete_url}) — show_widget carries the CSP that lets the dropzone PUT bytes and finalize; otherwise hand a human origin_upload_url. Params: name (required), mime_type?, size? (declared, advisory).",
    capability: "edit_files",
    params: { name: { required: true }, mime_type: {}, size: {} },
    handler: async (env, params) => {
      const result = await filesCore.requestUpload(env, env.userId, env.bundleId, {
        name: String(params.name),
        mime_type: params.mime_type as string | undefined,
        size: params.size as number | undefined,
      });
      return {
        result,
        _meta: {
          widget: "ui://yap/upload-dropzone",
          data: {
            file_id: result.file_id,
            upload_url: result.upload_url,
            // The in-client dropzone finalizes by POSTing here after the PUT;
            // omitting it leaves every widget upload stuck in 'reserved'.
            complete_url: result.complete_url,
            origin_upload_url: result.origin_upload_url,
          },
        },
      };
    },
  },
  upload_complete: {
    description:
      "Headless finalize step after bytes are uploaded: reads the size authoritatively from storage and turns the placeholder into a finalized file. Params: file_id, name?, mime_type?. (Widget-driven uploads finalize via the widget.)",
    capability: "edit_files",
    params: { file_id: { required: true }, name: {}, mime_type: {} },
    handler: async (env, params) => ({
      result: await filesCore.completeUpload(env, env.userId, String(params.file_id), {
        name: params.name as string | undefined,
        mime_type: params.mime_type as string | undefined,
      }),
    }),
  },
  delete_file: {
    description: "Delete a file record and its stored bytes immediately. Params: file_id.",
    capability: "edit_files",
    params: { file_id: { required: true } },
    handler: async (env, params) => {
      await filesCore.deleteFile(env, env.userId, String(params.file_id));
      return { result: { deleted: true } };
    },
  },
  fire_hook: {
    description:
      'Fire a hook with values for its declared (allowlisted) parameters only — you cannot add, rename, or inject anything else, and you never see the hook\'s transport. Synchronous with a fixed timeout, no automatic retries; returns the raw response status and body. Two params: "hook" — the hook\'s name or id (both are in load_bundle); and "params" — an object of the hook\'s declared parameter values. The declared values go inside the nested params object, NOT alongside hook. Example: {hook: "notify", params: {message: "deploy finished", channel: "ops"}}.',
    capability: "fire_hooks",
    params: { hook: { required: true }, params: {} },
    handler: async (env, params) => ({
      result: await hooksCore.fireHook(env, env.userId, env.bundleId, {
        hook: String(params.hook),
        params: params.params as Record<string, unknown> | undefined,
      }),
    }),
  },

  // ---- Management (parity with the REST management plane) -----------------------
  // Hook authoring (edit_hooks) is deliberately absent — defining a hook's
  // destination and secrets stays REST-only by design.

  // manage_space (space-scoped)
  update_space: {
    description:
      "Update the targeted space (omit bundle_id). Params: name?, description?, keywords?, context?. The personal space rejects renames.",
    capability: "manage_space",
    params: { name: {}, description: {}, keywords: {}, context: {} },
    targets: ["space"],
    handler: async (env, params) => ({
      result: await spacesCore.updateSpace(env.db, env.userId, env.spaceId, {
        name: params.name as string | undefined,
        description: params.description as string | undefined,
        keywords: params.keywords as string | undefined,
        context: params.context as string | undefined,
      }),
    }),
  },
  delete_space: {
    description: "Delete the targeted space and everything in it (omit bundle_id). The personal space cannot be deleted.",
    capability: "manage_space",
    params: noParams,
    targets: ["space"],
    handler: async (env) => {
      await spacesCore.deleteSpace(env.db, env.userId, env.spaceId, env.blob);
      return { result: { deleted: true } };
    },
  },

  // manage_roles (space- or bundle-scoped — targets the bundle if bundle_id is given)
  list_grants: {
    description:
      "List the grant rows on the target resource (the bundle if bundle_id is given, else the space). Returns role assignments as (user, capability, effect) rows.",
    capability: "manage_roles",
    params: noParams,
    targets: ["bundle", "space"],
    handler: async (env) => ({
      result: { data: await grantsCore.listGrants(env.db, env.userId, await grantTargetFor(env)) },
    }),
  },
  grant_role: {
    description:
      "Grant a role (capabilities) to a user on the target resource (bundle if bundle_id is given, else space). Params: user_id, capability (or capabilities[]), effect (\"allow\" | \"deny\").",
    capability: "manage_roles",
    params: { user_id: { required: true }, capability: {}, capabilities: {}, effect: { required: true } },
    targets: ["bundle", "space"],
    handler: async (env, params) => ({
      result: {
        data: await grantsCore.createGrants(env.db, env.userId, await grantTargetFor(env), {
          userId: String(params.user_id),
          capabilities: grantCapabilities(params),
          effect: params.effect as "allow" | "deny",
        }),
      },
    }),
  },
  revoke_grant: {
    description:
      "Delete a grant row by id on the target resource (bundle if bundle_id is given, else space). Params: grant_id.",
    capability: "manage_roles",
    params: { grant_id: { required: true } },
    targets: ["bundle", "space"],
    handler: async (env, params) => {
      await grantsCore.deleteGrant(env.db, env.userId, await grantTargetFor(env), String(params.grant_id));
      return { result: { deleted: true } };
    },
  },

  // edit_bundles (bundle-scoped)
  update_bundle: {
    description: "Update the targeted bundle's name/description. Params: name?, description?.",
    capability: "edit_bundles",
    params: { name: {}, description: {} },
    handler: async (env, params) => ({
      result: await bundlesCore.updateBundle(env.db, env.userId, env.bundleId, {
        name: params.name as string | undefined,
        description: params.description as string | undefined,
      }),
    }),
  },
  delete_bundle: {
    description: "Delete the targeted bundle and everything in it (item-types, items, files, hooks).",
    capability: "edit_bundles",
    params: noParams,
    handler: async (env) => {
      await bundlesCore.deleteBundle(env.db, env.userId, env.bundleId, env.blob);
      return { result: { deleted: true } };
    },
  },
  create_item_type: {
    description:
      "Add a new item-type (schema) to the targeted bundle. Params: name, properties? (array of {name, datatype, required?, multi?, config?}). See add_property for datatypes and config.",
    capability: "edit_bundles",
    params: { name: { required: true }, properties: {} },
    handler: async (env, params) => ({
      result: itemTypesCore.itemTypeView(
        await itemTypesCore.createItemType(env.db, env.userId, env.bundleId, {
          name: String(params.name),
          properties: params.properties as bundlesCore.PropertyInput[] | undefined,
        }),
      ),
    }),
  },
  update_item_type: {
    description: "Rename an item-type in the targeted bundle. Params: item_type_id, name.",
    capability: "edit_bundles",
    params: { item_type_id: { required: true }, name: { required: true } },
    handler: async (env, params) => {
      await itemTypesCore.updateItemType(env.db, env.userId, String(params.item_type_id), {
        name: params.name as string | undefined,
      });
      return { result: { updated: true } };
    },
  },
  delete_item_type: {
    description: "Delete an item-type and all its items from the targeted bundle. Params: item_type_id.",
    capability: "edit_bundles",
    params: { item_type_id: { required: true } },
    handler: async (env, params) => {
      await itemTypesCore.deleteItemType(env.db, env.userId, String(params.item_type_id));
      return { result: { deleted: true } };
    },
  },
  add_property: {
    description:
      "Add a property to an item-type. Params: item_type_id, name, datatype (text|number|boolean|date|item|file), required?, multi?, config?. item references another item in this bundle (item://<id>); file references a finalized file (file://<id>). config constrains writes: text {pattern, enum} (enum restricts to a fixed set of strings); number {min,max,decimals} (decimals default 2, extra precision rejected); item {itemType} (pin the referent's type); any multi field {minItems,maxItems}.",
    capability: "edit_bundles",
    params: { item_type_id: { required: true }, name: { required: true }, datatype: { required: true }, required: {}, multi: {}, config: {} },
    handler: async (env, params) => ({
      result: itemTypesCore.propertyView(
        await itemTypesCore.addProperty(env.db, env.userId, String(params.item_type_id), {
          name: String(params.name),
          datatype: params.datatype as bundlesCore.Datatype,
          required: params.required as boolean | undefined,
          multi: params.multi as boolean | undefined,
          config: params.config as PropertyConfig | undefined,
        }),
      ),
    }),
  },
  update_property: {
    description:
      "Update a property (rename, toggle required/multi, reorder, replace config). The datatype is immutable. single→multi is free; multi→single is rejected if any item has multiple values. Params: item_type_id, property_id, name?, required?, multi?, config?, sort_order?.",
    capability: "edit_bundles",
    params: { item_type_id: { required: true }, property_id: { required: true }, name: {}, required: {}, multi: {}, config: {}, sort_order: {} },
    handler: async (env, params) => ({
      result: itemTypesCore.propertyView(
        await itemTypesCore.updateProperty(
          env.db,
          env.userId,
          String(params.item_type_id),
          String(params.property_id),
          {
            name: params.name as string | undefined,
            required: params.required as boolean | undefined,
            multi: params.multi as boolean | undefined,
            config: params.config as PropertyConfig | undefined,
            sortOrder: params.sort_order as number | undefined,
          },
        ),
      ),
    }),
  },
  delete_property: {
    description:
      "Delete a property; its stored values cascade-delete immediately. Params: item_type_id, property_id.",
    capability: "edit_bundles",
    params: { item_type_id: { required: true }, property_id: { required: true } },
    handler: async (env, params) => {
      await itemTypesCore.deleteProperty(
        env.db,
        env.userId,
        String(params.item_type_id),
        String(params.property_id),
      );
      return { result: { deleted: true } };
    },
  },
};

export interface PerCallResult {
  bundle_id: string | null;
  tool: string;
  ok: boolean;
  durationMs: number;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
  _meta?: { widget: string; data: Record<string, unknown> };
}

/**
 * Executes one call from a batch; never throws — failures are per-call
 * results. A call's target is the named bundle when `bundle_id` is present,
 * otherwise the call's space; the tool must accept that target kind.
 */
export async function executeCall(
  env: Omit<CallEnv, "bundleId" | "spaceId">,
  spaceId: string,
  call: { bundle_id?: string; tool: string; params?: Record<string, unknown> },
  bundleSpaceLookup: (bundleId: string) => Promise<string | null>,
): Promise<PerCallResult> {
  const base = { bundle_id: call.bundle_id ?? null, tool: call.tool };
  const t0 = performance.now();
  try {
    const tool = secondTier[call.tool];
    if (!tool) {
      throw new YapError(
        "invalid_request",
        `unknown tool "${call.tool}" (available: ${Object.keys(secondTier).join(", ")})`,
      );
    }
    const targets = tool.targets ?? ["bundle"];
    const targetsBundle = call.bundle_id !== undefined && call.bundle_id !== null && call.bundle_id !== "";
    if (targetsBundle) {
      if (!targets.includes("bundle")) {
        throw new YapError("invalid_request", `tool "${call.tool}" operates on a space — omit bundle_id`);
      }
      const bundleSpace = await bundleSpaceLookup(call.bundle_id!);
      if (bundleSpace === null) throw new YapError("not_found", `bundle ${call.bundle_id} not found`);
      if (bundleSpace !== spaceId) {
        throw new YapError("invalid_request", `bundle ${call.bundle_id} is not in space ${spaceId}`);
      }
    } else if (!targets.includes("space")) {
      throw new YapError("invalid_request", `tool "${call.tool}" operates on a bundle — provide bundle_id`);
    }
    const callEnv: CallEnv = { ...env, spaceId, bundleId: targetsBundle ? call.bundle_id! : "" };
    const params = normalizeParams(call.tool, tool, call.params ?? {});
    const { result, _meta } = await tool.handler(callEnv, params);
    return { ...base, ok: true, durationMs: Math.round(performance.now() - t0), result, ...(_meta ? { _meta } : {}) };
  } catch (err) {
    const durationMs = Math.round(performance.now() - t0);
    if (err instanceof YapError) {
      return {
        ...base,
        ok: false,
        durationMs,
        error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
      };
    }
    return { ...base, ok: false, durationMs, error: { code: "internal", message: (err as Error).message } };
  }
}
