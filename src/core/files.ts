/**
 * File records. Bytes live in the blob store; these rows catalogue ownership,
 * bundle/space scoping, and the reserved → finalized lifecycle. (The upload
 * lifecycle, link minting, and deletion land with M4; the listing here is
 * what load_bundle and list_files expose.)
 */
import { and, asc, eq } from "drizzle-orm";

import type { Db } from "../db/index.js";

export interface FileInfo {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  status: string;
  createdAt: string;
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
