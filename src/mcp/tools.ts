/**
 * The top-level MCP surface: a small, fixed tool set built around progressive
 * disclosure — load → load_space → load_bundle → call — plus authoring
 * (space_create, bundle_create), identity, help, and the five user-doc tools.
 * Every tool is a thin adapter over the core; capability gates live in the core.
 */
import { UserError } from "fastmcp";
import { z } from "zod";

import type { YapConfig } from "../config.js";
import { runWithTokenAuth } from "../core/authScope.js";
import {
  DATATYPES,
  getBundleContext,
  createBundle,
  listBundles,
  requireBundleReadAccess,
  bundleCapabilityCtx,
  getBundleRow,
} from "../core/bundles.js";
import { effectiveCapabilities } from "../core/capabilities.js";
import { YapError } from "../core/errors.js";
import * as bundleDocsCore from "../core/bundleDocs.js";
import { listFilesUnchecked } from "../core/files.js";
import { listHooksUnchecked } from "../core/hooks.js";
import { listItemTypesUnchecked } from "../core/itemTypes.js";
import type { Page } from "../core/pagination.js";
import { parseConfig, propertyConfigSchema } from "../core/propertyConfig.js";
import { canReachSpace, createSpace, getSpaceRow, listSpacesForUser, toSpaceRef } from "../core/spaces.js";
import * as userDocsCore from "../core/userDocs.js";
import * as usersCore from "../core/users.js";
import { nowIso } from "../core/util.js";
import type { SessionAuth, YapServer } from "../server.js";
import { UI_SCHEME_PREFIX, WIDGETS, widgetHtml } from "../widgets/registry.js";
import { executeCall, secondTier, type PerCallResult } from "./call.js";
import { HELP_TEXT } from "./help.js";

function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Translates domain errors into agent-facing tool errors. */
function rethrow(err: unknown): never {
  if (err instanceof YapError) {
    throw new UserError(`${err.code}: ${err.message}${err.details ? ` ${JSON.stringify(err.details)}` : ""}`);
  }
  throw err;
}

function sessionUser(session: SessionAuth | undefined): string {
  if (!session?.userId) throw new UserError("unauthorized: no authenticated user on this session");
  return session.userId;
}

/**
 * Drains a cursor-paginated list into a single array for discovery, so the
 * MCP surface never silently hides spaces/bundles past one page. Bounded by a
 * safety cap; `truncated` flags the (unusual) overflow so the agent knows to
 * fall back to the paginated REST surface rather than assuming completeness.
 */
async function drainPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  cap = 1000,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    items.push(...page.data);
    cursor = page.nextCursor ?? undefined;
    if (items.length >= cap) return { items: items.slice(0, cap), truncated: cursor !== undefined };
  } while (cursor);
  return { items, truncated: false };
}

const SECOND_TIER_SPECS = Object.fromEntries(
  Object.entries(secondTier).map(([name, tool]) => [
    name,
    { description: tool.description, capability: tool.capability, targets: tool.targets ?? ["bundle"] },
  ]),
);

/** The origin a presigned S3 (or compatible) link is served from. */
function blobOrigin(blob: Extract<YapConfig["blob"], { driver: "s3" }>): string | null {
  try {
    if (blob.endpoint) {
      const u = new URL(blob.endpoint);
      // Path-style keeps the bucket in the path (origin unchanged); virtual-host
      // hosting prepends the bucket as a subdomain.
      return blob.forcePathStyle ? u.origin : `${u.protocol}//${blob.bucket}.${u.host}`;
    }
    // AWS default endpoints.
    return blob.forcePathStyle
      ? `https://s3.${blob.region}.amazonaws.com`
      : `https://${blob.bucket}.s3.${blob.region}.amazonaws.com`;
  } catch {
    return null;
  }
}

/**
 * The static CSP a widget-capable host applies to the show_widget shell. A
 * widget mounts in the shell's own document, so the shell must be allowed to
 * reach every origin the registered widgets touch: media-card loads file bytes,
 * upload-dropzone PUTs bytes and POSTs the finalize call. Per-call origins
 * aren't knowable here — fastmcp forwards only a static, tool-level _meta (a
 * result-level _meta is rejected) — but they're fixed per deployment: the
 * server's own base URL always, plus the S3 store's origin when blobs are
 * presigned off-origin. Declared in both connect and resource scopes since a
 * given origin may be fetched (upload) or loaded as media (show_file).
 */
function widgetCspDomains(config: YapConfig): string[] {
  const origins = new Set<string>();
  try {
    origins.add(new URL(config.baseUrl).origin);
  } catch {
    /* baseUrl is validated at boot; ignore if somehow unparseable */
  }
  if (config.blob.driver === "s3") {
    const s3 = blobOrigin(config.blob);
    if (s3) origins.add(s3);
  }
  return [...origins];
}

export function registerMcpTools(server: YapServer): void {
  const { mcp, db, config, blob, version } = server;
  const env = { db, config, blob, baseUrl: config.baseUrl };

  // Every tool executes inside the session's token-scope context (if the
  // session authenticated with an OAuth token) so capability resolution deep
  // in core sees the delegation clamp. Key-lane sessions run unscoped.
  const rawAddTool = mcp.addTool.bind(mcp);
  const addTool: typeof mcp.addTool = (tool) =>
    rawAddTool({
      ...tool,
      execute: (args, ctx) => {
        const tokenAuth = ctx.session?.tokenAuth;
        const run = () => tool.execute(args, ctx);
        return tokenAuth ? runWithTokenAuth(tokenAuth, run) : run();
      },
    });

  // ---- The widget registry: every widget is a ui:// resource -------------------

  const cspDomains = widgetCspDomains(config);

  // A widget can ride in-band on a call result (upload_request's dropzone,
  // show_file's media-card); the host renders it under the call tool's CSP, not
  // show_widget's. Advertise the same static, per-deployment origins so the
  // rendered widget can reach the server (media bytes, upload PUT/finalize) —
  // without it the host's default CSP blocks the dropzone's connect-src and the
  // media-card's img-src, so the widget renders but its bytes never load. No
  // resourceUri: call has no single shell — the widget to render travels
  // per-result in _meta, so this only supplies the CSP envelope. fastmcp forwards
  // _meta verbatim but types ui as { resourceUri? }; we annotate resourceUri as a
  // permitted (here unset) key so the value is assignable, and the csp rides
  // along — same trick as showWidgetMeta below, minus the resourceUri itself.
  const callMeta: { ui: { resourceUri?: string; csp: { connectDomains: string[]; resourceDomains: string[] } } } = {
    ui: { csp: { connectDomains: cspDomains, resourceDomains: cspDomains } },
  };

  // A UI resource's CSP must ride on its READ result — widget-capable hosts
  // (MCPJam's "widget-declared" mode, ChatGPT) read connect/resource domains from
  // here, not from the tool's _meta. Hosts default-deny, so without this the
  // sandbox blocks the media-card's image (img-src) and the dropzone's upload
  // (connect-src): the widget renders but its bytes never load. Both the spec key
  // (ui.csp, camelCase) and the legacy ChatGPT key (openai/widgetCSP, snake_case)
  // are declared so every host finds one it understands. Domains are the same
  // static per-deployment set as the tool CSP: the server origin always, plus the
  // S3 store origin when blobs are presigned off-origin — that S3 origin is
  // third-party and may not be honored by hosts that trust only the server origin
  // (e.g. Claude), the accepted tradeoff of serving file bytes direct from S3.
  const resourceMeta = {
    ui: { csp: { connectDomains: cspDomains, resourceDomains: cspDomains } },
    "openai/widgetCSP": { connect_domains: cspDomains, resource_domains: cspDomains },
  };

  for (const def of Object.values(WIDGETS)) {
    mcp.addResource({
      uri: def.uri,
      name: `widget: ${def.name}`,
      description: def.description,
      // MCP Apps (SEP-1865) requires this exact profile on a UI resource;
      // hosts use it to decide a resource is a renderable app.
      mimeType: "text/html;profile=mcp-app",
      // _meta isn't in fastmcp's ResourceResult type, but its resources/read
      // handler spreads the load() result verbatim — the cast lets the CSP _meta
      // ride through to the read result, where the host reads it.
      load: async () => {
        const result = { text: widgetHtml(def.name, "client"), _meta: resourceMeta };
        return result as { text: string };
      },
    });
  }

  // ---- Discovery & context ---------------------------------------------------

  addTool({
    name: "load",
    description:
      "Entry point — call this first whenever a request involves Yap: its spaces, stored items, files, or hooks, or a space or bundle the user names. Returns the spaces you can reach (id, name, description, keywords, bundle names, and your role — match the user's intent against this metadata before descending; if several spaces could match, ask the user which one), your autoloading user docs, and the space-level tool specs. Then descend: load_space → load_bundle → call. Run the chain silently — do not narrate loading calls.",
    annotations: { readOnlyHint: true, title: "Load context" },
    execute: async (_args, ctx) => {
      try {
        const userId = sessionUser(ctx.session);
        const { items: reachable, truncated } = await drainPages((cursor) =>
          listSpacesForUser(db, userId, { cursor, limit: 200 }),
        );
        const spaces = [];
        for (const space of reachable) {
          // Bundle names ride along so one load call is enough to route the
          // user's intent to a space; descriptions stay in load_space.
          const { items: visibleBundles } = await drainPages((cursor) =>
            listBundles(db, userId, space.id, { cursor, limit: 200 }),
          );
          spaces.push({
            id: space.id,
            name: space.name,
            description: space.description,
            keywords: space.keywords,
            personal: space.personal === 1,
            role: await effectiveCapabilities(db, userId, { space: toSpaceRef(space) }),
            bundles: visibleBundles.map((b) => b.name),
          });
        }
        const autoloaded = await userDocsCore.autoloadedUserDocs(db, userId);
        const allDocs = await userDocsCore.listUserDocs(db, userId);
        return asJson({
          ...(truncated ? { truncated: "more spaces exist than shown; use the REST API to page through all" } : {}),
          // An anchor for date-relative requests ("due this week") on hosts
          // that don't inject the current date themselves.
          world: { time: { iso: nowIso() } },
          spaces,
          user_docs: {
            autoloaded,
            available: allDocs.map((d) => ({ id: d.id, name: d.name, autoload: d.autoload === 1 })),
          },
          tools: {
            load_space: "Load a space's context, instructions, and bundles. Params: space_id.",
            load_bundle:
              "Load bundles' docs, item-type schemas, files, and hooks. Required before call. Params: bundle_ids.",
            call: { description: "Execute second-tier operations against bundles.", second_tier: SECOND_TIER_SPECS },
          },
        });
      } catch (err) {
        rethrow(err);
      }
    },
  });

  addTool({
    name: "whoami",
    description: "Return the currently authenticated user's minimal identity (id and name) and the running Yap Core version.",
    annotations: { readOnlyHint: true, title: "Who am I" },
    execute: async (_args, ctx) => {
      try {
        const userId = sessionUser(ctx.session);
        // version is a server-surface fact, not user identity — merged here
        // rather than in core whoami so the core stays a pure DB lookup.
        return asJson({ ...(await usersCore.whoami(db, userId)), version });
      } catch (err) {
        rethrow(err);
      }
    },
  });

  addTool({
    name: "load_space",
    description:
      "Step 2 of the discovery chain. Given a space id, returns the space's context (operator instructions to follow), the bundles it contains (id, name, description — pick the ones likely to hold the answer), and your role in the space. Next: load_bundle with the bundle ids you intend to use. Do not narrate this call.",
    parameters: z.object({ space_id: z.string() }),
    annotations: { readOnlyHint: true, title: "Load space" },
    execute: async (args, ctx) => {
      try {
        const userId = sessionUser(ctx.session);
        const space = await getSpaceRow(db, args.space_id);
        const ref = toSpaceRef(space);
        if (!(await canReachSpace(db, userId, space))) {
          throw new YapError("not_found", `space ${args.space_id} not found`);
        }
        const { items: bundles, truncated } = await drainPages((cursor) =>
          listBundles(db, userId, space.id, { cursor, limit: 200 }),
        );
        return asJson({
          id: space.id,
          name: space.name,
          context: space.context,
          role: await effectiveCapabilities(db, userId, { space: ref }),
          ...(truncated ? { truncated: "more bundles exist than shown; use the REST API to page through all" } : {}),
          bundles: bundles.map((b) => ({ id: b.id, name: b.name, description: b.description })),
        });
      } catch (err) {
        rethrow(err);
      }
    },
  });

  addTool({
    name: "load_bundle",
    description:
      "Step 3 — required before calling anything in a bundle. Returns everything needed to operate it correctly: the docs (autoloaded ones arrive in full — follow them; fetch the rest on demand with the read_docs call tool), the item-type schemas, the available files, and the available hooks (id, name, description, and declared parameters — never the transport). Item values may hold opaque references — resolve file://{uuid} via show_file and item://{uuid} via get_items before showing them to a user; never surface raw URIs. Params: bundle_ids (array). Do not narrate this call.",
    parameters: z.object({ bundle_ids: z.array(z.string()).min(1) }),
    annotations: { readOnlyHint: true, title: "Load bundles" },
    execute: async (args, ctx) => {
      try {
        const userId = sessionUser(ctx.session);
        const results = [];
        for (const bundleId of args.bundle_ids) {
          try {
            const bundleCtx = await getBundleContext(db, bundleId);
            await requireBundleReadAccess(db, userId, bundleCtx);
            const docRows = await bundleDocsCore.listDocsUnchecked(db, bundleId);
            results.push({
              id: bundleCtx.bundle.id,
              space_id: bundleCtx.space.id,
              name: bundleCtx.bundle.name,
              description: bundleCtx.bundle.description,
              docs: {
                autoloaded: docRows
                  .filter((d) => d.autoload === 1)
                  .map((d) => ({ name: d.name, content: d.content })),
                available: docRows.map((d) => ({ id: d.id, name: d.name, autoload: d.autoload === 1 })),
              },
              role: await effectiveCapabilities(db, userId, bundleCapabilityCtx(bundleCtx)),
              item_types: (await listItemTypesUnchecked(db, bundleId)).map((t) => ({
                id: t.id,
                name: t.name,
                properties: t.properties.map((p) => {
                  const cfg = parseConfig(p.config);
                  return {
                    id: p.id,
                    name: p.name,
                    datatype: p.datatype,
                    required: p.required === 1,
                    multi: p.multi === 1,
                    ...(Object.keys(cfg).length > 0 ? { config: cfg } : {}),
                  };
                }),
              })),
              files: await listFilesUnchecked(db, bundleId),
              hooks: (await listHooksUnchecked(db, bundleId)).map((h) => ({
                id: h.id,
                name: h.name,
                description: h.description,
                params: h.params,
              })),
            });
          } catch (err) {
            if (err instanceof YapError) {
              results.push({ id: bundleId, error: { code: err.code, message: err.message } });
            } else {
              throw err;
            }
          }
        }
        return asJson({ bundles: results });
      } catch (err) {
        rethrow(err);
      }
    },
  });

  addTool({
    name: "help",
    description:
      "Reference documentation for core Yap concepts (spaces, bundles, items, hooks, user docs, widgets, MCP usage). Cheap to consult when discovery metadata alone doesn't disambiguate.",
    annotations: { readOnlyHint: true, title: "Help" },
    execute: async () => HELP_TEXT,
  });

  // ---- Doing work --------------------------------------------------------------

  const callSchema = z.object({
    space_id: z.string(),
    calls: z
      .array(
        z.object({
          // Present for bundle-scoped tools; omitted for space-scoped tools,
          // which operate on space_id (e.g. update_space, space-level grants).
          bundle_id: z.string().optional(),
          tool: z.string(),
          params: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .min(1),
  });

  addTool({
    name: "call",
    description:
      `The single execution verb: a batch of second-tier operations in one round trip. You MUST call load_bundle on a bundle before calling into it — its docs and schemas are needed to call correctly. Each call names a tool, its params, and a target — a bundle (provide bundle_id) or the call's space (omit bundle_id, for space-scoped tools like update_space and grants). Calls succeed or fail independently (no cross-call rollback). Every tool is gated by the capability in its spec (returned by load) — check it against your role before calling; on a denial, tell the user which capability they lack rather than retrying. When reporting results, refer to items by their item-type name (e.g. "3 Todos"), never as "items". Second-tier tools: ${Object.keys(secondTier).join(", ")}.`,
    parameters: callSchema,
    _meta: callMeta,
    execute: async (args, ctx) => {
      try {
        const userId = sessionUser(ctx.session);
        const space = await getSpaceRow(db, args.space_id);
        if (!(await canReachSpace(db, userId, space))) {
          throw new YapError("not_found", `space ${args.space_id} not found`);
        }
        const results: PerCallResult[] = [];
        for (const call of args.calls) {
          results.push(
            await executeCall({ ...env, userId }, args.space_id, call, async (bundleId) => {
              try {
                return (await getBundleRow(db, bundleId)).spaceId;
              } catch {
                return null;
              }
            }),
          );
        }
        // Widget delivery stays in-band: each per-call _meta pointer (widget
        // uri + data) travels inside the JSON payload, which the inline widget
        // JS and the headless flow both read. We deliberately do NOT attach a
        // resource_link content item — it's an MCP 2025-06-18 content type, and
        // a client that negotiated an older protocol rejects the entire result
        // ("not a valid CallToolResult"). fastmcp 4.x doesn't expose the
        // negotiated version to a tool, so we can't gate it; text-only content
        // is portable to every client. Capable hosts still render via the
        // in-band _meta and show_widget's tool-level _meta.ui template.
        return { content: [{ type: "text" as const, text: asJson({ results }) }] };
      } catch (err) {
        rethrow(err);
      }
    },
  });

  // ---- Display -------------------------------------------------------------------

  // Static tool template for MCP Apps prefetch. The CSP lets the shell reach the
  // origins the widgets touch — fastmcp only forwards a static, tool-level _meta
  // (built once from config, not per call). fastmcp's _meta.ui type models only
  // resourceUri; it forwards _meta verbatim, so building this as a plain object
  // lets the spec's ui.csp ride along.
  const showWidgetMeta = {
    ui: {
      resourceUri: `${UI_SCHEME_PREFIX}shell`,
      csp: { connectDomains: cspDomains, resourceDomains: cspDomains },
    },
    // Flat alias: some hosts read the template link from a flat "ui/resourceUri"
    // key rather than the nested ui.resourceUri. Declaring both is cheap insurance.
    "ui/resourceUri": `${UI_SCHEME_PREFIX}shell`,
  };

  addTool({
    name: "show_widget",
    description: `Render any registered widget by name on a widget-capable (MCP Apps / SEP-1865) host — the statically-declared tool template (_meta.ui) is a thin shell that reads the named ui:// resource through the host and renders it with the supplied params. Registered widgets: ${Object.keys(WIDGETS).join(", ")}. On hosts that can't render widgets this just returns the widget reference as JSON; prefer the in-band links a tool already returns (e.g. upload_request's origin_upload_url) for those.`,
    parameters: z.object({
      widget: z.string().describe("Widget name or ui://yap/... URI"),
      params: z.record(z.string(), z.unknown()).optional(),
    }),
    annotations: { readOnlyHint: true, title: "Show widget" },
    _meta: showWidgetMeta,
    execute: async (args) => {
      const name = args.widget.replace(UI_SCHEME_PREFIX, "");
      const def = WIDGETS[name];
      if (!def) {
        throw new UserError(`unknown widget ${args.widget} (registered: ${Object.keys(WIDGETS).join(", ")})`);
      }
      // Two channels, no resource_link (see the note in `call`):
      //  - text content: the {widget, params} JSON, readable by any client.
      //  - structuredContent: how an MCP Apps host feeds the shell its data
      //    (delivered as ui/notifications/tool-result). We inline the chosen
      //    widget's style + render so the shell mounts it in its own document —
      //    no nested iframe, which strict hosts refuse to let a widget frame
      //    spawn (the old blank). resources/read stays the re-mount fallback.
      const params = args.params ?? {};
      return {
        content: [{ type: "text" as const, text: asJson({ widget: def.uri, params }) }],
        structuredContent: { widget: def.uri, params, style: def.style, render: def.render },
      };
    },
  });

  // ---- Authoring -----------------------------------------------------------------

  addTool({
    name: "space_create",
    description:
      "Create a new space owned by you (an account-level right — every user may create spaces). Params: name, description?, keywords? (comma-separated, used for discovery matching), context? (instructions agents receive on load_space).",
    parameters: z.object({
      name: z.string(),
      description: z.string().optional(),
      keywords: z.string().optional(),
      context: z.string().optional(),
    }),
    execute: async (args, ctx) => {
      try {
        const userId = sessionUser(ctx.session);
        const space = await createSpace(db, userId, args);
        return asJson({ id: space.id, name: space.name });
      } catch (err) {
        rethrow(err);
      }
    },
  });

  addTool({
    name: "bundle_create",
    description: `Create a bundle — docs, item-types, and initial structure — and install it into a space, in one validated step. Invalid input is rejected with actionable errors and nothing is applied.

Input format:
- space_id: target space id (you need the create_bundles capability there)
- name: bundle name (required)
- description: one-line summary used for discovery
- docs: named markdown docs, [{ name, content?, autoload? }] — set autoload: true for operating instructions agents must always see; leave it off for reference material loaded on demand
- item_types: array of schemas, each { name, properties: [{ name, datatype: ${DATATYPES.join(" | ")}, required?, multi?, config? }] }

Datatypes: text, number, boolean, date, plus item (a reference to another item in this bundle, item://<id>) and file (a reference to a finalized file, file://<id>). A property with multi: true holds an ordered list of values of its datatype (e.g. a multi text "tags" holds ["a","b"]); items then read/write that field as an array. config declares constraints, enforced on every write: text {pattern}; number {min, max, decimals} (decimals default 2, out-of-precision writes rejected); item {itemType} (pin the referent's type); any multi field {minItems, maxItems}. Properties can be renamed/added/removed later without touching stored data.`,
    parameters: z.object({
      space_id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      docs: z
        .array(z.object({ name: z.string(), content: z.string().optional(), autoload: z.boolean().optional() }))
        .optional(),
      item_types: z
        .array(
          z.object({
            name: z.string(),
            properties: z.array(
              z.object({
                name: z.string(),
                datatype: z.enum(DATATYPES),
                required: z.boolean().optional(),
                multi: z.boolean().optional(),
                config: propertyConfigSchema.optional(),
              }),
            ),
          }),
        )
        .optional(),
    }),
    execute: async (args, ctx) => {
      try {
        const userId = sessionUser(ctx.session);
        const bundle = await createBundle(db, userId, args.space_id, {
          name: args.name,
          description: args.description,
          docs: args.docs,
          itemTypes: args.item_types,
        });
        return asJson({ id: bundle.id, space_id: bundle.spaceId, name: bundle.name });
      } catch (err) {
        rethrow(err);
      }
    },
  });

  // ---- User docs (account-level; require load but not load_space) ---------------

  addTool({
    name: "list_user_docs",
    description: "List your user docs (id, name, autoload flag) — account-level docs available across all your spaces.",
    annotations: { readOnlyHint: true, title: "List user docs" },
    execute: async (_args, ctx) => {
      try {
        const userId = sessionUser(ctx.session);
        const docs = await userDocsCore.listUserDocs(db, userId);
        return asJson({ data: docs.map((d) => ({ ...d, autoload: d.autoload === 1 })) });
      } catch (err) {
        rethrow(err);
      }
    },
  });

  addTool({
    name: "load_user_docs",
    description: "Full content of specific user docs, by id or name. Params: refs (array of ids or names).",
    parameters: z.object({ refs: z.array(z.string()).min(1) }),
    annotations: { readOnlyHint: true, title: "Load user docs" },
    execute: async (args, ctx) => {
      try {
        const userId = sessionUser(ctx.session);
        return asJson({ data: await userDocsCore.loadUserDocs(db, userId, args.refs) });
      } catch (err) {
        rethrow(err);
      }
    },
  });

  addTool({
    name: "create_user_doc",
    description:
      "Create a user doc. Set autoload: true to have it surface at the start of every session (via load). Params: name, content?, autoload?.",
    parameters: z.object({
      name: z.string(),
      content: z.string().optional(),
      autoload: z.boolean().optional(),
    }),
    execute: async (args, ctx) => {
      try {
        const userId = sessionUser(ctx.session);
        return asJson(await userDocsCore.createUserDoc(db, userId, args));
      } catch (err) {
        rethrow(err);
      }
    },
  });

  addTool({
    name: "update_user_doc",
    description: "Update a user doc's name, content, or autoload flag. Params: id, name?, content?, autoload?.",
    parameters: z.object({
      id: z.string(),
      name: z.string().optional(),
      content: z.string().optional(),
      autoload: z.boolean().optional(),
    }),
    execute: async (args, ctx) => {
      try {
        const userId = sessionUser(ctx.session);
        const { id, ...patch } = args;
        return asJson(await userDocsCore.updateUserDoc(db, userId, id, patch));
      } catch (err) {
        rethrow(err);
      }
    },
  });

  addTool({
    name: "delete_user_doc",
    description: "Delete a user doc by id.",
    parameters: z.object({ id: z.string() }),
    execute: async (args, ctx) => {
      try {
        const userId = sessionUser(ctx.session);
        await userDocsCore.deleteUserDoc(db, userId, args.id);
        return asJson({ deleted: true });
      } catch (err) {
        rethrow(err);
      }
    },
  });
}
