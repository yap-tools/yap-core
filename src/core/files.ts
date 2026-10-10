/**
 * The file lifecycle. Bytes live in the blob store and never pass through the
 * agent; the platform brokers links, not bytes.
 *
 * Upload is three-phase so bytes go direct-to-storage:
 *   request  → reserved placeholder record + short-lived single-use upload link
 *   upload   → bytes to the link (human via widget, or headless)
 *   complete → finalize with size read authoritatively from storage
 *
 * Sideloading is the one-call alternative for an agent holding a URL: the
 * server fetches the bytes itself, through the guarded egress layer, and writes
 * the file finalized — no placeholder, nothing left behind on failure.
 *
 * Download is mint-on-demand: every fetch re-checks read_files and mints a
 * fresh expiring link. Deleting a file record deletes the blob immediately.
 * An orphan sweep removes reserved placeholders whose upload never completed.
 */
import { once } from "node:events";
import { PassThrough, Readable } from "node:stream";

import { and, asc, eq, lt } from "drizzle-orm";

import type { BlobStore } from "../blob/index.js";
import type { YapConfig } from "../config.js";
import { signToken } from "../crypto.js";
import type { Db } from "../db/index.js";
import type { YapLogger } from "../logger.js";
import { getBundleContext, requireBundleCapability } from "./bundles.js";
import { createEgress, type Egress, type EgressResponse } from "./drivers/egress.js";
import {
  YapError,
  badGateway,
  forbidden,
  gatewayTimeout,
  invalid,
  notFound,
  tooLarge,
  unsupportedMediaType,
} from "./errors.js";
import { SSRF_PIN_ERROR_CODE, type Resolver } from "./ssrf.js";
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
  /** Operator-side sink for the detail a sideload failure hides from the caller. */
  logger?: YapLogger;
  /** Injectable for tests, as on RunEnv: what a sideload's egress resolves and fetches with. */
  resolver?: Resolver;
  fetchImpl?: typeof fetch;
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
  await requireBundleCapability(env.db, userId, "read_files", ctx);
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

/** Exactly one of `bytes` and `stream`. A stream is stored as it is read, so
 * a large file never sits whole in the server's memory. */
export interface FileWriteInput {
  name: string;
  mimeType?: string;
  bytes?: Uint8Array | string;
  stream?: Readable;
}

export type WrittenFileInfo = FileInfo & { ref: string };

class StreamTooLarge extends Error {}

/**
 * Stream into the blob store, counting as it goes; the size of a stream is
 * only known once it has been read, so the cap is enforced mid-flight. The
 * caller removes the partial blob on any rejection.
 *
 * The store is never handed an erroring stream. A store adapter may reject the
 * moment its input errors while its own write is still in flight, and a delete
 * issued then races a write that recreates the blob. So a failed or oversized
 * source simply ends the store's input early: the store finishes a truncated
 * write, and only then is the failure reported.
 */
async function putBounded(blob: BlobStore, key: string, source: Readable, maxBytes: number): Promise<number> {
  let size = 0;
  let failure: unknown = null;
  const sink = new PassThrough();
  const storing = blob.putStream(key, sink);
  // A store that gives up stops draining the sink; nothing must wait on it then.
  const storeDone = new AbortController();
  void storing.then(
    () => storeDone.abort(),
    () => storeDone.abort(),
  );

  const feeding = (async () => {
    try {
      for await (const chunk of source) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array);
        size += bytes.byteLength;
        if (size > maxBytes) {
          failure = new StreamTooLarge();
          return;
        }
        if (storeDone.signal.aborted || sink.destroyed) return;
        if (!sink.write(bytes)) await once(sink, "drain", { signal: storeDone.signal });
      }
    } catch (err) {
      if (!storeDone.signal.aborted) failure = err ?? new Error("the file stream failed");
    } finally {
      source.destroy();
      sink.end();
    }
  })();

  const [stored] = await Promise.allSettled([storing, feeding]);
  if (failure) throw failure;
  if (stored.status === "rejected") throw stored.reason;
  return size;
}

/**
 * Internal: write a finalized file without the edit_files capability check.
 * Service drivers use this through their bundle-scoped writer; name, MIME,
 * size, storage, and finalized-row semantics match the normal file layer.
 */
export async function writeFileUnchecked(
  env: FileEnv,
  ownerId: string,
  bundleId: string,
  input: FileWriteInput,
): Promise<WrittenFileInfo> {
  const { db, blob, config } = env;
  const ctx = await getBundleContext(db, bundleId);
  const name = cleanFileName(input.name);
  const mimeType = input.mimeType ?? "";
  if (mimeType && !mimeAllowed(config, mimeType)) {
    throw unsupportedMediaType(`MIME type ${mimeType} is not allowed`, { allowed: config.mimeAllowlist });
  }
  if (input.stream !== undefined && input.bytes !== undefined) {
    throw invalid("pass file bytes or a stream, not both");
  }
  if (input.stream !== undefined && !(input.stream instanceof Readable)) {
    throw invalid("file stream must be a Readable");
  }
  if (input.stream === undefined && typeof input.bytes !== "string" && !(input.bytes instanceof Uint8Array)) {
    throw invalid("file bytes must be a string or Uint8Array");
  }
  const tooBig = () => tooLarge(`file exceeds the maximum size of ${config.maxFileSizeBytes} bytes`);

  const { files } = db.tables;
  const fileId = newId();
  const storageKey = `${ctx.space.id}/${bundleId}/${fileId}`;
  let size: number;
  if (input.stream) {
    try {
      size = await putBounded(blob, storageKey, input.stream, config.maxFileSizeBytes);
    } catch (err) {
      await blob.delete(storageKey).catch(() => {});
      throw err instanceof StreamTooLarge ? tooBig() : err;
    }
  } else {
    const bytes = typeof input.bytes === "string" ? Buffer.from(input.bytes) : input.bytes!;
    if (bytes.byteLength > config.maxFileSizeBytes) throw tooBig();
    await blob.put(storageKey, bytes);
    size = bytes.byteLength;
  }
  try {
    const now = nowIso();
    await db.client.insert(files).values({
      id: fileId,
      bundleId,
      spaceId: ctx.space.id,
      ownerId,
      status: "finalized",
      name,
      mimeType,
      size,
      storageKey,
      uploadConsumed: 1,
      createdAt: now,
      finalizedAt: now,
    });
  } catch (err) {
    await blob.delete(storageKey).catch(() => {});
    throw err;
  }

  return {
    id: fileId,
    ref: `file://${fileId}`,
    name,
    mimeType,
    size,
    status: "finalized",
    createdAt: (await getFileRow(db, fileId)).createdAt,
  };
}

export async function requestUpload(
  env: FileEnv,
  userId: string,
  bundleId: string,
  input: { name: string; mime_type?: string; size?: number },
): Promise<UploadRequestResult> {
  const { db, blob, config } = env;
  const ctx = await getBundleContext(db, bundleId);
  await requireBundleCapability(db, userId, "edit_files", ctx);

  const name = cleanFileName(input.name);
  const declaredMime = input.mime_type ?? "";
  if (declaredMime && !mimeAllowed(config, declaredMime)) {
    throw unsupportedMediaType(`MIME type ${declaredMime} is not allowed`, { allowed: config.mimeAllowlist });
  }
  if (input.size !== undefined && input.size > config.maxFileSizeBytes) {
    throw tooLarge(`file exceeds the maximum size of ${config.maxFileSizeBytes} bytes`);
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

/** How many redirects a sideload follows before giving up. */
export const MAX_SIDELOAD_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

class SideloadTimeout extends Error {}
class SideloadTransferFailed extends Error {}

/** Settles with `work`, or rejects the moment the budget runs out — whatever
 * `work` is waiting on (a resolver, a transport that ignores its signal). */
function withinBudget<T>(work: Promise<T>, budget: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const expire = (): void => reject(new SideloadTimeout());
    if (budget.aborted) {
      work.catch(() => {});
      return expire();
    }
    budget.addEventListener("abort", expire, { once: true });
    work.then(resolve, reject).finally(() => budget.removeEventListener("abort", expire));
  });
}

/** A sideload URL: http(s) only, and nothing but a location — credentials in
 * the URL would be a header the caller is not allowed to send. */
function sideloadUrl(raw: string, base?: URL): URL | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url;
}

/**
 * One guarded GET. Whatever goes wrong below the HTTP status is collapsed
 * before it reaches the caller, as the http driver does: a guard rejection and
 * a transport failure each become one generic message, so the tool cannot be
 * used to map an instance's internal network. The detail goes to the server
 * log, with the host only — a URL's path and query can carry signed tokens.
 */
async function sideloadGet(egress: Egress, url: URL, budget: AbortSignal, logger?: YapLogger): Promise<EgressResponse> {
  try {
    return await withinBudget(egress.fetch(url.href, { method: "GET", signal: budget, redirect: "manual" }), budget);
  } catch (err) {
    if (err instanceof SideloadTimeout || budget.aborted) throw new SideloadTimeout();
    const cause = (err as { cause?: { code?: string } }).cause;
    const pinBlocked = cause?.code === SSRF_PIN_ERROR_CODE || (err as { code?: string }).code === SSRF_PIN_ERROR_CODE;
    // A YapError here can only be the egress pre-flight refusing the destination.
    if (pinBlocked || err instanceof YapError) {
      logger?.warn(`sideload from ${url.host} refused: ${String(err)}`);
      throw forbidden("the URL cannot be fetched: its host does not resolve or is blocked by this instance's network policy");
    }
    logger?.warn(`sideload from ${url.host} failed: ${String(err)}${cause !== undefined ? ` (cause: ${String(cause)})` : ""}`);
    throw badGateway("the URL could not be reached");
  }
}

/** Follows redirects by hand so every hop goes back through the guard. */
async function sideloadFetch(
  egress: Egress,
  start: URL,
  budget: AbortSignal,
  logger?: YapLogger,
): Promise<{ response: EgressResponse; url: URL }> {
  let url = start;
  for (let hops = 0; ; hops++) {
    const response = await sideloadGet(egress, url, budget, logger);
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
    if (location === null) return { response, url };
    void response.body?.cancel().catch(() => {});
    if (hops === MAX_SIDELOAD_REDIRECTS) {
      throw badGateway(`the URL redirected more than ${MAX_SIDELOAD_REDIRECTS} times`);
    }
    const next = sideloadUrl(location, url);
    if (!next) throw badGateway("the URL redirected to a location that is not a plain http(s) URL");
    url = next;
  }
}

/** The file name a Content-Disposition header proposes, if it proposes one. */
function dispositionFileName(header: string | null): string | undefined {
  if (!header) return undefined;
  const extended = /(?:^|;)\s*filename\*\s*=\s*([^';\s]*)'[^';]*'([^;]*)/i.exec(header);
  if (extended && /^utf-?8$/i.test(extended[1]!)) {
    try {
      return decodeURIComponent(extended[2]!.trim());
    } catch {
      // malformed encoding: fall through to the plain parameter
    }
  }
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i.exec(header);
  if (!plain) return undefined;
  return plain[1] !== undefined ? plain[1].replace(/\\(.)/g, "$1") : plain[2]!.trim();
}

/** Bends a name the remote end proposed into one `cleanFileName` accepts, or
 * gives up on it. Only the last path segment counts, as in a browser. */
function derivedFileName(raw: string | undefined): string | undefined {
  const name = (raw ?? "")
    .split(/[/\\]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 255)
    .trim();
  return name || undefined;
}

function urlFileName(url: URL): string | undefined {
  const segment = url.pathname.split("/").pop() ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The response body as a stream the file writer can bound. Each read races
 * the budget, so a body that stalls fails the write instead of holding it. */
function sideloadBody(body: ReadableStream<Uint8Array> | null, budget: AbortSignal): Readable {
  if (!body) return Readable.from([]);
  return Readable.from(
    (async function* () {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await withinBudget(reader.read(), budget);
          if (done) return;
          yield value;
        }
      } catch (err) {
        throw err instanceof SideloadTimeout || budget.aborted ? new SideloadTimeout() : new SideloadTransferFailed();
      } finally {
        void reader.cancel().catch(() => {});
      }
    })(),
    { objectMode: false },
  );
}

/**
 * Sideload: fetch a caller-supplied URL server-side and store it as a
 * finalized file, in one synchronous call. The caller supplies a location and
 * nothing else — it is a GET with no credentials and no headers of theirs —
 * and every request, redirect hops included, goes through the guarded egress.
 * The source URL is not kept anywhere.
 */
export async function sideloadFile(
  env: FileEnv,
  userId: string,
  bundleId: string,
  input: { url: string; name?: string; mime_type?: string },
): Promise<FileInfo> {
  const { db, config } = env;
  if (!config.sideloadEnabled) throw forbidden("sideloading is disabled on this instance");
  const ctx = await getBundleContext(db, bundleId);
  await requireBundleCapability(db, userId, "edit_files", ctx);

  const start = sideloadUrl(input.url);
  if (!start) throw invalid("url must be an absolute http(s) URL without embedded credentials");
  const givenName = input.name !== undefined ? cleanFileName(input.name) : undefined;
  const disallowed = (mimeType: string) =>
    unsupportedMediaType(`MIME type ${mimeType} is not allowed`, { allowed: config.mimeAllowlist });
  if (input.mime_type && !mimeAllowed(config, input.mime_type)) throw disallowed(input.mime_type);

  const egress = createEgress(config, env.resolver, env.fetchImpl);
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), config.sideloadTimeoutMs);
  let response: EgressResponse | undefined;
  let stream: Readable | undefined;
  try {
    const fetched = await sideloadFetch(egress, start, budget.signal, env.logger);
    response = fetched.response;
    if (response.status < 200 || response.status >= 300) {
      throw badGateway(`the URL answered with HTTP ${response.status}`);
    }
    const mimeType =
      input.mime_type || (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (mimeType && !mimeAllowed(config, mimeType)) throw disallowed(mimeType);
    const declaredSize = Number(response.headers.get("content-length") ?? NaN);
    if (declaredSize > config.maxFileSizeBytes) {
      throw tooLarge(`file exceeds the maximum size of ${config.maxFileSizeBytes} bytes`);
    }
    const name =
      givenName ??
      derivedFileName(dispositionFileName(response.headers.get("content-disposition"))) ??
      derivedFileName(urlFileName(fetched.url)) ??
      "download";

    stream = sideloadBody(response.body, budget.signal);
    const { ref: _ref, ...file } = await writeFileUnchecked(env, userId, bundleId, { name, mimeType, stream });
    return file;
  } catch (err) {
    if (err instanceof SideloadTimeout) {
      throw gatewayTimeout(`the URL did not finish downloading within ${config.sideloadTimeoutMs} ms`);
    }
    if (err instanceof SideloadTransferFailed) throw badGateway("the download broke off before it completed");
    throw err;
  } finally {
    clearTimeout(timer);
    // An unread body (a refusal, or a write that never started) must not hold its connection.
    stream?.destroy();
    void response?.body?.cancel().catch(() => {});
    await egress.dispose().catch(() => {});
  }
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
  await requireBundleCapability(db, userId, "edit_files", ctx);
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
    throw tooLarge(`uploaded file exceeds the maximum size of ${config.maxFileSizeBytes} bytes`);
  }
  const mimeType = patch.mime_type ?? file.mimeType ?? "";
  if (mimeType && !mimeAllowed(config, mimeType)) {
    await blob.delete(file.storageKey);
    throw unsupportedMediaType(`MIME type ${mimeType} is not allowed`, { allowed: config.mimeAllowlist });
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

/** Mints a fresh expiring link after re-confirming read_files. Every time.
 *  Pass { download: true } for an attachment (save) link instead of inline. */
export async function mintDownloadLink(
  env: FileEnv,
  userId: string,
  fileId: string,
  opts: { download?: boolean } = {},
): Promise<MintedLink> {
  const { db, blob, config } = env;
  const file = await getFileRow(db, fileId);
  const ctx = await getBundleContext(db, file.bundleId);
  await requireBundleCapability(db, userId, "read_files", ctx);
  if (file.status !== "finalized") throw notFound("file", fileId);
  const url = await blob.downloadUrl(file.storageKey, config.downloadTtlSeconds, {
    fileId: file.id,
    name: file.name,
    mimeType: file.mimeType,
    download: opts.download ?? false,
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
  await requireBundleCapability(db, userId, "edit_files", ctx);
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
  /** Attachment (save) link for the Download action; absent for direct URLs. */
  download_url?: string;
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
    const download = await mintDownloadLink(env, userId, fileId, { download: true });
    const viewToken = signToken(
      { scope: "widget", widget: "media-card", fileId },
      env.config.masterKey,
      env.config.widgetTokenTtlSeconds,
    );
    return {
      kind: fileKind(minted.mime_type),
      url: minted.url,
      download_url: download.url,
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
  const opts = { fileId: file.id, name: file.name, mimeType: file.mimeType };
  const url = await blob.downloadUrl(file.storageKey, config.downloadTtlSeconds, opts);
  const download_url = await blob.downloadUrl(file.storageKey, config.downloadTtlSeconds, { ...opts, download: true });
  return {
    kind: fileKind(file.mimeType),
    url,
    download_url,
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
    throw tooLarge(`file exceeds the maximum size of ${config.maxFileSizeBytes} bytes`);
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
