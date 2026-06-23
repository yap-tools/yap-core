/**
 * Blob store: file bytes behind a uniform obtain-a-file contract — the
 * requester always gets an opaque, short-lived signed link, never the durable
 * location. Only the signing mechanism differs per adapter:
 *
 * - s3 (and compatible): FlyDrive presigned URLs; bytes go browser↔store
 *   directly and never pass through the API layer.
 * - fs (single-machine default): there is nothing to presign against, so Yap
 *   mints HMAC tokens for its own app-served upload/download endpoints —
 *   bytes do pass through the app layer, the accepted local-disk tradeoff.
 */
import type { Readable } from "node:stream";

import { Disk } from "flydrive";

import type { YapConfig } from "../config.js";
import { headerSafeFilename } from "../core/util.js";
import { signToken } from "../crypto.js";

export interface BlobStat {
  size: number;
  contentType?: string;
}

export interface DownloadUrlOpts {
  fileId: string;
  name: string;
  mimeType: string;
  /** Force an attachment (download) disposition instead of an inline preview. */
  download?: boolean;
}

export interface BlobStore {
  driver: "fs" | "s3";
  put(key: string, bytes: Uint8Array): Promise<void>;
  getStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  /** null when no bytes exist at the key. */
  stat(key: string): Promise<BlobStat | null>;
  /** Short-lived, single-use upload link for direct-to-storage writes. */
  uploadUrl(key: string, fileId: string, ttlSeconds: number): Promise<string>;
  /** Fresh, expiring download link (minted per request, post-permission-check). */
  downloadUrl(key: string, ttlSeconds: number, opts: DownloadUrlOpts): Promise<string>;
}

function diskBacked(disk: Disk): Pick<BlobStore, "put" | "getStream" | "delete" | "stat"> {
  return {
    put: async (key, bytes) => {
      await disk.put(key, bytes);
    },
    getStream: (key) => disk.getStream(key),
    delete: async (key) => {
      await disk.delete(key);
    },
    stat: async (key) => {
      try {
        const meta = await disk.getMetaData(key);
        return { size: meta.contentLength, contentType: meta.contentType };
      } catch {
        return null;
      }
    },
  };
}

export async function createBlobStore(config: YapConfig): Promise<BlobStore> {
  if (config.blob.driver === "fs") {
    const { FSDriver } = await import("flydrive/drivers/fs");
    const disk = new Disk(new FSDriver({ location: config.blob.root, visibility: "private" }));
    return {
      driver: "fs",
      ...diskBacked(disk),
      // App-served signed-token endpoints (see rest/routes.ts).
      uploadUrl: async (_key, fileId, ttlSeconds) => {
        const token = signToken({ scope: "upload", fileId }, config.masterKey, ttlSeconds);
        return `${config.baseUrl}/v1/files/${fileId}/upload?token=${token}`;
      },
      downloadUrl: async (_key, ttlSeconds, opts) => {
        const token = signToken({ scope: "download", fileId: opts.fileId }, config.masterKey, ttlSeconds);
        const url = `${config.baseUrl}/v1/files/${opts.fileId}/download?token=${token}`;
        // The /download route reads ?download=1 to switch to attachment.
        return opts.download ? `${url}&download=1` : url;
      },
    };
  }

  const { S3Driver } = await import("flydrive/drivers/s3");
  const s3 = config.blob;
  const disk = new Disk(
    new S3Driver({
      credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
      region: s3.region,
      ...(s3.endpoint ? { endpoint: s3.endpoint, forcePathStyle: s3.forcePathStyle } : {}),
      bucket: s3.bucket,
      visibility: "private",
    }),
  );
  return {
    driver: "s3",
    ...diskBacked(disk),
    // FlyDrive parses numeric expiresIn as seconds.
    uploadUrl: async (key, _fileId, ttlSeconds) =>
      disk.getSignedUploadUrl(key, { expiresIn: ttlSeconds }),
    // The presign bakes the response disposition in (extra query params would
    // break the SigV4 signature), so inline vs attachment is decided here.
    downloadUrl: async (key, ttlSeconds, opts) =>
      disk.getSignedUrl(key, {
        expiresIn: ttlSeconds,
        contentType: opts.mimeType || undefined,
        contentDisposition: opts.name
          ? `${opts.download ? "attachment" : "inline"}; filename="${headerSafeFilename(opts.name)}"`
          : undefined,
      }),
  };
}
