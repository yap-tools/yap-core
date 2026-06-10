/**
 * The top-level MCP surface: a small, fixed tool set built around progressive
 * disclosure — load → load_space → load_bundle → call — plus authoring
 * (space_create, bundle_create), help, and the five user-doc tools. Every
 * tool is a thin adapter over the core; capability gates live in the core.
 */
import { UserError } from "fastmcp";
import { z } from "zod";

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
import { listFilesUnchecked } from "../core/files.js";
import { listHooksUnchecked } from "../core/hooks.js";
import { listItemTypesUnchecked } from "../core/itemTypes.js";
import type { Page } from "../core/pagination.js";
import { canReachSpace, createSpace, getSpaceRow, listSpacesForUser, toSpaceRef } from "../core/spaces.js";
import * as userDocsCore from "../core/userDocs.js";
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
    { description: tool.description, capability: tool.capability },
  ]),
);

export function registerMcpTools(server: YapServer): void {
  const { mcp, db, config, blob } = server;
  const env = { db, config, blob, baseUrl: config.baseUrl };

  // ---- The widget registry: every widget is a ui:// resource -------------------

  for (const def of Object.values(WIDGETS)) {
    mcp.addResource({
      uri: def.uri,
      name: `widget: ${def.name}`,
      description: def.description,
      mimeType: "text/html",
      load: async () => ({ text: widgetHtml(def.name, "client") }),
    });
  }

  // ---- Discovery & context ---------------------------------------------------

  mcp.addTool({
    name: "load",
    description:
      "Entry point. Returns the spaces you can reach (id, name, description, keywords, and your role — use this metadata to match the user's intent before descending), your autoloading user docs, and the space-level tool specs.",
    annotations: { readOnlyHint: true, title: "Load context" },
    execute: async (_args, ctx) => {
      try {
        const userId = sessionUser(ctx.session);
        const { items: reachable, truncated } = await drainPages((cursor) =>
          listSpacesForUser(db, userId, { cursor, limit: 200 }),
        );
        const spaces = [];
        for (const space of reachable) {
          spaces.push({
            id: space.id,
            name: space.name,
            description: space.description,
            keywords: space.keywords,
            personal: space.personal === 1,
            role: await effectiveCapabilities(db, userId, { space: toSpaceRef(space) }),
          });
        }
        const autoloaded = await userDocsCore.autoloadedUserDocs(db, userId);
        const allDocs = await userDocsCore.listUserDocs(db, userId);
        return asJson({
          ...(truncated ? { truncated: "more spaces exist than shown; use the REST API to page through all" } : {}),
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

  mcp.addTool({
    name: "load_space",
    description:
      "Given a space id, returns the space's context (operator instructions to follow), the bundles it contains (id, name, description — pick the ones likely to hold the answer), and your role in the space.",
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

  mcp.addTool({
    name: "load_bundle",
    description:
      "Required before calling anything in a bundle. Returns everything needed to operate it correctly: the docs (binding — read and follow them), the item-type schemas, the available files, and the available hooks (name, description, and declared parameters only). Params: bundle_ids (array).",
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
            results.push({
              id: bundleCtx.bundle.id,
              space_id: bundleCtx.space.id,
              name: bundleCtx.bundle.name,
              description: bundleCtx.bundle.description,
              docs: bundleCtx.bundle.docs,
              role: await effectiveCapabilities(db, userId, bundleCapabilityCtx(bundleCtx)),
              item_types: (await listItemTypesUnchecked(db, bundleId)).map((t) => ({
                id: t.id,
                name: t.name,
                properties: t.properties.map((p) => ({
                  name: p.name,
                  datatype: p.datatype,
                  required: p.required === 1,
                  multi: p.multi === 1,
                })),
              })),
              files: await listFilesUnchecked(db, bundleId),
              hooks: (await listHooksUnchecked(db, bundleId)).map((h) => ({
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

  mcp.addTool({
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
          bundle_id: z.string(),
          tool: z.string(),
          params: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .min(1),
  });

  mcp.addTool({
    name: "call",
    description:
      `The single execution verb: a batch of second-tier operations in one round trip. Each call names a bundle, a tool, and params; calls succeed or fail independently (no cross-call rollback). Load the bundle first (load_bundle). Second-tier tools: ${Object.keys(secondTier).join(", ")}.`,
    parameters: callSchema,
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
        // Result-level widget delivery: per-call _meta pointers travel in the
        // JSON payload, and each referenced ui:// resource is also attached as
        // a spec-clean resource_link content item for MCP-Apps-capable hosts.
        // (fastmcp's result validation rejects a literal result `_meta` key.)
        const widgetUris = [...new Set(results.flatMap((r) => (r._meta ? [r._meta.widget] : [])))];
        return {
          content: [
            { type: "text" as const, text: asJson({ results }) },
            ...widgetUris.flatMap((uri) => {
              const def = WIDGETS[uri.replace(UI_SCHEME_PREFIX, "")];
              if (!def) return [];
              return [
                {
                  type: "resource_link" as const,
                  uri,
                  name: def.name,
                  mimeType: "text/html",
                  description: def.description,
                },
              ];
            }),
          ],
        };
      } catch (err) {
        rethrow(err);
      }
    },
  });

  // ---- Display -------------------------------------------------------------------

  mcp.addTool({
    name: "show_widget",
    description: `Render any registered widget by name. The statically-declared template is a thin shell that reads the named ui:// widget resource through the host and renders it with the supplied params. Registered widgets: ${Object.keys(WIDGETS).join(", ")}. Also the recovery path when a host did not render a widget from call's result metadata.`,
    parameters: z.object({
      widget: z.string().describe("Widget name or ui://yap/... URI"),
      params: z.record(z.string(), z.unknown()).optional(),
    }),
    annotations: { readOnlyHint: true, title: "Show widget" },
    _meta: { ui: { resourceUri: `${UI_SCHEME_PREFIX}shell` } },
    execute: async (args) => {
      const name = args.widget.replace(UI_SCHEME_PREFIX, "");
      const def = WIDGETS[name];
      if (!def) {
        throw new UserError(`unknown widget ${args.widget} (registered: ${Object.keys(WIDGETS).join(", ")})`);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: asJson({ widget: def.uri, params: args.params ?? {} }),
          },
          {
            type: "resource_link" as const,
            uri: def.uri,
            name: def.name,
            mimeType: "text/html",
            description: def.description,
          },
        ],
      };
    },
  });

  // ---- Authoring -----------------------------------------------------------------

  mcp.addTool({
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

  mcp.addTool({
    name: "bundle_create",
    description: `Create a bundle — docs, item-types, and initial structure — and install it into a space, in one validated step. Invalid input is rejected with actionable errors and nothing is applied.

Input format:
- space_id: target space id (you need the create_bundles capability there)
- name: bundle name (required)
- description: one-line summary used for discovery
- docs: the bundle's operating instructions (agents must follow these)
- item_types: array of schemas, each { name, properties: [{ name, datatype: ${DATATYPES.join(" | ")}, required?, multi? }] }

A property with multi: true holds an ordered list of values of its datatype (e.g. a multi text "tags" holds ["a","b"]); items then read/write that field as an array. Items are validated against these schemas on every write; properties can be renamed/added/removed later without touching stored data.`,
    parameters: z.object({
      space_id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      docs: z.string().optional(),
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

  mcp.addTool({
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

  mcp.addTool({
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

  mcp.addTool({
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

  mcp.addTool({
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

  mcp.addTool({
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
