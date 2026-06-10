/**
 * The file lifecycle. Bytes live in the blob store and never pass through the
 * agent; the platform brokers links, not bytes.
 *
 * Upload is three-phase so bytes go direct-to-storage:
 *   request  → reserved placeholder record + short-lived single-use upload link
 *   upload   → bytes to the link (human via widget, or headless)
 *   complete → finalize with size read authoritatively from storage
 *
 * Download is mint-on-demand: every fetch re-checks read_files and mints a
 * fresh expiring link. Deleting a file record deletes the blob immediately.
 * An orphan sweep removes reserved placeholders whose upload never completed.
 */
import { and, asc, eq, lt } from "drizzle-orm";

import type { BlobStore } from "../blob/index.js";
import type { YapConfig } from "../config.js";
import { signToken } from "../crypto.js";
import type { Db } from "../db/index.js";
import { bundleCapabilityCtx, getBundleContext } from "./bundles.js";
import { requireCapability } from "./capabilities.js";
import { YapError, invalid, notFound } from "./errors.js";
import { newId, nowIso } from "./util.js";

export interface FileInfo {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  status: string;
  createdAt: string;
}

export interface FileEnv {
  db: Db;
  blob: BlobStore;
  config: YapConfig;
}

/** Finalized files in a bundle (reserved placeholders are internal). */
export async function listFilesUnchecked(db: Db, bundleId: string): Promise<FileInfo[]> {
  const { files } = db.tables;
  return db.client
    .select({
      id: files.id,
      name: files.name,
      mimeType: files.mimeType,
      size: files.size,
      status: files.status,
      createdAt: files.createdAt,
    })
    .from(files)
    .where(and(eq(files.bundleId, bundleId), eq(files.status, "finalized")))
    .orderBy(asc(files.createdAt), asc(files.id));
}

export async function listFiles(env: FileEnv, userId: string, bundleId: string): Promise<FileInfo[]> {
  const ctx = await getBundleContext(env.db, bundleId);
  await requireCapability(env.db, userId, "read_files", bundleCapabilityCtx(ctx));
  return listFilesUnchecked(env.db, bundleId);
}

export function mimeAllowed(config: YapConfig, mimeType: string): boolean {
  if (config.mimeAllowlist === "*") return true;
  return config.mimeAllowlist.some(
    (allowed) => allowed === mimeType || (allowed.endsWith("/*") && mimeType.startsWith(allowed.slice(0, -1))),
  );
}

/**
 * Validates a file name and returns the trimmed value. Rejects control
 * characters (incl. CR/LF, which would inject into the Content-Disposition
 * header when the file is downloaded) and path separators.
 */
export function cleanFileName(raw: string | undefined): string {
  const name = (raw ?? "").trim();
  if (!name) throw invalid("file name is required");
  if (/[\u0000-\u001f\u007f]/.test(name)) throw invalid("file name must not contain control characters");
  if (name.includes("/") || name.includes("\\")) throw invalid("file name must not contain path separators");
  if (name.length > 255) throw invalid("file name is too long (max 255 characters)");
  return name;
}

export interface UploadRequestResult {
  file_id: string;
  /** Short-lived, single-use direct-to-storage upload link. */
  upload_url: string;
  upload_url_expires_in: number;
  /** Signed finalize endpoint used by the upload widget (no event channel needed). */
  complete_url: string;
  /** Origin-hosted upload page for hosts that cannot render widgets. */
  origin_upload_url: string;
  status: "reserved";
}

export async function requestUpload(
  env: FileEnv,
  userId: string,
  bundleId: string,
  input: { name: string; mime_type?: string; size?: number },
): Promise<UploadRequestResult> {
  const { db, blob, config } = env;
  const ctx = await getBundleContext(db, bundleId);
  await requireCapability(db, userId, "edit_files", bundleCapabilityCtx(ctx));

  const name = cleanFileName(input.name);
  const declaredMime = input.mime_type ?? "";
  if (declaredMime && !mimeAllowed(config, declaredMime)) {
    throw invalid(`MIME type ${declaredMime} is not allowed`, { allowed: config.mimeAllowlist });
  }
  if (input.size !== undefined && input.size > config.maxFileSizeBytes) {
    throw invalid(`file exceeds the maximum size of ${config.maxFileSizeBytes} bytes`);
  }

  const { files } = db.tables;
  const fileId = newId();
  const storageKey = `${ctx.space.id}/${bundleId}/${fileId}`;
  await db.client.insert(files).values({
    id: fileId,
    bundleId,
    spaceId: ctx.space.id,
    ownerId: userId,
    status: "reserved",
    name,
    mimeType: declaredMime,
    size: 0,
    storageKey,
    uploadConsumed: 0,
    createdAt: nowIso(),
    finalizedAt: null,
  });

  const uploadUrl = await blob.uploadUrl(storageKey, fileId, config.uploadTtlSeconds);
  const completeToken = signToken({ scope: "upload-complete", fileId }, config.masterKey, config.uploadTtlSeconds);
  const originToken = signToken(
    { scope: "widget", widget: "upload-dropzone", fileId },
    config.masterKey,
    config.widgetTokenTtlSeconds,
  );
  return {
    file_id: fileId,
    upload_url: uploadUrl,
    upload_url_expires_in: config.uploadTtlSeconds,
    complete_url: `${config.baseUrl}/v1/files/${fileId}/complete?token=${completeToken}`,
    origin_upload_url: `${config.baseUrl}/w/upload-dropzone?token=${originToken}`,
    status: "reserved",
  };
}

async function getFileRow(db: Db, fileId: string) {
  const { files } = db.tables;
  const rows = await db.client.select().from(files).where(eq(files.id, fileId));
  if (rows.length === 0) throw notFound("file", fileId);
  return rows[0]!;
}

/**
 * Finalize: the placeholder becomes a usable file. Size is read from storage,
 * never trusted from the client.
 */
export async function completeUpload(
  env: FileEnv,
  userId: string,
  fileId: string,
  patch: { name?: string; mime_type?: string } = {},
): Promise<FileInfo> {
  const { db } = env;
  const file = await getFileRow(db, fileId);
  const ctx = await getBundleContext(db, file.bundleId);
  await requireCapability(db, userId, "edit_files", bundleCapabilityCtx(ctx));
  return finalizeUpload(env, fileId, patch);
}

/**
 * Token-authorized finalize: used by the upload widget, whose signed
 * complete_url was minted for someone holding edit_files at request time.
 */
export async function completeUploadSigned(
  env: FileEnv,
  fileId: string,
  patch: { name?: string; mime_type?: string } = {},
): Promise<FileInfo> {
  return finalizeUpload(env, fileId, patch);
}

async function finalizeUpload(
  env: FileEnv,
  fileId: string,
  patch: { name?: string; mime_type?: string },
): Promise<FileInfo> {
  const { db, blob, config } = env;
  const file = await getFileRow(db, fileId);
  if (file.status !== "reserved") throw new YapError("conflict", `file ${fileId} is already finalized`);

  const stat = await blob.stat(file.storageKey);
  if (!stat) throw invalid("no uploaded bytes found for this file — upload before completing");
  if (stat.size > config.maxFileSizeBytes) {
    await blob.delete(file.storageKey);
    throw invalid(`uploaded file exceeds the maximum size of ${config.maxFileSizeBytes} bytes`);
  }
  const mimeType = patch.mime_type ?? file.mimeType ?? "";
  if (mimeType && !mimeAllowed(config, mimeType)) {
    await blob.delete(file.storageKey);
    throw invalid(`MIME type ${mimeType} is not allowed`, { allowed: config.mimeAllowlist });
  }

  const { files } = db.tables;
  const finalName = patch.name !== undefined ? cleanFileName(patch.name) : file.name;
  await db.client
    .update(files)
    .set({
      status: "finalized",
      name: finalName,
      mimeType,
      size: stat.size,
      finalizedAt: nowIso(),
    })
    .where(eq(files.id, fileId));
  const updated = await getFileRow(db, fileId);
  return {
    id: updated.id,
    name: updated.name,
    mimeType: updated.mimeType,
    size: updated.size,
    status: updated.status,
    createdAt: updated.createdAt,
  };
}

export interface MintedLink {
  url: string;
  expires_in: number;
  name: string;
  mime_type: string;
  size: number;
}

/** Mints a fresh expiring link after re-confirming read_files. Every time. */
export async function mintDownloadLink(env: FileEnv, userId: string, fileId: string): Promise<MintedLink> {
  const { db, blob, config } = env;
  const file = await getFileRow(db, fileId);
  const ctx = await getBundleContext(db, file.bundleId);
  await requireCapability(db, userId, "read_files", bundleCapabilityCtx(ctx));
  if (file.status !== "finalized") throw notFound("file", fileId);
  const url = await blob.downloadUrl(file.storageKey, config.downloadTtlSeconds, {
    fileId: file.id,
    name: file.name,
    mimeType: file.mimeType,
  });
  return {
    url,
    expires_in: config.downloadTtlSeconds,
    name: file.name,
    mime_type: file.mimeType,
    size: file.size,
  };
}

/** Deletes the file record and the underlying blob immediately. */
export async function deleteFile(env: FileEnv, userId: string, fileId: string): Promise<void> {
  const { db, blob } = env;
  const file = await getFileRow(db, fileId);
  const ctx = await getBundleContext(db, file.bundleId);
  await requireCapability(db, userId, "edit_files", bundleCapabilityCtx(ctx));
  await blob.delete(file.storageKey);
  const { files } = db.tables;
  await db.client.delete(files).where(eq(files.id, fileId));
}

export type ShowFileKind = "image" | "audio" | "video" | "file";

export function fileKind(mimeType: string): ShowFileKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
}

export interface ShowFileResult {
  kind: ShowFileKind;
  url: string;
  expires_in?: number;
  name?: string;
  mime_type?: string;
  size?: number;
  /** Origin-hosted media-card page (signed, expiring) for non-rendering hosts. */
  origin_view_url?: string;
}

/**
 * show_file: accepts a stored file://{uuid} reference or a direct URL. Stored
 * files get a fresh expiring link (read_files re-checked); the durable
 * location is never exposed.
 */
export async function showFile(env: FileEnv, userId: string, ref: string): Promise<ShowFileResult> {
  if (ref.startsWith("file://")) {
    const fileId = ref.slice("file://".length);
    const minted = await mintDownloadLink(env, userId, fileId);
    const viewToken = signToken(
      { scope: "widget", widget: "media-card", fileId },
      env.config.masterKey,
      env.config.widgetTokenTtlSeconds,
    );
    return {
      kind: fileKind(minted.mime_type),
      url: minted.url,
      expires_in: minted.expires_in,
      name: minted.name,
      mime_type: minted.mime_type,
      size: minted.size,
      origin_view_url: `${env.config.baseUrl}/w/media-card?token=${viewToken}`,
    };
  }
  if (/^https?:\/\//.test(ref)) {
    return { kind: "file", url: ref };
  }
  throw invalid(`show_file expects a file://{uuid} reference or an http(s) URL, got ${JSON.stringify(ref)}`);
}

/** Data builders for origin-hosted widget pages (token-authorized; the
 * transport verifies the signed token, these enforce the state rules). */
export async function uploadPageData(
  env: FileEnv,
  fileId: string,
): Promise<{ file_id: string; name: string; upload_url: string; complete_url: string }> {
  const { db, blob, config } = env;
  const file = await getFileRow(db, fileId);
  if (file.status !== "reserved" || file.uploadConsumed) {
    throw new YapError("conflict", "this upload is no longer open");
  }
  const uploadUrl = await blob.uploadUrl(file.storageKey, fileId, config.uploadTtlSeconds);
  const completeToken = signToken({ scope: "upload-complete", fileId }, config.masterKey, config.uploadTtlSeconds);
  return {
    file_id: fileId,
    name: file.name,
    upload_url: uploadUrl,
    complete_url: `${config.baseUrl}/v1/files/${fileId}/complete?token=${completeToken}`,
  };
}

export async function viewPageData(env: FileEnv, fileId: string): Promise<ShowFileResult> {
  const { db, blob, config } = env;
  const file = await getFileRow(db, fileId);
  if (file.status !== "finalized") throw notFound("file", fileId);
  const url = await blob.downloadUrl(file.storageKey, config.downloadTtlSeconds, {
    fileId: file.id,
    name: file.name,
    mimeType: file.mimeType,
  });
  return {
    kind: fileKind(file.mimeType),
    url,
    name: file.name,
    mime_type: file.mimeType,
    size: file.size,
    expires_in: config.downloadTtlSeconds,
  };
}

/**
 * Token-side byte handling for the local-disk adapter's app-served endpoints.
 * Token verification is the transport's job; the state rules live here.
 */
export async function storeUploadedBytes(
  env: FileEnv,
  fileId: string,
  bytes: Uint8Array,
): Promise<{ size: number }> {
  const { db, blob, config } = env;
  if (bytes.byteLength > config.maxFileSizeBytes) {
    throw invalid(`file exceeds the maximum size of ${config.maxFileSizeBytes} bytes`);
  }
  const file = await getFileRow(db, fileId);
  const { files } = db.tables;
  // Atomically claim the single-use slot before writing bytes: a conditional
  // UPDATE that only one concurrent request can win. (returning() is portable
  // across both adapters and lets us count the affected row.)
  const claimed = await db.client
    .update(files)
    .set({ uploadConsumed: 1 })
    .where(and(eq(files.id, fileId), eq(files.status, "reserved"), eq(files.uploadConsumed, 0)))
    .returning({ id: files.id });
  if (claimed.length === 0) {
    throw new YapError(
      "conflict",
      file.status !== "reserved"
        ? "this upload is no longer open"
        : "this upload link was already used (single-use)",
    );
  }
  await blob.put(file.storageKey, bytes);
  return { size: bytes.byteLength };
}

export async function openDownloadStream(
  env: FileEnv,
  fileId: string,
): Promise<{ stream: Awaited<ReturnType<BlobStore["getStream"]>>; name: string; mimeType: string; size: number }> {
  const { db, blob } = env;
  const file = await getFileRow(db, fileId);
  if (file.status !== "finalized") throw notFound("file", fileId);
  return {
    stream: await blob.getStream(file.storageKey),
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
  };
}

/**
 * Removes reserved placeholder records older than the cutoff whose upload
 * never landed. A reserved record that already has bytes — flagged by
 * uploadConsumed (local-disk path) or detectable via blob.stat (direct-to-
 * storage adapters that bypass storeUploadedBytes) — is awaiting finalize,
 * not an orphan, and is never destroyed: doing so would silently delete a
 * successfully-uploaded file.
 */
export async function sweepOrphans(env: FileEnv, olderThanMs: number, nowMs: number = Date.now()): Promise<number> {
  const { db, blob } = env;
  const { files } = db.tables;
  const cutoff = new Date(nowMs - olderThanMs).toISOString();
  const candidates = await db.client
    .select()
    .from(files)
    .where(and(eq(files.status, "reserved"), lt(files.createdAt, cutoff)));
  let removed = 0;
  for (const orphan of candidates) {
    if (orphan.uploadConsumed) continue; // bytes uploaded, finalize still pending
    if (await blob.stat(orphan.storageKey)) continue; // bytes present via a direct upload
    await blob.delete(orphan.storageKey); // FlyDrive delete ignores missing keys
    await db.client.delete(files).where(eq(files.id, orphan.id));
    removed++;
  }
  return removed;
}
