/**
 * REST surface: the management plane. Every route here is a thin adapter —
 * parse/validate input, call the core, shape the response. No domain logic.
 * Conventions (normative per the brief): routes under /v1, JSON bodies,
 * bearer auth, cursor pagination (?cursor= & ?limit=), and errors shaped as
 * { error: { code, message, details? } }.
 */
import type { ServerResponse } from "node:http";

import { eq } from "drizzle-orm";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import * as bundlesCore from "../core/bundles.js";
import { hasAnyCapability } from "../core/capabilities.js";
import * as docsCore from "../core/docs.js";
import { YapError, invalid } from "../core/errors.js";
import * as grantsCore from "../core/grants.js";
import * as itemTypesCore from "../core/itemTypes.js";
import * as itemsCore from "../core/items.js";
import * as keysCore from "../core/keys.js";
import * as spacesCore from "../core/spaces.js";
import * as usersCore from "../core/users.js";
import type { YapServer } from "../server.js";
import { requireSysadmin, requireUser } from "./auth.js";

type Handler = (c: Context) => Promise<Response>;

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw invalid("invalid request body", result.error.issues);
  }
  return result.data;
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw invalid("request body must be valid JSON");
  }
}

function pageOpts(c: Context): { cursor?: string; limit?: string } {
  return { cursor: c.req.query("cursor"), limit: c.req.query("limit") };
}

function param(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value) throw invalid(`missing path parameter ${name}`);
  return value;
}

/**
 * fastmcp's HTTP bridge treats any Hono 404 response as "route not matched"
 * and discards its body. Domain-level 404s therefore write directly to the
 * underlying Node response (fastmcp passes it as Hono env) and hand the
 * bridge a dummy non-404 response it will skip because headers are sent.
 */
function sendDirect404(c: Context, body: unknown): Response | null {
  const outgoing = (c.env as { outgoing?: ServerResponse } | undefined)?.outgoing;
  if (!outgoing || outgoing.headersSent) return null;
  outgoing.writeHead(404, { "content-type": "application/json" });
  outgoing.end(JSON.stringify(body));
  return c.body(null, 204);
}

export function registerRestRoutes(server: YapServer): void {
  const app = server.mcp.getApp();
  const { db, config, logger } = server;

  const handle =
    (fn: Handler) =>
    async (c: Context): Promise<Response> => {
      try {
        return await fn(c);
      } catch (err) {
        if (err instanceof YapError) {
          if (err.httpStatus === 404) {
            const direct = sendDirect404(c, err.toBody());
            if (direct) return direct;
          }
          return c.json(err.toBody(), err.httpStatus as ContentfulStatusCode);
        }
        logger.error("unhandled REST error", err);
        return c.json({ error: { code: "internal", message: "internal error" } }, 500);
      }
    };

  // ---- Users (sysadmin key) -------------------------------------------------

  const createUserSchema = z.object({ name: z.string() });

  app.post(
    "/v1/users",
    handle(async (c) => {
      requireSysadmin(c, config);
      const body = parseBody(createUserSchema, await jsonBody(c));
      const created = await usersCore.createUser(db, body);
      return c.json(created, 201);
    }),
  );

  app.get(
    "/v1/users",
    handle(async (c) => {
      requireSysadmin(c, config);
      return c.json(await usersCore.listUsers(db, pageOpts(c)));
    }),
  );

  app.get(
    "/v1/users/:id",
    handle(async (c) => {
      requireSysadmin(c, config);
      return c.json(await usersCore.getUser(db, param(c, "id")));
    }),
  );

  app.delete(
    "/v1/users/:id",
    handle(async (c) => {
      requireSysadmin(c, config);
      await usersCore.deleteUser(db, param(c, "id"));
      return c.json({ deleted: true });
    }),
  );

  // ---- Keys (self) ----------------------------------------------------------

  const createKeySchema = z.object({ name: z.string().optional() });

  app.post(
    "/v1/keys",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      const body = parseBody(createKeySchema, await jsonBody(c));
      return c.json(await keysCore.createKey(db, userId, body.name ?? ""), 201);
    }),
  );

  app.get(
    "/v1/keys",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      return c.json({ data: await keysCore.listKeys(db, userId) });
    }),
  );

  app.post(
    "/v1/keys/:id/rotate",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      return c.json(await keysCore.rotateKey(db, userId, param(c, "id")));
    }),
  );

  app.delete(
    "/v1/keys/:id",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      await keysCore.deleteKey(db, userId, param(c, "id"));
      return c.json({ deleted: true });
    }),
  );

  // ---- Spaces ---------------------------------------------------------------

  const spaceCreateSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    keywords: z.string().optional(),
    context: z.string().optional(),
  });

  const spacePatchSchema = z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    keywords: z.string().optional(),
    context: z.string().optional(),
  });

  app.post(
    "/v1/spaces",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      const body = parseBody(spaceCreateSchema, await jsonBody(c));
      return c.json(await spacesCore.createSpace(db, userId, body), 201);
    }),
  );

  app.get(
    "/v1/spaces",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      return c.json(await spacesCore.listSpacesForUser(db, userId, pageOpts(c)));
    }),
  );

  app.get(
    "/v1/spaces/:id",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      const space = await spacesCore.getSpaceRow(db, param(c, "id"));
      // Reachability: ownership or any effective capability on the space.
      if (space.ownerId !== userId && !(await hasAnyCapability(db, userId, { space: spacesCore.toSpaceRef(space) }))) {
        throw new YapError("not_found", `space ${space.id} not found`);
      }
      return c.json(space);
    }),
  );

  app.patch(
    "/v1/spaces/:id",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      const body = parseBody(spacePatchSchema, await jsonBody(c));
      return c.json(await spacesCore.updateSpace(db, userId, param(c, "id"), body));
    }),
  );

  app.delete(
    "/v1/spaces/:id",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      await spacesCore.deleteSpace(db, userId, param(c, "id"));
      return c.json({ deleted: true });
    }),
  );

  // ---- Grants (space-level; bundle-level registered with bundles) -----------

  const grantSchema = z.object({
    userId: z.string(),
    capability: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    effect: z.enum(["allow", "deny"]),
  });

  function grantCapabilities(body: z.infer<typeof grantSchema>): string[] {
    const caps = body.capabilities ?? (body.capability ? [body.capability] : []);
    if (caps.length === 0) throw invalid("capability or capabilities is required");
    return caps;
  }

  app.post(
    "/v1/spaces/:id/grants",
    handle(async (c) => {
      const actorId = await requireUser(c, db, config);
      const body = parseBody(grantSchema, await jsonBody(c));
      const target = await grantsCore.spaceGrantTarget(db, param(c, "id"));
      const rows = await grantsCore.createGrants(db, actorId, target, {
        userId: body.userId,
        capabilities: grantCapabilities(body),
        effect: body.effect,
      });
      return c.json({ data: rows }, 201);
    }),
  );

  app.get(
    "/v1/spaces/:id/grants",
    handle(async (c) => {
      const actorId = await requireUser(c, db, config);
      const target = await grantsCore.spaceGrantTarget(db, param(c, "id"));
      return c.json({ data: await grantsCore.listGrants(db, actorId, target) });
    }),
  );

  app.delete(
    "/v1/spaces/:id/grants/:grantId",
    handle(async (c) => {
      const actorId = await requireUser(c, db, config);
      const target = await grantsCore.spaceGrantTarget(db, param(c, "id"));
      await grantsCore.deleteGrant(db, actorId, target, param(c, "grantId"));
      return c.json({ deleted: true });
    }),
  );

  app.post(
    "/v1/bundles/:id/grants",
    handle(async (c) => {
      const actorId = await requireUser(c, db, config);
      const body = parseBody(grantSchema, await jsonBody(c));
      const target = await bundlesCore.bundleGrantTarget(db, param(c, "id"));
      const rows = await grantsCore.createGrants(db, actorId, target, {
        userId: body.userId,
        capabilities: grantCapabilities(body),
        effect: body.effect,
      });
      return c.json({ data: rows }, 201);
    }),
  );

  app.get(
    "/v1/bundles/:id/grants",
    handle(async (c) => {
      const actorId = await requireUser(c, db, config);
      const target = await bundlesCore.bundleGrantTarget(db, param(c, "id"));
      return c.json({ data: await grantsCore.listGrants(db, actorId, target) });
    }),
  );

  app.delete(
    "/v1/bundles/:id/grants/:grantId",
    handle(async (c) => {
      const actorId = await requireUser(c, db, config);
      const target = await bundlesCore.bundleGrantTarget(db, param(c, "id"));
      await grantsCore.deleteGrant(db, actorId, target, param(c, "grantId"));
      return c.json({ deleted: true });
    }),
  );

  // ---- Bundles ---------------------------------------------------------------

  const propertyInputSchema = z.object({
    name: z.string(),
    datatype: z.enum(bundlesCore.DATATYPES),
    required: z.boolean().optional(),
  });

  const bundleCreateSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    docs: z.string().optional(),
    itemTypes: z
      .array(z.object({ name: z.string(), properties: z.array(propertyInputSchema) }))
      .optional(),
  });

  app.post(
    "/v1/spaces/:id/bundles",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      const body = parseBody(bundleCreateSchema, await jsonBody(c));
      return c.json(await bundlesCore.createBundle(db, userId, param(c, "id"), body), 201);
    }),
  );

  app.get(
    "/v1/spaces/:id/bundles",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      return c.json(await bundlesCore.listBundles(db, userId, param(c, "id"), pageOpts(c)));
    }),
  );

  app.get(
    "/v1/bundles/:id",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      const ctx = await bundlesCore.getBundleContext(db, param(c, "id"));
      await bundlesCore.requireBundleReadAccess(db, userId, ctx);
      const itemTypes = await itemTypesCore.listItemTypesUnchecked(db, ctx.bundle.id);
      return c.json({ ...ctx.bundle, itemTypes });
    }),
  );

  app.patch(
    "/v1/bundles/:id",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      const body = parseBody(
        z.object({ name: z.string().optional(), description: z.string().optional() }),
        await jsonBody(c),
      );
      return c.json(await bundlesCore.updateBundle(db, userId, param(c, "id"), body));
    }),
  );

  app.delete(
    "/v1/bundles/:id",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      await bundlesCore.deleteBundle(db, userId, param(c, "id"));
      return c.json({ deleted: true });
    }),
  );

  // ---- Docs ------------------------------------------------------------------

  app.get(
    "/v1/bundles/:id/docs",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      return c.json(await docsCore.readDocs(db, userId, param(c, "id")));
    }),
  );

  app.put(
    "/v1/bundles/:id/docs",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      const body = parseBody(z.object({ docs: z.string() }), await jsonBody(c));
      return c.json(await docsCore.updateDocs(db, userId, param(c, "id"), body.docs));
    }),
  );

  // ---- Item-types & properties -------------------------------------------------

  app.post(
    "/v1/bundles/:id/item-types",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      const body = parseBody(
        z.object({ name: z.string(), properties: z.array(propertyInputSchema).optional() }),
        await jsonBody(c),
      );
      return c.json(await itemTypesCore.createItemType(db, userId, param(c, "id"), body), 201);
    }),
  );

  app.get(
    "/v1/bundles/:id/item-types",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      return c.json({ data: await itemTypesCore.listItemTypes(db, userId, param(c, "id")) });
    }),
  );

  app.patch(
    "/v1/item-types/:id",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      const body = parseBody(z.object({ name: z.string().optional() }), await jsonBody(c));
      await itemTypesCore.updateItemType(db, userId, param(c, "id"), body);
      return c.json({ updated: true });
    }),
  );

  app.delete(
    "/v1/item-types/:id",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      await itemTypesCore.deleteItemType(db, userId, param(c, "id"));
      return c.json({ deleted: true });
    }),
  );

  app.post(
    "/v1/item-types/:id/properties",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      const body = parseBody(propertyInputSchema, await jsonBody(c));
      return c.json(await itemTypesCore.addProperty(db, userId, param(c, "id"), body), 201);
    }),
  );

  app.patch(
    "/v1/item-types/:id/properties/:propId",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      const body = parseBody(
        z.object({ name: z.string().optional(), required: z.boolean().optional(), sortOrder: z.number().int().optional() }),
        await jsonBody(c),
      );
      return c.json(await itemTypesCore.updateProperty(db, userId, param(c, "id"), param(c, "propId"), body));
    }),
  );

  app.delete(
    "/v1/item-types/:id/properties/:propId",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      await itemTypesCore.deleteProperty(db, userId, param(c, "id"), param(c, "propId"));
      return c.json({ deleted: true });
    }),
  );

  // ---- Items -------------------------------------------------------------------

  const filterSchema = z.object({
    property: z.string(),
    op: z.enum(itemsCore.FILTER_OPS),
    value: z.unknown(),
  });

  app.post(
    "/v1/bundles/:id/items",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      const body = parseBody(
        z.object({ itemType: z.string(), items: z.array(z.record(z.string(), z.unknown())) }),
        await jsonBody(c),
      );
      return c.json({ data: await itemsCore.createItems(db, userId, param(c, "id"), body) }, 201);
    }),
  );

  app.get(
    "/v1/bundles/:id/items",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      const itemType = c.req.query("itemType") ?? c.req.query("item_type");
      const ids = c.req.query("ids");
      if (ids) {
        return c.json({ data: await itemsCore.getItems(db, userId, param(c, "id"), ids.split(",")) });
      }
      if (!itemType) throw invalid("itemType query parameter is required (or pass ids=)");
      let filters: itemsCore.ItemFilter[] | undefined;
      const filtersRaw = c.req.query("filters");
      if (filtersRaw) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(filtersRaw);
        } catch {
          throw invalid("filters must be a JSON array");
        }
        filters = z.array(filterSchema).parse(parsed) as itemsCore.ItemFilter[];
      }
      const sortProp = c.req.query("sort");
      const direction = (c.req.query("direction") as "asc" | "desc" | undefined) ?? "asc";
      return c.json(
        await itemsCore.queryItems(db, userId, param(c, "id"), {
          itemType,
          filters,
          ...(sortProp ? { sort: { property: sortProp, direction } } : {}),
          cursor: c.req.query("cursor"),
          limit: c.req.query("limit"),
        }),
      );
    }),
  );

  app.patch(
    "/v1/items/:id",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      const body = parseBody(z.object({ set: z.record(z.string(), z.unknown()) }), await jsonBody(c));
      const itemId = param(c, "id");
      const bundleId = await itemBundleId(c, itemId);
      const updated = await itemsCore.updateItems(db, userId, bundleId, [{ id: itemId, set: body.set }]);
      return c.json(updated[0]);
    }),
  );

  app.delete(
    "/v1/items/:id",
    handle(async (c) => {
      const userId = await requireUser(c, db, config);
      const itemId = param(c, "id");
      const bundleId = await itemBundleId(c, itemId);
      await itemsCore.deleteItems(db, userId, bundleId, [itemId]);
      return c.json({ deleted: true });
    }),
  );

  async function itemBundleId(_c: Context, itemId: string): Promise<string> {
    const { items } = db.tables;
    const rows = await db.client.select({ bundleId: items.bundleId }).from(items).where(eq(items.id, itemId));
    if (rows.length === 0) throw new YapError("not_found", `item ${itemId} not found`);
    return rows[0]!.bundleId;
  }
}
