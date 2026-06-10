/**
 * REST surface: the management plane. Every route here is a thin adapter —
 * parse/validate input, call the core, shape the response. No domain logic.
 * Conventions (normative per the brief): routes under /v1, JSON bodies,
 * bearer auth, cursor pagination (?cursor= & ?limit=), and errors shaped as
 * { error: { code, message, details? } }.
 */
import type { ServerResponse } from "node:http";

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import { hasAnyCapability } from "../core/capabilities.js";
import { YapError, invalid } from "../core/errors.js";
import * as grantsCore from "../core/grants.js";
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
}
