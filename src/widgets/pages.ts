/**
 * Origin-hosted widget pages: the same self-contained widget HTML served by
 * the Yap installation at signed, expiring URLs — the universal fallback for
 * hosts that can't render widgets inline. Single-purpose, permission-gated
 * pages, never a navigable frontend. Data is built fresh at serve time
 * (links minted with the same discipline as file links); effects land
 * directly in the system since there is no event channel.
 */
import type { BlobStore } from "../blob/index.js";
import type { YapConfig } from "../config.js";
import { verifyToken } from "../crypto.js";
import { uploadPageData, viewPageData } from "../core/files.js";
import { YapError, invalid, unauthorized } from "../core/errors.js";
import type { Db } from "../db/index.js";
import { WIDGETS, widgetHtml } from "./registry.js";

export interface PagesEnv {
  db: Db;
  blob: BlobStore;
  config: YapConfig;
}

export async function buildOriginPage(env: PagesEnv, widgetName: string, token: string): Promise<string> {
  const { config } = env;
  const def = WIDGETS[widgetName];
  if (!def) throw new YapError("not_found", `unknown widget ${widgetName}`);
  if (!def.originHostable) throw invalid(`widget ${widgetName} cannot be origin-hosted`);

  const payload = verifyToken(token, config.masterKey);
  if (!payload || payload.scope !== "widget" || payload.widget !== widgetName) {
    throw unauthorized("invalid or expired widget token");
  }
  const fileId = String(payload.fileId ?? "");

  if (widgetName === "upload-dropzone") {
    return widgetHtml(widgetName, "origin", await uploadPageData(env, fileId));
  }
  if (widgetName === "media-card") {
    return widgetHtml(widgetName, "origin", await viewPageData(env, fileId));
  }
  throw invalid(`widget ${widgetName} has no origin data builder`);
}
