/**
 * The second-tier catalog: tools dispatched through `call`, each a thin
 * adapter over the core (which enforces the capability gates itself). The
 * table also carries the metadata `load` and `load_bundle` use to advertise
 * the catalog. File and service tools register here in their milestones.
 */
import type { BlobStore } from "../blob/index.js";
import { DEFAULT_RUN_WAIT_CAP_MS, type YapConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { YapLogger } from "../logger.js";
import * as bundlesCore from "../core/bundles.js";
import * as bundleDocsCore from "../core/bundleDocs.js";
import type { BundleDoc } from "../core/bundleDocs.js";
import type { EditOp } from "../core/textEdits.js";
import * as filesCore from "../core/files.js";
import * as grantsCore from "../core/grants.js";
import type { DriverRegistry } from "../core/drivers/registry.js";
import * as itemTypesCore from "../core/itemTypes.js";
import * as itemsCore from "../core/items.js";
import * as legacyHooks from "../core/legacyHooks.js";
import * as runsCore from "../core/runs.js";
import * as schedulesCore from "../core/schedules.js";
import * as secretRequestsCore from "../core/secretRequests.js";
import * as serviceApprovalsCore from "../core/serviceApprovals.js";
import * as servicesCore from "../core/services.js";
import * as spacesCore from "../core/spaces.js";
import type { PropertyConfig } from "../core/propertyConfig.js";
import { YapError } from "../core/errors.js";

/** A second-tier call targets either a bundle (the default) or its space. */
export type TargetKind = "bundle" | "space";

/** What an MCP caller is told about an error that is not a domain error. */
export const INTERNAL_ERROR_MESSAGE = "internal error";

export interface CallEnv {
  db: Db;
  config: YapConfig;
  blob: BlobStore;
  /** The installed drivers — what a service run resolves its driver against. */
  registry: DriverRegistry;
  /** Operator-side sink the runs layer writes a failed run's detail to. */
  logger?: YapLogger;
  /** Re-armed by schedule edits; absent in bare in-process callers. */
  scheduler?: schedulesCore.ScheduleReloader;
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
  params?: Record<string, { required?: boolean }>;
  /** Which target(s) this tool operates on. Defaults to ["bundle"]. */
  targets?: TargetKind[];
  /** When present and false for this instance, the tool is left out of
   * everything that advertises the catalog. It stays callable, so a caller who
   * names it anyway gets the core's own refusal rather than "unknown tool". */
  offered?: (config: YapConfig) => boolean;
  handler: (env: CallEnv, params: Record<string, unknown>) => Promise<SecondTierResult>;
}

/** Maps a core BundleDoc row to the MCP view (autoload as boolean). */
const docView = (d: BundleDoc) => ({ ...d, autoload: d.autoload === 1 });

const noParams: Record<string, never> = {};
const idParam = { id: { required: true } };

function formatKeys(keys: string[]): string {
  return `[${keys.join(", ")}]`;
}

/** Levenshtein distance — inputs are short param names, so the O(n·m) table is fine. */
function editDistance(a: string, b: string): number {
  const dist = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dist[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dist[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i]![j] = Math.min(dist[i - 1]![j]! + 1, dist[i]![j - 1]! + 1, dist[i - 1]![j - 1]! + cost);
    }
  }
  return dist[a.length]![b.length]!;
}

/**
 * The expected param nearest a mistyped key, when one is close enough to be a
 * plausible fix. The threshold (a third of the longer name, min 1) covers
 * camelCase↔snake_case (itemType→item_type) and ordinary typos while staying
 * clear of unrelated names — case-insensitive so casing alone always matches.
 */
function suggestParam(key: string, expected: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const name of expected) {
    const d = editDistance(key.toLowerCase(), name.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  if (best === undefined) return undefined;
  const threshold = Math.max(1, Math.floor(Math.max(key.length, best.length) / 3));
  return bestDist <= threshold ? best : undefined;
}

/**
 * Validates a call's params against the tool's declared set: rejects unknown
 * keys (with a did-you-mean suggestion when one is close) and enforces required
 * ones. Param names are canonical and there are no aliases — a wrong name earns
 * an actionable error, not silent coercion, so the caller learns the real name
 * rather than entrenching a private dialect.
 */
function validateParams(toolName: string, tool: SecondTierTool, rawParams: Record<string, unknown>): void {
  const specs = tool.params ?? noParams;
  const expected = Object.keys(specs);
  const allowed = new Set(expected);

  const receivedKeys = Object.keys(rawParams);
  for (const key of receivedKeys) {
    if (!allowed.has(key)) {
      const suggestion = suggestParam(key, expected);
      throw new YapError(
        "invalid_request",
        `unknown param '${key}' for tool '${toolName}'; expected params: ${formatKeys(expected)}` +
          (suggestion ? `. Did you mean '${suggestion}'?` : ""),
      );
    }
  }

  // A required param must be present AND carry a value: `== null` catches both a
  // missing key and an explicit JSON null/undefined, so handlers can trust the
  // value rather than re-adding `?? ""` coercion (a null would otherwise reach
  // core as the string "null").
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.required && rawParams[name] == null) {
      throw new YapError(
        "invalid_request",
        `missing required param '${name}' (params.${name}) for tool '${toolName}'; received keys: ${formatKeys(receivedKeys)}`,
      );
    }
  }
}

/** Builds a grant target from the call's resource (bundle if present, else space). */
function grantTargetFor(env: CallEnv): Promise<grantsCore.GrantTarget> {
  return env.bundleId
    ? bundlesCore.bundleGrantTarget(env.db, env.bundleId)
    : grantsCore.spaceGrantTarget(env.db, env.spaceId);
}

/**
 * An agent's `wait_ms`, coerced and then clamped by `clampRunWait` (which
 * documents why adapters clamp and the core does not). The coercion stays here
 * because the error it raises is this surface's: an agent that sent nonsense
 * needs to be told so per call, not have it silently read as 0. An undefined
 * wait stays undefined — that is "don't wait", not "wait 0".
 */
function clampWaitMs(config: YapConfig, value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const ms = Number(value);
  if (!Number.isFinite(ms)) {
    throw new YapError("invalid_request", `wait_ms must be a number of milliseconds (got ${JSON.stringify(value)})`);
  }
  return runsCore.clampRunWait(config, ms);
}

/** The single canonical `capabilities` param accepts a scalar or an array — normalized here; core rejects an empty list. */
function toCapabilityList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

export const secondTier: Record<string, SecondTierTool> = {
  query_items: {
    description:
      'Filtered, sorted, paginated item retrieval. Params: item_type (name or id), filters (array of {property, op, value, quantifier?}; AND-combined), sort ({property, direction} — property is a schema property name or the system timestamps createdAt/updatedAt), cursor, limit. Comparison ops: eq, neq, contains, gt, gte, lt, lte, in — e.g. filters: [{property: "status", op: "eq", value: "open"}, {property: "due", op: "lt", value: "2026-07-01"}]. A date filter value is YYYY-MM-DD or a timestamp with Z or an offset; anything else is refused (contains is the exception: a substring match on the stored UTC text, e.g. "2026-11"). For multi-valued properties a comparison op takes quantifier any (default; some element matches) | all (every element matches) | none (no element matches); set ops match the value set directly: has (contains value), has_any (contains any of an array), has_all (contains all of an array), has_none (contains none of an array) — e.g. {property: "tags", op: "has_any", value: ["work", "urgent"]}.',
    capability: "read_items",
    params: {
      item_type: { required: true },
      filters: {},
      sort: {},
      cursor: {},
      limit: {},
    },
    handler: async (env, params) => {
      const page = await itemsCore.queryItems(env.db, env.userId, env.bundleId, {
        itemType: String(params.item_type),
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
      'Batch-create items of an item-type with write-time validation. Params: item_type, items (array of {propertyName: value} objects; for a multi-valued property pass an array of values) — e.g. items: [{title: "Book travel", status: "open", tags: ["work", "urgent"]}]. A date value is YYYY-MM-DD (a day) or a timestamp with Z or an offset (a moment); anything else is refused. All-or-nothing per call: if any item is invalid or a write fails, none of them is created.',
    capability: "edit_items",
    params: { item_type: { required: true }, items: { required: true } },
    handler: async (env, params) => ({
      result: await itemsCore.createItems(env.db, env.userId, env.bundleId, {
        itemType: String(params.item_type),
        items: params.items as Record<string, unknown>[],
      }),
    }),
  },
  update_items: {
    description:
      "Batch-update item values. Params: updates — array of {id, set?, edits?}. set: {propertyName: value | null} does a full property replacement (null clears an optional property). A date value is YYYY-MM-DD (a day) or a timestamp with Z or an offset (a moment); anything else is refused. edits: {propertyName: EditOp[]} applies surgical ops to text properties without replacing the whole value — ops: prepend/append {content}, search_replace {search, replace, all?}, insert_before/insert_after/delete {target[, content]}, replace_lines/delete_lines {from, to[, content]} (1-based). Note: insert_before/insert_after/delete splice at the raw character offset — newlines are your responsibility; replace_lines/delete_lines are line-aware. A property must not appear in both set and edits for the same item. All-or-nothing per call: if any update is invalid or a write fails, none of them is applied.",
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
    description: "Read a single bundle doc by name or id. Returns id, name, content, autoload, createdAt, updatedAt. Params: id (the doc's name or id).",
    capability: "(bundle read access)",
    params: idParam,
    handler: async (env, params) => ({
      result: docView(await bundleDocsCore.getDoc(env.db, env.userId, env.bundleId, String(params.id))),
    }),
  },
  read_docs: {
    description:
      "Read bundle doc content. Params: ids? (array of doc ids or names; omit to read every doc). load_bundle lists what exists and inlines the autoloaded ones — use this for the rest.",
    capability: "(bundle read access)",
    params: { ids: {} },
    handler: async (env, params) => ({
      result: { data: (await bundleDocsCore.readDocs(env.db, env.userId, env.bundleId, params.ids as string[] | undefined)).map(docView) },
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
    description: "Update a doc. Params: id (the doc's name or id), name?, content?, autoload?.",
    capability: "edit_docs",
    params: { ...idParam, name: {}, content: {}, autoload: {} },
    handler: async (env, params) => ({
      result: docView(await bundleDocsCore.updateDoc(env.db, env.userId, env.bundleId, String(params.id), {
        name: params.name as string | undefined,
        content: params.content as string | undefined,
        autoload: params.autoload as boolean | undefined,
      })),
    }),
  },
  patch_doc: {
    description:
      "Surgically edit a bundle doc without replacing the entire content. Applied in order, all-or-nothing. Params: id (the doc's name or id), edits — array of: prepend/append {content}, search_replace {search, replace, all?} (default: error if not exactly one match; all:true replaces all occurrences), insert_before/insert_after {target, content}, delete {target}, replace_lines/delete_lines {from, to[, content]} (1-based line numbers, inclusive). Note: insert_before/insert_after/delete splice at the raw character offset — newlines are your responsibility (e.g. insert_before a line you must include the trailing \\n in content). replace_lines/delete_lines are line-aware and handle newlines automatically.",
    capability: "edit_docs",
    params: { ...idParam, edits: { required: true } },
    handler: async (env, params) => ({
      result: docView(
        await bundleDocsCore.patchDoc(env.db, env.userId, env.bundleId, String(params.id), params.edits as EditOp[]),
      ),
    }),
  },
  delete_doc: {
    description: "Delete a doc. Params: id (the doc's name or id).",
    capability: "edit_docs",
    params: idParam,
    handler: async (env, params) => {
      await bundleDocsCore.deleteDoc(env.db, env.userId, env.bundleId, String(params.id));
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
      "Display a stored file or URL. Params: ref — a file://{uuid} reference or a direct http(s) URL. Returns a fresh expiring link plus a media-card widget pointer; share the link, never a durable location. On a widget-capable host, render the card with show_widget(widget=\"media-card\", params=<this result>): pass this result (the same object as its _meta.data) as params, flat, not wrapped in {data: …} or the whole _meta. show_widget carries the CSP that lets the card load the file bytes; the in-band pointer/link is the fallback for hosts that don't render widgets.",
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
      "Phase 1 of the 3-step upload lifecycle (request → upload bytes → complete). Reserves a placeholder file record and returns, in the result JSON: upload_url (short-lived, single-use — PUT the bytes there, then call upload_complete), origin_upload_url (a momentary signed upload page — give this link to a human to upload from a browser; nothing else needed), file_id, and complete_url. A dropzone widget pointer also rides in the result _meta for widget-capable hosts, but the links above work everywhere. On a widget-capable host, render the dropzone with show_widget(widget=\"upload-dropzone\", params=<this result's _meta.data>) — {file_id, upload_url, complete_url, name}; leave name out only to let the file take the browser's filename — show_widget carries the CSP that lets the dropzone PUT bytes and finalize; otherwise hand a human origin_upload_url. Params: name (required), mime_type?, size? (declared, advisory).",
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
            // The requested name: with it the dropzone keeps it at finalize
            // instead of sending the browser's local filename.
            name: filesCore.cleanFileName(String(params.name)),
          },
        },
      };
    },
  },
  upload_complete: {
    description:
      "Headless finalize step after bytes are uploaded: reads the size authoritatively from storage and turns the placeholder into a finalized file. Params: file_id (as returned by upload_request), name?, mime_type?. (Widget-driven uploads finalize via the widget.)",
    capability: "edit_files",
    // Keeps file_id (not the normalized `id`) so it matches the field upload_request
    // hands back — the caller echoes that value straight in. Do not "normalize".
    params: { file_id: { required: true }, name: {}, mime_type: {} },
    handler: async (env, params) => ({
      result: await filesCore.completeUpload(env, env.userId, String(params.file_id), {
        name: params.name as string | undefined,
        mime_type: params.mime_type as string | undefined,
      }),
    }),
  },
  sideload_file: {
    description:
      "Store a file from a remote URL in one call: the server downloads it and returns the finalized file, so no upload step is needed and no bytes pass through you. Pass a direct link to the file itself, not a share or preview page — a page link stores the page's HTML. http(s) only, fetched with a plain GET: no credentials or headers can be supplied, and private or internal addresses are refused. The call blocks until the file is stored, within the instance's time, size and MIME limits. Params: url (required), name? (default: taken from the response, else from the URL), mime_type? (default: the response's Content-Type). The result has the same shape as upload_complete's; its mimeType and size show what was actually stored — check them.",
    capability: "edit_files",
    params: { url: { required: true }, name: {}, mime_type: {} },
    offered: (config) => config.sideloadEnabled,
    handler: async (env, params) => ({
      result: await filesCore.sideloadFile(env, env.userId, env.bundleId, {
        // Passed through untyped: the core says what is wrong with each.
        url: params.url as string,
        name: params.name as string | undefined,
        mime_type: params.mime_type as string | undefined,
      }),
    }),
  },
  update_file: {
    description:
      "Rename a file (finalized or still reserved) without re-uploading it. Only the record changes: the bytes and every file://{uuid} reference to it stay as they are. Download links minted after the rename carry the new filename; a link already handed out may keep the old one until it expires. Params: id (the file id), name (required). Returns the file as list_files shows it.",
    capability: "edit_files",
    params: { id: { required: true }, name: { required: true } },
    handler: async (env, params) => ({
      result: await filesCore.updateFile(env, env.userId, String(params.id), { name: String(params.name) }),
    }),
  },
  delete_file: {
    description: "Delete a file record and its stored bytes immediately. Params: id (the file id).",
    capability: "edit_files",
    params: { id: { required: true } },
    handler: async (env, params) => {
      await filesCore.deleteFile(env, env.userId, String(params.id));
      return { result: { deleted: true } };
    },
  },
  run_service: {
    description:
      'Start a run of one of the bundle\'s services, supplying values for its declared (allowlisted) parameters only — you cannot add, rename, or inject anything else, and you never see the service\'s configuration. Returns the run — poll get_run until status is terminal (succeeded|failed). wait_ms (max ' +
      `${DEFAULT_RUN_WAIT_CAP_MS}` +
      ') folds the first poll into the dispatch: the run comes back already finished if it lands inside that window, and keeps going on the server if it does not. Params: "id" — the service\'s name or id (both are in load_bundle); "action" — which of the service\'s actions to run (omit when it has only one); "params" — an object of the declared parameter values, nested, NOT alongside id; "wait_ms". Example: {id: "notify", params: {message: "deploy finished", channel: "ops"}, wait_ms: 5000}. A failed run is a returned record with status "failed" and an error string, not a call error — read run.status before reporting success.',
    capability: "run_services",
    params: { id: { required: true }, action: {}, params: {}, wait_ms: {} },
    handler: async (env, params) => ({
      result: await runsCore.runService(env, env.userId, env.bundleId, {
        service: String(params.id),
        source: "mcp",
        action: params.action as string | undefined,
        params: params.params as Record<string, unknown> | undefined,
        waitMs: clampWaitMs(env.config, params.wait_ms),
      }),
    }),
  },
  get_run: {
    description:
      "Read one run back: its status, the parameters it was given, the result or error, and its bundle I/O trail. Poll this after run_service until status is succeeded or failed. Params: id (the run id run_service returned).",
    capability: "run_services",
    params: idParam,
    // Access is decided by the run's *own* bundle, not by the bundle_id this
    // call targets — that one only routes the call. A run the caller cannot see
    // is a 404, indistinguishable from an id that never existed.
    handler: async (env, params) => ({
      result: await runsCore.getRun(env, env.userId, String(params.id)),
    }),
  },
  list_runs: {
    description:
      "List the targeted bundle's runs, newest first, as {data, nextCursor}. Params: service (name or id — only that service's runs), cursor, limit.",
    capability: "run_services",
    params: { service: {}, cursor: {}, limit: {} },
    handler: async (env, params) => ({
      result: await runsCore.listRuns(env, env.userId, env.bundleId, {
        service: params.service as string | undefined,
        cursor: params.cursor as string | undefined,
        limit: params.limit as number | undefined,
      }),
    }),
  },
  list_schedules: {
    description:
      "List the targeted bundle's schedules: each runs one service action on a cron (5-field, in its IANA timezone) as its owner, the user who created it. Shows the stored params, whether it is enabled, when it last fired and is next due, its last run id (read it with get_run), the last error or the reason it disabled itself, and the last tick skipped because the previous run was still going. Params: service (name or id — only that service's schedules).",
    capability: "run_services",
    params: { service: {} },
    handler: async (env, params) => ({
      result: await schedulesCore.listSchedules(env, env.userId, env.bundleId, {
        service: params.service as string | undefined,
      }),
    }),
  },
  create_schedule: {
    description:
      'Schedule one of the bundle\'s services: it will run on a cron, as you, with the params given here — the same declared (allowlisted) parameters run_service takes, checked now exactly as a run checks them. Every fire re-checks that you still hold run_services; if you lose it the schedule disables itself and says why. A tick while this schedule\'s previous run is still going is skipped. Returns the schedule, with when it is next due. Params: "service" — the service\'s name or id; "action" (omit when it has only one); "params" — an object of declared parameter values; "cron" — 5-field (minute hour day-of-month month day-of-week), e.g. "0 7 * * 1-5"; "timezone" — IANA name, default UTC; "enabled" (default true). Example: {service: "notify", params: {message: "standup"}, cron: "0 9 * * 1-5", timezone: "Europe/Copenhagen"}.',
    capability: "run_services",
    params: { service: { required: true }, action: {}, params: {}, cron: { required: true }, timezone: {}, enabled: {} },
    handler: async (env, params) => ({
      // Passed through untyped: the core says what is wrong with each.
      result: await schedulesCore.createSchedule(env, env.userId, env.bundleId, {
        service: params.service as string,
        action: params.action as string | undefined,
        params: params.params as Record<string, unknown> | undefined,
        cron: params.cron as string,
        timezone: params.timezone as string | undefined,
        enabled: params.enabled as boolean | undefined,
      }),
    }),
  },
  update_schedule: {
    description:
      "Change a schedule: any of action, params (replaces the stored object), cron, timezone, enabled. The service it runs is fixed — schedule another service with create_schedule. Only the schedule's owner (the user who created it, whom it runs as) may change what or when it runs or turn it back on; anyone else with run_services may only disable it (enabled: false). Re-enabling clears the last error. Params: id (the schedule id), action, params, cron, timezone, enabled.",
    capability: "run_services",
    params: { id: { required: true }, action: {}, params: {}, cron: {}, timezone: {}, enabled: {} },
    // Like get_run, access is decided by the schedule's own bundle; the
    // bundle_id this call targets only routes it.
    handler: async (env, params) => ({
      result: await schedulesCore.updateSchedule(env, env.userId, String(params.id), {
        action: params.action as string | undefined,
        params: params.params as Record<string, unknown> | undefined,
        cron: params.cron as string | undefined,
        timezone: params.timezone as string | undefined,
        enabled: params.enabled as boolean | undefined,
      }),
    }),
  },
  delete_schedule: {
    description:
      "Delete a schedule. Its past runs stay in the run log. Anyone with run_services on the bundle may delete any of its schedules. Params: id (the schedule id).",
    capability: "run_services",
    params: idParam,
    handler: async (env, params) => {
      await schedulesCore.deleteSchedule(env, env.userId, String(params.id));
      return { result: { deleted: true } };
    },
  },
  fire_hook: {
    description:
      'Deprecated alias for run_service (kept until 1.0): starts a run and waits like the old synchronous hook fire. Prefer run_service. Two params: "id" — the service\'s name or id; and "params" — an object of its declared parameter values, nested, NOT alongside id. Returns the raw response status and body on success; a failure arrives as a call error rather than as a run record.',
    capability: "run_services",
    params: { id: { required: true }, params: {} },
    // A fire is synchronous by contract, so this internal caller waits past the
    // action's own budget (deliberately uncapped) and always has a terminal run
    // to translate into the old shape: the result on success, a thrown error —
    // matching today's per-call error shape — on failure.
    // The alias speaks the old http-only shape: a service on any other driver
    // is not a hook, and reports as a per-call not_found rather than being
    // fired through a contract that cannot describe its result. Gate, wait and
    // error mapping are the core's, shared with `POST /v1/hooks/:id/fire`; a
    // failure arrives thrown, carrying the driver's own verdict.
    handler: async (env, params) => ({
      result: await legacyHooks.fireLegacyHook(
        env,
        env.userId,
        String(params.id),
        params.params as Record<string, unknown> | undefined,
        env.bundleId,
      ),
    }),
  },

  // ---- Service authoring (edit_services) -----------------------------------------
  // Settings only: a secret value is refused, and secrets reach the server
  // through secret_request's one-off form, typed in by a human. Driver checks
  // that need a secret wait until it is entered (see services.ts).
  get_service: {
    description:
      "Read one service in full: id, name, description, driver, actions, approved (false while it waits for a person: see approval_request), plus — for a caller holding edit_services on the bundle — the record's params, pins, settings (the config without its secrets) and secretsSet (which secret paths hold a value; never a value), approvedAt and approvedBy. Anyone else gets the listing view load_bundle shows. settings and secretsSet are null when the service keeps its config as one sealed secret (a driver without a config schema), which can only be changed over REST. Read a service with this before update_service. Params: id (the service's name or id).",
    capability: "(bundle read access)",
    params: idParam,
    handler: async (env, params) => ({
      result: await servicesCore.getService(env, env.userId, env.bundleId, String(params.id)),
    }),
  },
  create_service: {
    description:
      'Create a service in the bundle from one of the installed drivers (list_drivers shows each one\'s actions and config schema). Params: name, driver? (default "http"), description?, params? (parameter specs [{name, description?, required?}] — for http, the {{placeholders}} its template uses), pins? ({param: fixed scalar}, hidden from runners), actions? (allowlist of the driver\'s action names; omit for all), settings (the driver\'s config WITHOUT any secret: a value at a path the driver marks secret is refused). Secrets are never sent here: after creating, call secret_request so the user types them into a one-off form that goes straight to the server. The driver\'s config checks run now with the missing secrets treated as filled in; checks that need the real secrets run when they are entered. A driver without a config schema cannot be authored over MCP. A driver that writes items or files into the bundle also needs edit_items / edit_files. The new service is off until a person approves it: after entering its secrets, call approval_request. Returns the service as get_service shows it. Example: {name: "notify", driver: "http", params: [{name: "text", required: true}], settings: {url: "https://api.example.com/notify", method: "POST", headers: {}, body_json: {text: "{{text}}"}}}, then secret_request {id: "notify", paths: ["headers.authorization"]}, then approval_request {id: "notify"}.',
    capability: "edit_services",
    params: {
      name: { required: true },
      driver: {},
      description: {},
      params: {},
      pins: {},
      actions: {},
      settings: { required: true },
    },
    handler: async (env, params) => ({
      // Passed through untyped: the core says what is wrong with each.
      result: await servicesCore.createService(
        env,
        env.userId,
        env.bundleId,
        {
          name: params.name as string,
          driver: params.driver as string | undefined,
          description: params.description as string | undefined,
          params: params.params as servicesCore.ServiceParamSpec[] | undefined,
          pins: params.pins as servicesCore.ServicePins | undefined,
          actions: params.actions as string[] | null | undefined,
          config: params.settings,
        },
        { authoring: "mcp" },
      ),
    }),
  },
  update_service: {
    description:
      "Change a service. Params: id (name or id), and any of name, description, params (replaces the specs), pins (replaces the set; null clears it), actions (replaces the allowlist; null = every action), settings. settings replaces the stored settings whole, so send what get_service returned, edited: a secret is kept as long as the object holding it is still in the settings, and dropping that object drops its secrets; null at a secret path removes that secret. Changing a setting a secret is bound to (where it is sent: an http url, a mail server — see boundTo in list_drivers) drops that secret too, and the user enters it again through secret_request. A secret value is refused, as on create_service: change a secret with secret_request. A service whose config is one sealed secret cannot be changed over MCP. A change to params, pins, actions or settings that makes the service differ from what is stored turns it off until a person approves it again (approval_request); name and description do not. Returns the service as get_service shows it.",
    capability: "edit_services",
    params: { id: { required: true }, name: {}, description: {}, params: {}, pins: {}, actions: {}, settings: {} },
    handler: async (env, params) => {
      const serviceId = await servicesCore.resolveServiceId(env.db, env.bundleId, String(params.id));
      return {
        result: await servicesCore.updateService(
          env,
          env.userId,
          serviceId,
          {
            name: params.name as string | undefined,
            description: params.description as string | undefined,
            params: params.params as servicesCore.ServiceParamSpec[] | undefined,
            pins: params.pins as servicesCore.ServicePins | null | undefined,
            actions: params.actions as string[] | null | undefined,
            config: params.settings,
          },
          { authoring: "mcp" },
        ),
      };
    },
  },
  delete_service: {
    description:
      "Delete a service, with its schedules, its open secret forms and approval pages. Its past runs stay in the run log. Params: id (the service's name or id).",
    capability: "edit_services",
    params: idParam,
    handler: async (env, params) => {
      const serviceId = await servicesCore.resolveServiceId(env.db, env.bundleId, String(params.id));
      await servicesCore.deleteService(env, env.userId, serviceId);
      return { result: { deleted: true } };
    },
  },
  secret_request: {
    description:
      "Ask the user for a service's secrets through a one-off form, so they go from the human straight to the server and never through you. Params: id (the service's name or id), paths? (the secret paths to ask for; omit for the ones the service still lacks, e.g. [\"pass\"] for a mail service on a password, or its two oauth2 secrets for one with an oauth2 block; a map path is named with its key, e.g. [\"headers.authorization\"] for http). Returns request_id, the fields (path, label, description, and whether each is already set — never a value), expires_in, and origin_url — a signed page with the form: give this link to the user. A secret-input widget pointer rides in _meta for widget-capable hosts: render it with show_widget(widget=\"secret-input\", params=<this result's _meta.data>). Saving needs the user's own full access key (never an OAuth token or a scoped key), so you cannot fill the form in yourself. The form takes one successful submission and expires like an upload link; submitting sets the listed paths only. Afterwards, get_service's secretsSet shows what is set. Needs edit_services.",
    capability: "edit_services",
    params: { id: { required: true }, paths: {} },
    handler: async (env, params) => {
      const { result, form } = await secretRequestsCore.requestSecrets(env, env.userId, env.bundleId, {
        service: String(params.id),
        paths: params.paths,
      });
      return { result, _meta: { widget: "ui://yap/secret-input", data: { ...form } } };
    },
  },
  approval_request: {
    description:
      "Ask a person to approve a service you created or changed. A service written over MCP is off until a person approves it: run_service and schedules refuse it, and get_service and load_bundle show approved: false. Changing its params, pins, actions or settings over MCP puts it back to waiting; renaming it, or entering secrets through secret_request, does not. Params: id (the service's name or id). Returns request_id, the service, expires_in, and origin_url, a signed page that shows the person exactly what they approve (where data goes, the actions, params, pins, settings, and which secrets are set) with Approve and Reject: give this link to the user. A service-approve widget pointer rides in _meta for widget-capable hosts: render it with show_widget(widget=\"service-approve\", params=<this result's _meta.data>). Approving needs the person to log in with one of their access keys and to hold edit_services on the bundle; the link alone is not enough, and an OAuth token or a scoped key is never accepted, so you cannot approve it yourself. Never ask the user to paste an access key into the chat. Enter secrets before asking, so the person sees them as set. The page takes one decision and expires like a secret form. Needs edit_services.",
    capability: "edit_services",
    params: idParam,
    handler: async (env, params) => {
      const { result, widget } = await serviceApprovalsCore.requestApproval(env, env.userId, env.bundleId, {
        service: String(params.id),
      });
      return { result, _meta: { widget: "ui://yap/service-approve", data: { ...widget } } };
    },
  },

  // ---- Management (parity with the REST management plane) -----------------------

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
      await spacesCore.deleteSpace(env.db, env.userId, env.spaceId, env.blob, env.logger);
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
      "Grant a role (capabilities) to a user on the target resource (bundle if bundle_id is given, else space). Params: user_id, capabilities (a capability name or an array of them), effect (\"allow\" | \"deny\").",
    capability: "manage_roles",
    params: { user_id: { required: true }, capabilities: { required: true }, effect: { required: true } },
    targets: ["bundle", "space"],
    handler: async (env, params) => ({
      result: {
        data: await grantsCore.createGrants(env.db, env.userId, await grantTargetFor(env), {
          userId: String(params.user_id),
          capabilities: toCapabilityList(params.capabilities),
          effect: params.effect as "allow" | "deny",
        }),
      },
    }),
  },
  revoke_grant: {
    description:
      "Delete a grant row by id on the target resource (bundle if bundle_id is given, else space). Params: id (the grant id).",
    capability: "manage_roles",
    params: { id: { required: true } },
    targets: ["bundle", "space"],
    handler: async (env, params) => {
      await grantsCore.deleteGrant(env.db, env.userId, await grantTargetFor(env), String(params.id));
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
    description: "Delete the targeted bundle and everything in it (item-types, items, files, services).",
    capability: "edit_bundles",
    params: noParams,
    handler: async (env) => {
      await bundlesCore.deleteBundle(env.db, env.userId, env.bundleId, env.blob, env.logger);
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
    description: "Rename an item-type in the targeted bundle. Params: id (the item-type id), name.",
    capability: "edit_bundles",
    params: { id: { required: true }, name: { required: true } },
    handler: async (env, params) => {
      await itemTypesCore.updateItemType(env.db, env.userId, String(params.id), {
        name: params.name as string | undefined,
      });
      return { result: { updated: true } };
    },
  },
  delete_item_type: {
    description: "Delete an item-type and all its items from the targeted bundle. Params: id (the item-type id).",
    capability: "edit_bundles",
    params: { id: { required: true } },
    handler: async (env, params) => {
      await itemTypesCore.deleteItemType(env.db, env.userId, String(params.id));
      return { result: { deleted: true } };
    },
  },
  add_property: {
    description:
      "Add a property to an item-type. Params: item_type_id, name, datatype (text|number|boolean|date|item|file), required?, multi?, config?. A date value (on writes and in filters) is YYYY-MM-DD for a day (stored as midnight UTC) or a timestamp with Z or an offset for a moment (2026-11-16T09:00:00+01:00); anything else, a zoneless timestamp included, is refused. Dates read back as UTC ISO-8601. item references another item in this bundle (item://<id>); file references a finalized file (file://<id>). config constrains writes: text {pattern, enum} (enum restricts to a fixed set of strings); number {min,max,decimals} (decimals default 2, extra precision rejected); item {itemType} (pin the referent's type: an item-type name or id in this bundle, stored and read back as the id, so renames never break the link; an unknown one is refused); any multi field {minItems,maxItems}; single-valued text/number {unique} (no two items of the type may share a value).",
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

/** The catalog as this instance advertises it: every tool it currently offers. */
export function offeredSecondTier(config: YapConfig): Record<string, SecondTierTool> {
  return Object.fromEntries(Object.entries(secondTier).filter(([, tool]) => tool.offered?.(config) ?? true));
}

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
        `unknown tool "${call.tool}" (available: ${Object.keys(offeredSecondTier(env.config)).join(", ")})`,
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
    const params = call.params ?? {};
    validateParams(call.tool, tool, params);
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
    // Not a domain error: a storage error, say, whose raw message names
    // tables, indexes and values. The operator gets it in the log; the
    // caller gets a bare internal error.
    env.logger?.error("unhandled MCP call error", err);
    return { ...base, ok: false, durationMs, error: { code: "internal", message: INTERNAL_ERROR_MESSAGE } };
  }
}
