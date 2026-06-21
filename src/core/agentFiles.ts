/**
 * Files attached to an agent and staged read-only into its run container.
 * Same three-phase lifecycle as bundle files (request → upload → complete),
 * but agent-scoped and gated by edit_agents. Bytes live in the blob store and
 * never pass through any agent-visible surface; only the run worker reads them
 * (see listFinalizedAgentFiles).
 */
import { and, asc, eq } from "drizzle-orm";

import type { BlobStore } from "../blob/index.js";
import type { YapConfig } from "../config.js";
import { signToken } from "../crypto.js";
import type { Db } from "../db/index.js";
import { loadAgentForEdit, loadAgentForRead } from "./agents.js";
import { cleanFileName, mimeAllowed, type UploadRequestResult } from "./files.js";
import { YapError, invalid, notFound } from "./errors.js";
import { newId, nowIso } from "./util.js";

export const AGENT_UPLOAD_COMPLETE_SCOPE = "agent-upload-complete";

export interface AgentFileEnv {
  db: Db;
  blob: BlobStore;
  config: YapConfig;
}

export interface AgentFileInfo {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  status: string;
  createdAt: string;
}

interface AgentFileRow {
  id: string;
  agentId: string;
  status: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
  uploadConsumed: number;
  createdAt: string;
  finalizedAt: string | null;
}

async function getAgentFileRow(db: Db, agentFileId: string): Promise<AgentFileRow> {
  const { agentFiles } = db.tables;
  const rows = await db.client.select().from(agentFiles).where(eq(agentFiles.id, agentFileId));
  if (rows.length === 0) throw notFound("agent file", agentFileId);
  return rows[0]! as AgentFileRow;
}

export async function requestAgentUpload(
  env: AgentFileEnv,
  userId: string,
  agentId: string,
  input: { name: string; mime_type?: string; size?: number },
): Promise<UploadRequestResult> {
  const { db, blob, config } = env;
  const agent = await loadAgentForEdit(db, userId, agentId);

  const name = cleanFileName(input.name);
  const declaredMime = input.mime_type ?? "";
  if (declaredMime && !mimeAllowed(config, declaredMime)) {
    throw invalid(`MIME type ${declaredMime} is not allowed`, { allowed: config.mimeAllowlist });
  }
  if (input.size !== undefined && input.size > config.maxFileSizeBytes) {
    throw invalid(`file exceeds the maximum size of ${config.maxFileSizeBytes} bytes`);
  }

  const { agentFiles } = db.tables;
  const fileId = newId();
  const storageKey = `${agent.spaceId}/agents/${agentId}/${fileId}`;
  await db.client.insert(agentFiles).values({
    id: fileId,
    agentId,
    status: "reserved",
    name,
    mimeType: declaredMime,
    size: 0,
    storageKey,
    uploadConsumed: 0,
    createdAt: nowIso(),
    finalizedAt: null,
  });

  const uploadUrl = await blob.uploadUrl(storageKey, fileId, config.uploadTtlSeconds, { route: "agent-files" });
  const completeToken = signToken({ scope: AGENT_UPLOAD_COMPLETE_SCOPE, fileId }, config.masterKey, config.uploadTtlSeconds);
  const originToken = signToken(
    { scope: "widget", widget: "upload-dropzone", fileId },
    config.masterKey,
    config.widgetTokenTtlSeconds,
  );
  return {
    file_id: fileId,
    upload_url: uploadUrl,
    upload_url_expires_in: config.uploadTtlSeconds,
    complete_url: `${config.baseUrl}/v1/agent-files/${fileId}/complete?token=${completeToken}`,
    origin_upload_url: `${config.baseUrl}/w/upload-dropzone?token=${originToken}`,
    status: "reserved",
  };
}

export async function listAgentFiles(db: Db, userId: string, agentId: string): Promise<AgentFileInfo[]> {
  await loadAgentForRead(db, userId, agentId);
  const { agentFiles } = db.tables;
  const rows = await db.client
    .select({
      id: agentFiles.id,
      name: agentFiles.name,
      mimeType: agentFiles.mimeType,
      size: agentFiles.size,
      status: agentFiles.status,
      createdAt: agentFiles.createdAt,
    })
    .from(agentFiles)
    .where(and(eq(agentFiles.agentId, agentId), eq(agentFiles.status, "finalized")))
    .orderBy(asc(agentFiles.createdAt), asc(agentFiles.id));
  return rows;
}

/** Single-use byte slot claim, mirroring files.storeUploadedBytes. */
export async function storeAgentUploadedBytes(
  env: AgentFileEnv,
  fileId: string,
  bytes: Uint8Array,
): Promise<{ size: number }> {
  const { db, blob, config } = env;
  if (bytes.byteLength > config.maxFileSizeBytes) {
    throw invalid(`file exceeds the maximum size of ${config.maxFileSizeBytes} bytes`);
  }
  const file = await getAgentFileRow(db, fileId);
  const { agentFiles } = db.tables;
  const claimed = await db.client
    .update(agentFiles)
    .set({ uploadConsumed: 1 })
    .where(and(eq(agentFiles.id, fileId), eq(agentFiles.status, "reserved"), eq(agentFiles.uploadConsumed, 0)))
    .returning({ id: agentFiles.id });
  if (claimed.length === 0) {
    throw new YapError(
      "conflict",
      file.status !== "reserved" ? "this upload is no longer open" : "this upload link was already used (single-use)",
    );
  }
  await blob.put(file.storageKey, bytes);
  return { size: bytes.byteLength };
}

async function finalizeAgentUpload(env: AgentFileEnv, fileId: string): Promise<AgentFileInfo> {
  const { db, blob, config } = env;
  const file = await getAgentFileRow(db, fileId);
  if (file.status !== "reserved") throw new YapError("conflict", `file ${fileId} is already finalized`);
  const stat = await blob.stat(file.storageKey);
  if (!stat) throw invalid("no uploaded bytes found for this file — upload before completing");
  if (stat.size > config.maxFileSizeBytes) {
    await blob.delete(file.storageKey);
    throw invalid(`uploaded file exceeds the maximum size of ${config.maxFileSizeBytes} bytes`);
  }
  const { agentFiles } = db.tables;
  await db.client
    .update(agentFiles)
    .set({ status: "finalized", size: stat.size, finalizedAt: nowIso() })
    .where(eq(agentFiles.id, fileId));
  const updated = await getAgentFileRow(db, fileId);
  return {
    id: updated.id,
    name: updated.name,
    mimeType: updated.mimeType,
    size: updated.size,
    status: updated.status,
    createdAt: updated.createdAt,
  };
}

/** Token-authorized finalize (the upload widget/headless path). */
export async function completeAgentUploadSigned(env: AgentFileEnv, fileId: string): Promise<AgentFileInfo> {
  return finalizeAgentUpload(env, fileId);
}

/** User-credential finalize: re-checks edit_agents on the owning agent. */
export async function completeAgentUpload(env: AgentFileEnv, userId: string, fileId: string): Promise<AgentFileInfo> {
  const file = await getAgentFileRow(env.db, fileId);
  await loadAgentForEdit(env.db, userId, file.agentId);
  return finalizeAgentUpload(env, fileId);
}

export async function deleteAgentFile(env: AgentFileEnv, userId: string, fileId: string): Promise<void> {
  const { db, blob } = env;
  const file = await getAgentFileRow(db, fileId);
  await loadAgentForEdit(db, userId, file.agentId);
  await blob.delete(file.storageKey);
  const { agentFiles } = db.tables;
  await db.client.delete(agentFiles).where(eq(agentFiles.id, fileId));
}

/** Worker-only: finalized files to stage into a run container. */
export async function listFinalizedAgentFiles(
  db: Db,
  agentId: string,
): Promise<{ name: string; storageKey: string }[]> {
  const { agentFiles } = db.tables;
  return db.client
    .select({ name: agentFiles.name, storageKey: agentFiles.storageKey })
    .from(agentFiles)
    .where(and(eq(agentFiles.agentId, agentId), eq(agentFiles.status, "finalized")))
    .orderBy(asc(agentFiles.createdAt), asc(agentFiles.id));
}
