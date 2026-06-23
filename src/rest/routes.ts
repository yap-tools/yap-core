/**
 * REST surface: the management plane. Every route here is a thin adapter —
 * parse/validate input, call the core, shape the response. No domain logic.
 * Conventions (normative per the brief): routes under /v1, JSON bodies,
 * bearer auth, cursor pagination (?cursor= & ?limit=), and errors shaped as
 * { error: { code, message, details? } }.
 */
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import { runWithTokenAuth } from "../core/authScope.js";
import * as bundlesCore from "../core/bundles.js";
import * as bundleDocsCore from "../core/bundleDocs.js";
import { YapError, invalid, unauthorized } from "../core/errors.js";
import * as oauthCore from "../core/oauth.js";
import * as filesCore from "../core/files.js";
import * as grantsCore from "../core/grants.js";
import * as hooksCore from "../core/hooks.js";
import * as itemTypesCore from "../core/itemTypes.js";
import * as itemsCore from "../core/items.js";
import * as keysCore from "../core/keys.js";
import { propertyConfigSchema } from "../core/propertyConfig.js";
import { editOpSchema, type EditOp } from "../core/textEdits.js";
import * as spacesCore from "../core/spaces.js";
import * as userDocsCore from "../core/userDocs.js";
import { headerSafeFilename } from "../core/util.js";
import * as usersCore from "../core/users.js";
import { verifyToken } from "../crypto.js";
import type { YapServer } from "../server.js";
import { buildOriginPage } from "../widgets/pages.js";
import { resolveCredential, type CredentialOutcome } from "../core/credential.js";
import { bearerFrom, requireSysadmin, requireUser } from "./auth.js";

type Handler = (c: Context, auth: CredentialOutcome) => Promise<Response>;

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

function parseContentLength(c: Context, maxBytes: number): number | undefined {
  const raw = c.req.header("content-length");
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw invalid("invalid content-length header");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw invalid("invalid content-length header");
  }
  if (parsed > maxBytes) {
    throw invalid(`file exceeds the maximum size of ${maxBytes} bytes`);
  }
  return parsed;
}

function bytesFromChunk(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw invalid("request body must be bytes");
}

async function readBoundedBody(c: Context, maxBytes: number): Promise<Uint8Array> {
  const body = c.req.raw.body;
  if (!body) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let total = 0;
  const stream = body as ReadableStream<unknown> & AsyncIterable<unknown>;
  for await (const rawChunk of stream) {
    const chunk = bytesFromChunk(rawChunk);
    const nextTotal = total + chunk.byteLength;
    if (nextTotal > maxBytes) {
      await body.cancel().catch(() => {});
      throw invalid(`file exceeds the maximum size of ${maxBytes} bytes`);
    }
    chunks.push(chunk);
    total = nextTotal;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
  const { db, config, logger, blob } = server;
  const fileEnv: filesCore.FileEnv = { db, blob, config };

  const handle =
    (fn: Handler) =>
    async (c: Context): Promise<Response> => {
      try {
        // Resolve the presented credential once; every handler receives the
        // outcome. The token lane additionally runs inside its scope context,
        // so capability resolution deep in core sees the clamp.
        const auth = await resolveCredential(db, config, bearerFrom(c));
        if (auth.kind === "token") {
          return await runWithTokenAuth(auth.tokenAuth, () => fn(c, auth));
        }
        return await fn(c, auth);
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
    handle(async (c, auth) => {
      requireSysadmin(auth);
      const body = parseBody(createUserSchema, await jsonBody(c));
      const created = await usersCore.createUser(db, body);
      return c.json(created, 201);
    }),
  );

  app.get(
    "/v1/users",
    handle(async (c, auth) => {
      requireSysadmin(auth);
      return c.json(await usersCore.listUsers(db, pageOpts(c)));
    }),
  );

  app.get(
    "/v1/users/:id",
    handle(async (c, auth) => {
      requireSysadmin(auth);
      return c.json(await usersCore.getUser(db, param(c, "id")));
    }),
  );

  app.delete(
    "/v1/users/:id",
    handle(async (c, auth) => {
      requireSysadmin(auth);
      await usersCore.deleteUser(db, param(c, "id"), blob);
      return c.json({ deleted: true });
    }),
  );

  // ---- Keys (self) ----------------------------------------------------------

  app.get(
    "/v1/whoami",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      return c.json(await usersCore.whoami(db, userId));
    }),
  );

  const createKeySchema = z.object({ name: z.string().optional() });

  app.post(
    "/v1/keys",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const body = parseBody(createKeySchema, await jsonBody(c));
      return c.json(await keysCore.createKey(db, userId, body.name ?? ""), 201);
    }),
  );

  app.get(
    "/v1/keys",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      return c.json({ data: await keysCore.listKeys(db, userId) });
    }),
  );

  app.post(
    "/v1/keys/:id/rotate",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      return c.json(await keysCore.rotateKey(db, userId, param(c, "id")));
    }),
  );

  app.delete(
    "/v1/keys/:id",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      await keysCore.deleteKey(db, userId, param(c, "id"));
      return c.json({ deleted: true });
    }),
  );

  // ---- Connected apps (OAuth grants, self) -----------------------------------

  app.get(
    "/v1/oauth/grants",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      return c.json({ data: await oauthCore.listUserGrants(db, userId) });
    }),
  );

  app.delete(
    "/v1/oauth/grants/:id",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      await oauthCore.revokeUserGrant(db, userId, param(c, "id"));
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
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const body = parseBody(spaceCreateSchema, await jsonBody(c));
      return c.json(await spacesCore.createSpace(db, userId, body), 201);
    }),
  );

  app.get(
    "/v1/spaces",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      return c.json(await spacesCore.listSpacesForUser(db, userId, pageOpts(c)));
    }),
  );

  app.get(
    "/v1/spaces/:id",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const space = await spacesCore.getSpaceRow(db, param(c, "id"));
      if (!(await spacesCore.canReachSpace(db, userId, space))) {
        throw new YapError("not_found", `space ${space.id} not found`);
      }
      return c.json(space);
    }),
  );

  app.patch(
    "/v1/spaces/:id",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const body = parseBody(spacePatchSchema, await jsonBody(c));
      return c.json(await spacesCore.updateSpace(db, userId, param(c, "id"), body));
    }),
  );

  app.delete(
    "/v1/spaces/:id",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      await spacesCore.deleteSpace(db, userId, param(c, "id"), blob);
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
    handle(async (c, auth) => {
      const actorId = requireUser(auth);
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
    handle(async (c, auth) => {
      const actorId = requireUser(auth);
      const target = await grantsCore.spaceGrantTarget(db, param(c, "id"));
      return c.json({ data: await grantsCore.listGrants(db, actorId, target) });
    }),
  );

  app.delete(
    "/v1/spaces/:id/grants/:grantId",
    handle(async (c, auth) => {
      const actorId = requireUser(auth);
      const target = await grantsCore.spaceGrantTarget(db, param(c, "id"));
      await grantsCore.deleteGrant(db, actorId, target, param(c, "grantId"));
      return c.json({ deleted: true });
    }),
  );

  app.post(
    "/v1/bundles/:id/grants",
    handle(async (c, auth) => {
      const actorId = requireUser(auth);
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
    handle(async (c, auth) => {
      const actorId = requireUser(auth);
      const target = await bundlesCore.bundleGrantTarget(db, param(c, "id"));
      return c.json({ data: await grantsCore.listGrants(db, actorId, target) });
    }),
  );

  app.delete(
    "/v1/bundles/:id/grants/:grantId",
    handle(async (c, auth) => {
      const actorId = requireUser(auth);
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
    multi: z.boolean().optional(),
    config: propertyConfigSchema.optional(),
  });

  const bundleCreateSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    docs: z
      .array(z.object({ name: z.string(), content: z.string().optional(), autoload: z.boolean().optional() }))
      .optional(),
    itemTypes: z
      .array(z.object({ name: z.string(), properties: z.array(propertyInputSchema) }))
      .optional(),
  });

  app.post(
    "/v1/spaces/:id/bundles",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const body = parseBody(bundleCreateSchema, await jsonBody(c));
      return c.json(await bundlesCore.createBundle(db, userId, param(c, "id"), body), 201);
    }),
  );

  app.get(
    "/v1/spaces/:id/bundles",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      return c.json(await bundlesCore.listBundles(db, userId, param(c, "id"), pageOpts(c)));
    }),
  );

  app.get(
    "/v1/bundles/:id",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const ctx = await bundlesCore.getBundleContext(db, param(c, "id"));
      await bundlesCore.requireBundleReadAccess(db, userId, ctx);
      const itemTypes = (await itemTypesCore.listItemTypesUnchecked(db, ctx.bundle.id)).map(itemTypesCore.itemTypeView);
      const docs = (await bundleDocsCore.listDocsUnchecked(db, ctx.bundle.id)).map(bundleDocsCore.docInfoView);
      return c.json({ ...ctx.bundle, docs, itemTypes });
    }),
  );

  app.patch(
    "/v1/bundles/:id",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const body = parseBody(
        z.object({ name: z.string().optional(), description: z.string().optional() }),
        await jsonBody(c),
      );
      return c.json(await bundlesCore.updateBundle(db, userId, param(c, "id"), body));
    }),
  );

  app.delete(
    "/v1/bundles/:id",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      await bundlesCore.deleteBundle(db, userId, param(c, "id"), blob);
      return c.json({ deleted: true });
    }),
  );

  // ---- Docs ------------------------------------------------------------------

  app.post(
    "/v1/bundles/:id/docs",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const body = parseBody(
        z.object({ name: z.string(), content: z.string().optional(), autoload: z.boolean().optional() }),
        await jsonBody(c),
      );
      return c.json(await bundleDocsCore.createDoc(db, userId, param(c, "id"), body), 201);
    }),
  );

  app.get(
    "/v1/bundles/:id/docs",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      return c.json({ data: await bundleDocsCore.listDocs(db, userId, param(c, "id")) });
    }),
  );

  app.get(
    "/v1/bundles/:id/docs/:docRef",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      return c.json(await bundleDocsCore.getDoc(db, userId, param(c, "id"), param(c, "docRef")));
    }),
  );

  app.patch(
    "/v1/bundles/:id/docs/:docRef",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const body = parseBody(
        z.object({
          name: z.string().optional(),
          content: z.string().optional(),
          autoload: z.boolean().optional(),
          edits: z.array(editOpSchema).min(1).optional(),
        }),
        await jsonBody(c),
      );
      if (body.content !== undefined && body.edits !== undefined) {
        throw invalid("content and edits are mutually exclusive");
      }
      const bundleId = param(c, "id");
      const docRef = param(c, "docRef");
      if (body.edits !== undefined) {
        return c.json(await bundleDocsCore.patchDoc(db, userId, bundleId, docRef, body.edits as EditOp[]));
      }
      return c.json(
        await bundleDocsCore.updateDoc(db, userId, bundleId, docRef, {
          name: body.name,
          content: body.content,
          autoload: body.autoload,
        }),
      );
    }),
  );

  app.delete(
    "/v1/bundles/:id/docs/:docRef",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      await bundleDocsCore.deleteDoc(db, userId, param(c, "id"), param(c, "docRef"));
      return c.json({ deleted: true });
    }),
  );

  // ---- Item-types & properties -------------------------------------------------

  app.post(
    "/v1/bundles/:id/item-types",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const body = parseBody(
        z.object({ name: z.string(), properties: z.array(propertyInputSchema).optional() }),
        await jsonBody(c),
      );
      return c.json(itemTypesCore.itemTypeView(await itemTypesCore.createItemType(db, userId, param(c, "id"), body)), 201);
    }),
  );

  app.get(
    "/v1/bundles/:id/item-types",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      return c.json({ data: (await itemTypesCore.listItemTypes(db, userId, param(c, "id"))).map(itemTypesCore.itemTypeView) });
    }),
  );

  app.patch(
    "/v1/item-types/:id",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const body = parseBody(z.object({ name: z.string().optional() }), await jsonBody(c));
      await itemTypesCore.updateItemType(db, userId, param(c, "id"), body);
      return c.json({ updated: true });
    }),
  );

  app.delete(
    "/v1/item-types/:id",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      await itemTypesCore.deleteItemType(db, userId, param(c, "id"));
      return c.json({ deleted: true });
    }),
  );

  app.post(
    "/v1/item-types/:id/properties",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const body = parseBody(propertyInputSchema, await jsonBody(c));
      return c.json(itemTypesCore.propertyView(await itemTypesCore.addProperty(db, userId, param(c, "id"), body)), 201);
    }),
  );

  app.patch(
    "/v1/item-types/:id/properties/:propId",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const body = parseBody(
        z.object({
          name: z.string().optional(),
          required: z.boolean().optional(),
          multi: z.boolean().optional(),
          config: propertyConfigSchema.optional(),
          sortOrder: z.number().int().optional(),
        }),
        await jsonBody(c),
      );
      return c.json(
        itemTypesCore.propertyView(
          await itemTypesCore.updateProperty(db, userId, param(c, "id"), param(c, "propId"), body),
        ),
      );
    }),
  );

  app.delete(
    "/v1/item-types/:id/properties/:propId",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      await itemTypesCore.deleteProperty(db, userId, param(c, "id"), param(c, "propId"));
      return c.json({ deleted: true });
    }),
  );

  // ---- Items -------------------------------------------------------------------

  const filterSchema = z.object({
    property: z.string(),
    op: z.enum(itemsCore.FILTER_OPS),
    value: z.unknown(),
    quantifier: z.enum(itemsCore.QUANTIFIERS).optional(),
  });

  app.post(
    "/v1/bundles/:id/items",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const body = parseBody(
        z.object({ itemType: z.string(), items: z.array(z.record(z.string(), z.unknown())) }),
        await jsonBody(c),
      );
      return c.json({ data: await itemsCore.createItems(db, userId, param(c, "id"), body) }, 201);
    }),
  );

  app.get(
    "/v1/bundles/:id/items",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
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
        filters = parseBody(z.array(filterSchema), parsed) as itemsCore.ItemFilter[];
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
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const body = parseBody(
        z.object({
          set: z.record(z.string(), z.unknown()).optional(),
          edits: z.record(z.string(), z.array(editOpSchema).min(1)).optional(),
        }),
        await jsonBody(c),
      );
      if (Object.keys(body.set ?? {}).length === 0 && Object.keys(body.edits ?? {}).length === 0) throw invalid("at least one of set or edits is required");
      const itemId = param(c, "id");
      const bundleId = await itemsCore.getItemBundleId(db, itemId);
      const updated = await itemsCore.updateItems(db, userId, bundleId, [
        { id: itemId, set: body.set, edits: body.edits as Record<string, EditOp[]> | undefined },
      ]);
      return c.json(updated[0]);
    }),
  );

  app.delete(
    "/v1/items/:id",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const itemId = param(c, "id");
      const bundleId = await itemsCore.getItemBundleId(db, itemId);
      await itemsCore.deleteItems(db, userId, bundleId, [itemId]);
      return c.json({ deleted: true });
    }),
  );

  // ---- Files ----------------------------------------------------------------------

  app.get(
    "/v1/bundles/:id/files",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      return c.json({ data: await filesCore.listFiles(fileEnv, userId, param(c, "id")) });
    }),
  );

  app.post(
    "/v1/bundles/:id/files/upload-request",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const body = parseBody(
        z.object({ name: z.string(), mime_type: z.string().optional(), size: z.number().int().optional() }),
        await jsonBody(c),
      );
      return c.json(await filesCore.requestUpload(fileEnv, userId, param(c, "id"), body), 201);
    }),
  );

  app.post(
    "/v1/files/:id/complete",
    handle(async (c, auth) => {
      const fileId = param(c, "id");
      const raw = c.req.header("content-length") === "0" || c.req.header("content-length") === undefined
        ? {}
        : await jsonBody(c);
      const body = parseBody(
        z.object({ name: z.string().optional(), mime_type: z.string().optional() }),
        raw ?? {},
      );
      // Widget path: a signed completion token minted at upload_request time
      // (the requester held edit_files then) authorizes the finalize step.
      const token = c.req.query("token");
      if (token) {
        const payload = verifyToken(token, config.masterKey);
        if (!payload || payload.scope !== "upload-complete" || payload.fileId !== fileId) {
          throw new YapError("unauthorized", "invalid or expired completion token");
        }
        return c.json(await filesCore.completeUploadSigned(fileEnv, fileId, body));
      }
      const userId = requireUser(auth);
      return c.json(await filesCore.completeUpload(fileEnv, userId, fileId, body));
    }),
  );

  app.get(
    "/v1/files/:id/link",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      return c.json(await filesCore.mintDownloadLink(fileEnv, userId, param(c, "id")));
    }),
  );

  app.delete(
    "/v1/files/:id",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      await filesCore.deleteFile(fileEnv, userId, param(c, "id"));
      return c.json({ deleted: true });
    }),
  );

  // ---- Local-disk signed-token endpoints (the fs adapter's "presigning") ----------
  // Public routes gated solely by HMAC tokens minted after permission checks.

  function requireFileToken(c: Context, scope: string, fileId: string): void {
    const payload = verifyToken(c.req.query("token") ?? "", config.masterKey);
    if (!payload || payload.scope !== scope || payload.fileId !== fileId) {
      throw new YapError("unauthorized", `invalid or expired ${scope} token`);
    }
  }

  app.put(
    "/v1/files/:id/upload",
    handle(async (c) => {
      const fileId = param(c, "id");
      requireFileToken(c, "upload", fileId);
      parseContentLength(c, config.maxFileSizeBytes);
      const bytes = await readBoundedBody(c, config.maxFileSizeBytes);
      const { size } = await filesCore.storeUploadedBytes(fileEnv, fileId, bytes);
      return c.json({ uploaded: true, size });
    }),
  );

  app.get(
    "/v1/files/:id/download",
    handle(async (c) => {
      const fileId = param(c, "id");
      requireFileToken(c, "download", fileId);
      const { stream, name, mimeType, size } = await filesCore.openDownloadStream(fileEnv, fileId);
      c.header("content-type", mimeType || "application/octet-stream");
      c.header("content-length", String(size));
      // Default to inline so images/audio/video preview in place; ?download=1
      // forces an attachment so a Download action saves the file instead.
      const disposition = c.req.query("download") ? "attachment" : "inline";
      c.header("content-disposition", `${disposition}; filename="${headerSafeFilename(name)}"`);
      return c.body(Readable.toWeb(stream) as ReadableStream);
    }),
  );

  // ---- Hooks (authoring is REST-only — deliberately absent from MCP) --------------

  const hookEnv: hooksCore.HookEnv = { db, config };

  app.post(
    "/v1/bundles/:id/hooks",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const body = parseBody(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          params: z.array(hooksCore.hookParamSpecSchema).optional(),
          transport: hooksCore.hookTransportSchema,
        }),
        await jsonBody(c),
      );
      return c.json(await hooksCore.createHook(hookEnv, userId, param(c, "id"), body), 201);
    }),
  );

  app.get(
    "/v1/bundles/:id/hooks",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      return c.json({ data: await hooksCore.listHooks(db, userId, param(c, "id")) });
    }),
  );

  app.patch(
    "/v1/hooks/:id",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const body = parseBody(
        z.object({
          name: z.string().optional(),
          description: z.string().optional(),
          params: z.array(hooksCore.hookParamSpecSchema).optional(),
          transport: hooksCore.hookTransportSchema.optional(),
        }),
        await jsonBody(c),
      );
      return c.json(await hooksCore.updateHook(hookEnv, userId, param(c, "id"), body));
    }),
  );

  app.delete(
    "/v1/hooks/:id",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      await hooksCore.deleteHook(hookEnv, userId, param(c, "id"));
      return c.json({ deleted: true });
    }),
  );

  app.post(
    "/v1/hooks/:id/fire",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const rawText = await c.req.text();
      let rawBody: unknown = {};
      if (rawText) {
        try {
          rawBody = JSON.parse(rawText);
        } catch {
          throw invalid("request body must be valid JSON");
        }
      }
      const body = parseBody(z.object({ params: z.record(z.string(), z.unknown()).optional() }), rawBody);
      const hookId = param(c, "id");
      const bundleId = await hooksCore.getHookBundleId(db, hookId);
      return c.json(await hooksCore.fireHook(hookEnv, userId, bundleId, { hook: hookId, params: body.params }));
    }),
  );

  // ---- Origin-hosted widget pages (outside /v1; signed expiring tokens) -----------

  app.get(
    "/w/:widget",
    handle(async (c) => {
      const html = await buildOriginPage(
        { db, blob, config },
        param(c, "widget"),
        c.req.query("token") ?? "",
      );
      return c.html(html);
    }),
  );

  // ---- User docs ----------------------------------------------------------------

  app.post(
    "/v1/user-docs",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const body = parseBody(
        z.object({ name: z.string(), content: z.string().optional(), autoload: z.boolean().optional() }),
        await jsonBody(c),
      );
      return c.json(await userDocsCore.createUserDoc(db, userId, body), 201);
    }),
  );

  app.get(
    "/v1/user-docs",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      return c.json({ data: await userDocsCore.listUserDocs(db, userId) });
    }),
  );

  app.get(
    "/v1/user-docs/:id",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      return c.json(await userDocsCore.getUserDoc(db, userId, param(c, "id")));
    }),
  );

  app.patch(
    "/v1/user-docs/:id",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      const body = parseBody(
        z.object({
          name: z.string().optional(),
          content: z.string().optional(),
          autoload: z.boolean().optional(),
          edits: z.array(editOpSchema).min(1).optional(),
        }),
        await jsonBody(c),
      );
      if (body.content !== undefined && body.edits !== undefined) {
        throw invalid("content and edits are mutually exclusive");
      }
      if (body.edits !== undefined) {
        return c.json(await userDocsCore.patchUserDoc(db, userId, param(c, "id"), body.edits as EditOp[]));
      }
      return c.json(
        await userDocsCore.updateUserDoc(db, userId, param(c, "id"), {
          name: body.name,
          content: body.content,
          autoload: body.autoload,
        }),
      );
    }),
  );

  app.delete(
    "/v1/user-docs/:id",
    handle(async (c, auth) => {
      const userId = requireUser(auth);
      await userDocsCore.deleteUserDoc(db, userId, param(c, "id"));
      return c.json({ deleted: true });
    }),
  );

}
