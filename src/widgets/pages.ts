/**
 * Origin-hosted widget pages: the same self-contained widget HTML served by
 * the Yap installation at signed, expiring URLs — the universal fallback for
 * hosts that can't render widgets inline. Single-purpose, permission-gated
 * pages, never a navigable frontend. Data is built fresh at serve time
 * (links minted with the same discipline as file links); effects land
 * directly in the system since there is no event channel.
 */
import { eq } from "drizzle-orm";

import type { BlobStore } from "../blob/index.js";
import type { YapConfig } from "../config.js";
import { signToken, verifyToken } from "../crypto.js";
import { fileKind } from "../core/files.js";
import { YapError, invalid, unauthorized } from "../core/errors.js";
import type { Db } from "../db/index.js";
import { WIDGETS, widgetHtml } from "./registry.js";

export interface PagesEnv {
  db: Db;
  blob: BlobStore;
  config: YapConfig;
}

export async function buildOriginPage(env: PagesEnv, widgetName: string, token: string): Promise<string> {
  const { db, blob, config } = env;
  const def = WIDGETS[widgetName];
  if (!def) throw new YapError("not_found", `unknown widget ${widgetName}`);
  if (!def.originHostable) throw invalid(`widget ${widgetName} cannot be origin-hosted`);

  const payload = verifyToken(token, config.masterKey);
  if (!payload || payload.scope !== "widget" || payload.widget !== widgetName) {
    throw unauthorized("invalid or expired widget token");
  }

  const { files } = db.tables;

  if (widgetName === "upload-dropzone") {
    const fileId = String(payload.fileId ?? "");
    const rows = await db.client.select().from(files).where(eq(files.id, fileId));
    const file = rows[0];
    if (!file || file.status !== "reserved" || file.uploadConsumed) {
      throw new YapError("conflict", "this upload is no longer open");
    }
    const uploadUrl = await blob.uploadUrl(file.storageKey, fileId, config.uploadTtlSeconds);
    const completeToken = signToken({ scope: "upload-complete", fileId }, config.masterKey, config.uploadTtlSeconds);
    return widgetHtml(widgetName, "origin", {
      file_id: fileId,
      name: file.name,
      upload_url: uploadUrl,
      complete_url: `${config.baseUrl}/v1/files/${fileId}/complete?token=${completeToken}`,
    });
  }

  if (widgetName === "media-card") {
    const fileId = String(payload.fileId ?? "");
    const rows = await db.client.select().from(files).where(eq(files.id, fileId));
    const file = rows[0];
    if (!file || file.status !== "finalized") throw new YapError("not_found", `file ${fileId} not found`);
    const url = await blob.downloadUrl(file.storageKey, config.downloadTtlSeconds, {
      fileId: file.id,
      name: file.name,
      mimeType: file.mimeType,
    });
    return widgetHtml(widgetName, "origin", {
      kind: fileKind(file.mimeType),
      url,
      name: file.name,
      mime_type: file.mimeType,
      size: file.size,
      expires_in: config.downloadTtlSeconds,
    });
  }

  throw invalid(`widget ${widgetName} has no origin data builder`);
}
