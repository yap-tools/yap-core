/**
 * Agents: space-scoped, DB-stored worker definitions, siblings to bundles.
 * Authoring is REST-only and gated by edit_agents (mirroring edit_hooks);
 * running is a separate authority (run_agents). An agent is inert data plus a
 * bound, dedicated Yap access key: minted at creation for the creating user,
 * its plaintext AES-GCM-encrypted at rest so the run worker can inject it into
 * a container, and never returned by any surface. The agent therefore acts
 * with exactly its owner's grants at run time.
 */
import { and, asc, eq } from "drizzle-orm";

import type { YapConfig } from "../config.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import type { Db } from "../db/index.js";
import { hasAnyCapability, requireCapability, resolveCapability } from "./capabilities.js";
import { forbidden, invalid, notFound } from "./errors.js";
import { createKey } from "./keys.js";
import { getSpaceRow, toSpaceRef, type Space } from "./spaces.js";
import { newId, nowIso } from "./util.js";

export interface AgentEnv {
  db: Db;
  config: YapConfig;
}

/** Public, secret-free agent surface. */
export interface AgentInfo {
  id: string;
  spaceId: string;
  name: string;
  runtime: string;
  model: string;
  args: unknown;
  instructions: string;
  schedule: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Full stored row, including the encrypted bound key (worker-only). */
export interface AgentRow {
  id: string;
  spaceId: string;
  name: string;
  runtime: string;
  model: string;
  args: string;
  instructions: string;
  schedule: string | null;
  accessKeyId: string;
  accessKeyEncrypted: string;
  outputPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentInput {
  name: string;
  runtime: string;
  model: string;
  args?: unknown;
  instructions?: string;
  schedule?: string | null;
}

export interface UpdateAgentInput {
  name?: string;
  runtime?: string;
  model?: string;
  args?: unknown;
  instructions?: string;
  schedule?: string | null;
}

/** args is stored as a JSON string, or "" for "no args". */
function serializeArgs(args: unknown): string {
  return args === undefined || args === null ? "" : JSON.stringify(args);
}

function deserializeArgs(stored: string): unknown {
  return stored === "" ? null : JSON.parse(stored);
}

export function toAgentInfo(row: AgentRow): AgentInfo {
  return {
    id: row.id,
    spaceId: row.spaceId,
    name: row.name,
    runtime: row.runtime,
    model: row.model,
    args: deserializeArgs(row.args),
    instructions: row.instructions,
    schedule: row.schedule,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getAgentRow(db: Db, agentId: string): Promise<AgentRow> {
  const { agents } = db.tables;
  const rows = await db.client.select().from(agents).where(eq(agents.id, agentId));
  if (rows.length === 0) throw notFound("agent", agentId);
  return rows[0]! as AgentRow;
}

/**
 * Authoring gate, mirroring requireBundleCapability: insiders lacking
 * edit_agents get 403; genuine outsiders (no standing in the space) get 404 so
 * the agent's existence stays hidden.
 */
async function requireAgentEdit(db: Db, userId: string, space: Space, agentId?: string): Promise<void> {
  const ctx = { space: toSpaceRef(space) };
  const decision = await resolveCapability(db, userId, "edit_agents", ctx);
  if (decision.allowed) return;
  if (decision.decidedBy === "default_deny" && !(await hasAnyCapability(db, userId, ctx))) {
    throw notFound("agent", agentId ?? space.id);
  }
  throw forbidden("missing capability edit_agents", { capability: "edit_agents", decidedBy: decision.decidedBy });
}

/** Read gate: any standing in the space (owner or any grant). */
async function requireAgentRead(db: Db, userId: string, space: Space, agentId?: string): Promise<void> {
  if (!(await hasAnyCapability(db, userId, { space: toSpaceRef(space) }))) {
    throw notFound("agent", agentId ?? space.id);
  }
}

/** Load an agent and assert the user may author it (edit_agents). Shared by
 * the agent, file-attachment, and run trigger paths. */
export async function loadAgentForEdit(db: Db, userId: string, agentId: string): Promise<AgentRow> {
  const row = await getAgentRow(db, agentId);
  const space = await getSpaceRow(db, row.spaceId);
  await requireAgentEdit(db, userId, space, agentId);
  return row;
}

/** Load an agent and assert the user may view it (any standing in its space). */
export async function loadAgentForRead(db: Db, userId: string, agentId: string): Promise<AgentRow> {
  const row = await getAgentRow(db, agentId);
  const space = await getSpaceRow(db, row.spaceId);
  await requireAgentRead(db, userId, space, agentId);
  return row;
}

function validateName(raw: string | undefined): string {
  const name = raw?.trim();
  if (!name) throw invalid("agent name is required");
  return name;
}

export async function createAgent(
  env: AgentEnv,
  userId: string,
  spaceId: string,
  input: CreateAgentInput,
): Promise<AgentInfo> {
  const { db } = env;
  const space = await getSpaceRow(db, spaceId);
  await requireCapability(db, userId, "edit_agents", { space: toSpaceRef(space) });

  const name = validateName(input.name);
  const runtime = input.runtime?.trim();
  if (!runtime) throw invalid("agent runtime is required");
  const model = input.model?.trim();
  if (!model) throw invalid("agent model is required");

  const { agents } = db.tables;
  const clash = await db.client
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.spaceId, spaceId), eq(agents.name, name)));
  if (clash.length > 0) throw invalid(`an agent named "${name}" already exists in this space`);

  // Mint the dedicated bound key for the creating user and stash it encrypted
  // so the run worker can inject it; the plaintext is never returned.
  const key = await createKey(db, userId, `agent:${name}`);

  const now = nowIso();
  const row: AgentRow = {
    id: newId(),
    spaceId,
    name,
    runtime,
    model,
    args: serializeArgs(input.args),
    instructions: input.instructions ?? "",
    schedule: input.schedule ?? null,
    accessKeyId: key.id,
    accessKeyEncrypted: encryptSecret(key.key, env.config.masterKey),
    outputPath: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.client.insert(agents).values(row);
  return toAgentInfo(row);
}

export async function listAgents(db: Db, userId: string, spaceId: string): Promise<AgentInfo[]> {
  const space = await getSpaceRow(db, spaceId);
  await requireAgentRead(db, userId, space);
  const { agents } = db.tables;
  const rows = await db.client
    .select()
    .from(agents)
    .where(eq(agents.spaceId, spaceId))
    .orderBy(asc(agents.createdAt), asc(agents.id));
  return (rows as AgentRow[]).map(toAgentInfo);
}

export async function getAgent(db: Db, userId: string, agentId: string): Promise<AgentInfo> {
  return toAgentInfo(await loadAgentForRead(db, userId, agentId));
}

export async function updateAgent(
  env: AgentEnv,
  userId: string,
  agentId: string,
  patch: UpdateAgentInput,
): Promise<AgentInfo> {
  const { db } = env;
  const row = await loadAgentForEdit(db, userId, agentId);

  const name = patch.name !== undefined ? validateName(patch.name) : undefined;
  const runtime = patch.runtime !== undefined ? patch.runtime.trim() : undefined;
  if (runtime !== undefined && !runtime) throw invalid("agent runtime cannot be empty");
  const model = patch.model !== undefined ? patch.model.trim() : undefined;
  if (model !== undefined && !model) throw invalid("agent model cannot be empty");

  const { agents } = db.tables;
  if (name !== undefined && name !== row.name) {
    const clash = await db.client
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.spaceId, row.spaceId), eq(agents.name, name)));
    if (clash.some((r) => r.id !== agentId)) {
      throw invalid(`an agent named "${name}" already exists in this space`);
    }
  }

  await db.client
    .update(agents)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(runtime !== undefined ? { runtime } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(patch.args !== undefined ? { args: serializeArgs(patch.args) } : {}),
      ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
      ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(agents.id, agentId));
  return toAgentInfo(await getAgentRow(db, agentId));
}

export async function deleteAgent(env: AgentEnv, userId: string, agentId: string): Promise<void> {
  const { db } = env;
  const row = await loadAgentForEdit(db, userId, agentId);
  const { agents, accessKeys } = db.tables;
  // Remove the agent (cascades agent_files and agent_runs), then destroy its
  // dedicated key — it has no purpose once the agent is gone.
  await db.client.delete(agents).where(eq(agents.id, agentId));
  await db.client.delete(accessKeys).where(eq(accessKeys.id, row.accessKeyId));
}

/** Worker-only: the bound key plaintext for injection into a run container. */
export function decryptAgentKey(env: AgentEnv, row: AgentRow): string {
  return decryptSecret(row.accessKeyEncrypted, env.config.masterKey);
}
