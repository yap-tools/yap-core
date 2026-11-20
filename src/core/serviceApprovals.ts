/**
 * Service approvals: a service written over MCP does not run until a person
 * approves it.
 *
 * A service can send data out of the instance, and an agent can be steered by
 * something it read. So over MCP the agent proposes and a person decides. The
 * state lives on the service row (`approved_at`, `approved_by`; services.ts
 * sets and clears it, runs.ts refuses a service without it). This module is
 * the person's side: a one-off approve page.
 *
 * - `approval_request` (an `edit_services` holder) reserves a row here for one
 *   service that waits, and returns an origin URL plus a `service-approve`
 *   widget pointer, like `secret_request`. Good for one decision, expiring
 *   after the secret form's TTL. Expired rows are swept when a new one is made.
 * - The page shows the service as the server has it, never as the agent
 *   describes it: name, driver, where data goes (`destinations`), the allowed
 *   actions with their parameters, pins, settings, and which secret paths are
 *   set (names only). In a host's frame the widget fetches that view itself,
 *   with the page's own signed token, from the instance it was served by.
 * - Approve needs a login: an unscoped user access key, through the same
 *   `pageLogin` the OAuth consent screen uses. The signed token alone is not
 *   enough, and an OAuth token or a scoped key is refused, so an agent
 *   connected over OAuth or given a scoped key cannot approve. An agent
 *   holding a full access key itself can; that is discouraged, not
 *   prevented. The approver must hold `edit_services` on the bundle, and, for
 *   a driver that writes into it, `edit_items` / `edit_files`: approving is
 *   vouching for the service as an author does.
 * - The decision is for the service as shown. The page carries a fingerprint
 *   of what it showed; approving checks it against the service now and lands
 *   only on the row it read, so a change in between (another MCP write, which
 *   also closes open pages) fails it rather than approving what was not seen.
 *   A secret replaced through the form in between changes no fingerprint; one
 *   newly set or removed does (the page lists the set paths), and the person
 *   reloads.
 * - Reject needs no login: it changes nothing but the page, which then says
 *   the service stays off.
 */
import { createHash } from "node:crypto";

import { and, eq, gt, isNull, lt } from "drizzle-orm";

import type { YapConfig } from "../config.js";
import { signToken } from "../crypto.js";
import { getBundleContext, hasBundleCapability, requireBundleCapability } from "./bundles.js";
import type { DriverDefinition } from "./drivers/types.js";
import { forbidden, invalid, unauthorized, YapError } from "./errors.js";
import { pageLogin, SCOPED_KEY_LOGIN_REFUSED, type PageLoginRefusal } from "./keys.js";
import { isSplit, readParts, secretsSet, type ConfigObject } from "./serviceConfig.js";
import {
  allowedActions,
  canonicalJson,
  getServiceRow,
  requireWriteCapabilities,
  resolveActionParams,
  resolveServiceId,
  type ServiceEnv,
  type ServiceParamSpec,
  type ServicePins,
} from "./services.js";
import { newId, nowIso } from "./util.js";

// ---- Destinations -----------------------------------------------------------

/** One place the service sends data, as a person reads it. */
export interface DestinationView {
  label: string;
  /** The value, pins filled in; null when every run chooses it. */
  value: string | null;
  /** Parameters a run fills in, left in `value` as {{name}} (or all of it, when value is null). */
  chosenPerRun: string[];
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function valueAt(config: ConfigObject, path: string): unknown {
  let node: unknown = config;
  for (const segment of path.split(".")) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** A setting's value in one line: a server block as host:port, a string as is, anything else as JSON. */
function render(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const block = value as Record<string, unknown>;
    if (typeof block.host === "string" && block.port !== undefined) {
      return `${block.host}:${String(block.port)}${typeof block.security === "string" ? ` (${block.security})` : ""}`;
    }
  }
  return JSON.stringify(value);
}

/**
 * Where a service sends data, by its driver's `destinations`, with the
 * service's pins filled in: an http url with a pinned path segment reads as
 * the url it will call, and a mail `to` pinned to one address reads as that
 * address. What a run still chooses is named, not hidden. A setting that is
 * not there (a mail service without smtp) is left out; a param destination
 * counts only when an allowed action takes it.
 *
 * `only` narrows it to some settings (the secret form shows where the secrets
 * it asks for are sent); a setting no destination names is then shown under
 * its own path.
 */
export function describeDestinations(
  def: DriverDefinition,
  service: { settings: ConfigObject; pins: ServicePins; params: ServiceParamSpec[]; actions: string | null },
  only?: string[],
): DestinationView[] {
  const declared = def.configSchema?.destinations ?? [];
  const allowed = allowedActions(def, service.actions);
  const views: DestinationView[] = [];
  const fill = (text: string): { value: string; perRun: string[] } => {
    const perRun: string[] = [];
    const value = text.replace(PLACEHOLDER, (whole, name: string) => {
      if (Object.hasOwn(service.pins, name)) return String(service.pins[name]);
      if (!perRun.includes(name)) perRun.push(name);
      return whole;
    });
    return { value, perRun };
  };
  const settingView = (label: string, path: string): void => {
    const raw = valueAt(service.settings, path);
    if (raw === undefined || raw === null) return;
    const { value, perRun } = fill(render(raw));
    views.push({ label, value, chosenPerRun: perRun });
  };

  if (only) {
    for (const path of only) {
      settingView(declared.find((d) => d.setting === path)?.label ?? path, path);
    }
    return views;
  }
  for (const destination of declared) {
    if (destination.setting !== undefined) {
      settingView(destination.label, destination.setting);
      continue;
    }
    const name = destination.param!;
    const actions = allowed.filter((a) => !destination.actions || destination.actions.includes(a));
    const takes = actions.some((action) => {
      const { callable, pinned } = resolveActionParams(def, action, service.params, service.pins);
      return Object.hasOwn(pinned, name) || callable.some((spec) => spec.name === name);
    });
    if (!takes) continue;
    if (Object.hasOwn(service.pins, name)) {
      views.push({ label: destination.label, value: String(service.pins[name]), chosenPerRun: [] });
    } else {
      views.push({ label: destination.label, value: null, chosenPerRun: [name] });
    }
  }
  return views;
}

// ---- The view a person approves ------------------------------------------------

/** What the approve page shows: the service as the server has it. Never a secret value. */
export interface ApprovalView {
  service: { id: string; name: string; description: string };
  driver: { name: string; description: string; egress: boolean; writes: string[] };
  /** Whether it is approved already (someone else got there first, or a REST write). */
  approved: boolean;
  destinations: DestinationView[];
  actions: Array<{ name: string; description: string; params: ServiceParamSpec[] }>;
  /** The parameter specs on the record, and the values pinned to some of them. */
  params: ServiceParamSpec[];
  pins: ServicePins;
  settings: ConfigObject;
  /** Which secret paths hold a value: names only. */
  secrets_set: string[];
}

interface Loaded {
  def: DriverDefinition;
  row: Awaited<ReturnType<typeof getServiceRow>>;
  view: ApprovalView;
  fingerprint: string;
}

async function loadView(env: ServiceEnv, serviceId: string): Promise<Loaded> {
  const row = await getServiceRow(env.db, serviceId);
  const def = env.registry.has(row.driver) ? env.registry.get(row.driver) : undefined;
  if (!def) throw invalid(`service "${row.name}" needs the "${row.driver}" driver, which is not installed on this server`);
  // A service that waits was written over MCP, and MCP writes only split
  // configs; a sealed one is a REST service, approved by its write.
  if (!isSplit(row)) throw invalid(`service "${row.name}" keeps its config as one sealed secret and is approved by its REST author`);
  const { settings, secrets } = readParts(row, env.config.masterKey);
  const params = JSON.parse(row.params) as ServiceParamSpec[];
  const pins = JSON.parse(row.pins) as ServicePins;
  const view: ApprovalView = {
    service: { id: row.id, name: row.name, description: row.description },
    driver: {
      name: def.name,
      description: def.description,
      egress: def.egress,
      writes: (["items", "files"] as const).filter((s) => def.writes?.[s] === true),
    },
    approved: row.approvedAt !== null,
    destinations: describeDestinations(def, { settings, pins, params, actions: row.actions }),
    actions: allowedActions(def, row.actions).map((name) => ({
      name,
      description: def.actions[name]!.description,
      params: resolveActionParams(def, name, params, pins).callable,
    })),
    params,
    pins,
    settings,
    secrets_set: secretsSet(def, secrets),
  };
  // `approved` is left out: approving a service someone approved meanwhile is fine.
  const { approved: _approved, ...shown } = view;
  const fingerprint = createHash("sha256").update(canonicalJson(shown)).digest("hex");
  return { def, row, view, fingerprint };
}

// ---- Requests -------------------------------------------------------------------

export interface ApprovalRequestResult {
  request_id: string;
  service: { id: string; name: string };
  expires_in: number;
  /** A signed page with the approval: give this link to a person. */
  origin_url: string;
}

/** What the service-approve widget is handed in a host's frame: enough to fetch the view, nothing to show. */
export interface ApprovalWidgetData {
  request_id: string;
  /** The page's own signed token, sent in the body of its view and decide calls. */
  token: string;
}

/** What the origin page is served with: the same, plus the view built at serve time. */
export interface ApprovalPageData extends ApprovalWidgetData {
  view: ApprovalView;
  fingerprint: string;
}

function pageToken(config: YapConfig, requestId: string, ttlSeconds: number): string {
  return signToken({ scope: "service-approve", requestId }, config.masterKey, ttlSeconds);
}

/**
 * `approval_request`: reserves a one-off approve page for a service that
 * waits for approval. Needs `edit_services` on the bundle.
 */
export async function requestApproval(
  env: ServiceEnv,
  userId: string,
  bundleId: string,
  input: { service: string },
): Promise<{ result: ApprovalRequestResult; widget: ApprovalWidgetData }> {
  const { db, config } = env;
  const ctx = await getBundleContext(db, bundleId);
  await requireBundleCapability(db, userId, "edit_services", ctx);
  const serviceId = await resolveServiceId(db, bundleId, input.service);
  const { row } = await loadView(env, serviceId);
  if (row.approvedAt !== null) throw invalid(`service "${row.name}" is approved already and runs`);

  const { serviceApprovals } = db.tables;
  const now = Date.now();
  const ttl = config.secretRequestTtlSeconds;
  await db.client.delete(serviceApprovals).where(lt(serviceApprovals.expiresAt, new Date(now).toISOString()));
  const id = newId();
  await db.client.insert(serviceApprovals).values({
    id,
    bundleId,
    serviceId,
    createdBy: userId,
    createdAt: nowIso(),
    expiresAt: new Date(now + ttl * 1000).toISOString(),
    usedAt: null,
    decision: null,
    decidedBy: null,
  });
  const originToken = signToken({ scope: "widget", widget: "service-approve", requestId: id }, config.masterKey, ttl);
  return {
    result: {
      request_id: id,
      service: { id: row.id, name: row.name },
      expires_in: ttl,
      origin_url: `${config.baseUrl}/w/service-approve?token=${originToken}`,
    },
    widget: { request_id: id, token: pageToken(config, id, ttl) },
  };
}

type RequestRow = { id: string; bundleId: string; serviceId: string; expiresAt: string; usedAt: string | null };

/** A request that can still take a decision, or the reason it cannot. */
async function openRequest(env: ServiceEnv, requestId: string): Promise<RequestRow> {
  const { serviceApprovals } = env.db.tables;
  const rows = await env.db.client.select().from(serviceApprovals).where(eq(serviceApprovals.id, requestId));
  const row = rows[0];
  // Gone (swept, closed by a change to the service, or the service deleted) reads like expired.
  if (!row || row.expiresAt < nowIso()) throw unauthorized("this approval page has expired: ask for a new one");
  if (row.usedAt !== null) throw new YapError("conflict", "this approval page has already been used: ask for a new one");
  return row;
}

/** The view of an open request (token checked by the caller). */
export async function approvalView(
  env: ServiceEnv,
  requestId: string,
): Promise<{ view: ApprovalView; fingerprint: string }> {
  const request = await openRequest(env, requestId);
  const { view, fingerprint } = await loadView(env, request.serviceId);
  return { view, fingerprint };
}

/** The data an origin-hosted approve page is served with (token checked by the caller). */
export async function approvalPageData(env: ServiceEnv, requestId: string): Promise<ApprovalPageData> {
  const request = await openRequest(env, requestId);
  const { view, fingerprint } = await loadView(env, request.serviceId);
  const remaining = Math.max(1, Math.floor((Date.parse(request.expiresAt) - Date.now()) / 1000));
  return { request_id: requestId, token: pageToken(env.config, requestId, remaining), view, fingerprint };
}

const LOGIN_REFUSED: Record<PageLoginRefusal, string> = {
  missing: "Enter your access key to approve.",
  sysadmin: "The sysadmin key cannot approve a service: enter one of your user access keys.",
  "oauth-token": "An app's token cannot approve a service: enter one of your user access keys.",
  "scoped-key": SCOPED_KEY_LOGIN_REFUSED,
  invalid: "That access key is invalid or revoked.",
};

/**
 * A decision on the page (token checked by the caller). Reject uses the page
 * up and changes nothing else. Approve logs the person in, checks they may,
 * checks the service is still what the page showed, and marks it approved.
 * A refused approval (a wrong key, a missing capability, a changed service)
 * leaves the page open.
 */
export async function decideApproval(
  env: ServiceEnv,
  requestId: string,
  input: { decision: unknown; accessKey?: unknown; fingerprint?: unknown },
): Promise<{ decision: "approved" | "rejected"; service: { id: string; name: string } }> {
  const { db, config } = env;
  const request = await openRequest(env, requestId);
  const { serviceApprovals, services } = db.tables;
  const usedAt = nowIso();
  const claimWhere = and(
    eq(serviceApprovals.id, requestId),
    isNull(serviceApprovals.usedAt),
    gt(serviceApprovals.expiresAt, usedAt),
  );
  const used = (): never => {
    throw new YapError("conflict", "this approval page has already been used or has expired: ask for a new one");
  };

  if (input.decision === "reject") {
    const row = await getServiceRow(db, request.serviceId);
    const claimed = await db.client
      .update(serviceApprovals)
      .set({ usedAt, decision: "rejected" })
      .where(claimWhere)
      .returning({ id: serviceApprovals.id });
    if (claimed.length === 0) used();
    return { decision: "rejected", service: { id: row.id, name: row.name } };
  }
  if (input.decision !== "approve") throw invalid('decision must be "approve" or "reject"');

  const login = await pageLogin(db, config.sysadminKey, typeof input.accessKey === "string" ? input.accessKey : "");
  if (!login.ok) throw unauthorized(LOGIN_REFUSED[login.reason]);
  const ctx = await getBundleContext(db, request.bundleId);
  if (!(await hasBundleCapability(db, login.userId, "edit_services", ctx))) {
    throw forbidden("approving a service needs edit_services on its bundle, which this account does not hold");
  }
  const { def, row, fingerprint } = await loadView(env, request.serviceId);
  await requireWriteCapabilities(db, login.userId, def, ctx);
  if (input.fingerprint !== fingerprint) {
    throw new YapError("conflict", "the service changed since this page was opened: reload it and check it again");
  }

  await db.transaction(function* (tx) {
    const claimed: unknown[] = yield tx
      .update(serviceApprovals)
      .set({ usedAt, decision: "approved", decidedBy: login.userId })
      .where(claimWhere)
      .returning({ id: serviceApprovals.id });
    if (claimed.length === 0) used();
    // Lands only on the row the fingerprint was taken from.
    const written: unknown[] = yield tx
      .update(services)
      .set({ approvedAt: usedAt, approvedBy: login.userId })
      .where(
        and(eq(services.id, row.id), eq(services.updatedAt, row.updatedAt), eq(services.configEncrypted, row.configEncrypted)),
      )
      .returning({ id: services.id });
    if (written.length === 0) {
      throw new YapError("conflict", "the service changed while this page was open: reload it and check it again");
    }
  });
  return { decision: "approved", service: { id: row.id, name: row.name } };
}
