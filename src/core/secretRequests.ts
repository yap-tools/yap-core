/**
 * Secret requests: how a service's secrets reach the server without passing
 * through an agent.
 *
 * An agent authoring a service over MCP sends its settings only (services.ts
 * refuses a secret value in them). To fill in the secrets it calls
 * `secret_request` for some of the driver's secret paths. That reserves a row
 * here and returns a widget pointer plus an origin URL, like `upload_request`.
 * The human opens the form, types each secret into a password field, logs
 * in, and the form POSTs straight to
 * `POST /v1/secret-requests/:id/submit` with its own signed token. The agent
 * sees the paths, their labels and whether each is set, never a value.
 *
 * The rules, which mirror uploads:
 *
 * - Asking for one needs `edit_services` on the service's bundle, and the
 *   service must be one MCP can author: its driver publishes a config schema
 *   and its config is stored split into settings and secrets.
 * - A request is good for one successful submission and expires after
 *   `YAP_SECRET_REQUEST_TTL_SECONDS` (default 600, as uploads). The claim is a
 *   conditional UPDATE inside the same transaction as the secret write, so two
 *   submissions racing on one form store one set of values, and a submission
 *   that fails (a value the driver refuses, the service changed meanwhile)
 *   leaves the form open to try again.
 * - A config change to the service (any surface) closes its open forms, so a
 *   form only ever delivers a secret to the service as it was when the human
 *   was handed the form.
 * - A submission sets the listed paths only. Every other secret and every
 *   setting stays as it is. Submitting a new form for the same path replaces
 *   that secret.
 * - Submitting needs a person's login, the same as the service approve page
 *   (personLogin.ts: a provider login, or an unscoped user access key where
 *   key login is on, never the sysadmin key, an OAuth token or a scoped key). The agent can see the form's token, so the token alone must not
 *   be enough: otherwise an agent could put a credential of its own into a
 *   service a person approved (a bearer token for its own account at the same
 *   API), and a secret change does not take the approval away. With the
 *   login, a secret is always one a person entered, so it keeps the approval.
 * - Asking checks that the user who asked holds `edit_services` on the
 *   bundle, plus `edit_items` / `edit_files` for a driver that writes into
 *   it, as an update would. Submitting checks the same for the asker and for
 *   the person who logged in, and records who that was (`submitted_by`).
 * - Each submission runs the driver's checks on the config the service will
 *   now run with, the online one included once no secret is missing.
 */
import { and, eq, gt, isNull, lt } from "drizzle-orm";

import type { YapConfig } from "../config.js";
import { signToken } from "../crypto.js";
import { getBundleContext, hasBundleCapability, requireBundleCapability } from "./bundles.js";
import { describeDestinations, type DestinationView } from "./serviceApprovals.js";
import type { DriverDefinition } from "./drivers/types.js";
import { forbidden, invalid, unauthorized, YapError } from "./errors.js";
import { SCOPED_KEY_LOGIN_REFUSED } from "./keys.js";
import { loginOptions, type LoginOptions } from "./oidc.js";
import { identifyPerson, loginRefusedMessage, type KeyLoginRefusalWords } from "./personLogin.js";
import {
  isSplit,
  mergeConfig,
  pendingSecretCandidates,
  readParts,
  secretFieldFor,
  secretsSet,
  setSecrets,
  splitColumns,
  type ConfigObject,
} from "./serviceConfig.js";
import {
  getServiceRow,
  neededSecrets,
  requireWriteCapabilities,
  resolveServiceId,
  validatePendingConfig,
  type ServiceEnv,
  type ServiceParamSpec,
  type ServicePins,
} from "./services.js";
import { newId, nowIso } from "./util.js";

/** How many paths one form may ask for. */
export const MAX_SECRET_REQUEST_PATHS = 20;
/** The longest value one field takes, in characters. Private keys fit; a file does not. */
export const MAX_SECRET_VALUE_LENGTH = 16 * 1024;

/** One field of the form, as the agent and the widget see it. Never a value. */
export interface SecretField {
  path: string;
  label: string;
  description?: string;
  /** Whether the service already holds a value at this path. */
  set: boolean;
}

export interface SecretRequestResult {
  request_id: string;
  service: { id: string; name: string };
  fields: SecretField[];
  expires_in: number;
  /** A signed page that shows the form: give this link to a human. */
  origin_url: string;
}

/** What the secret-input widget renders and where it posts. */
export interface SecretFormData {
  request_id: string;
  service_name: string;
  fields: SecretField[];
  /**
   * Where the secrets asked for are sent: the settings they are bound to
   * (`boundTo` in the driver's schema), with the service's pins filled in. An
   * http header shows the url; a mail password shows the IMAP and SMTP servers.
   */
  destinations: DestinationView[];
  submit_url: string;
  /** The form's own signed submit token, sent in the POST body. */
  token: string;
  /** How the form lets the person log in; set when the server serves the form (secretPageData). */
  logins?: LoginOptions;
  /** Present only on the form rendered after a provider login: who logged in, and the ticket the submission carries. */
  login?: { user: { name: string }; provider: { label: string }; ticket: string };
}

interface Loaded {
  def: DriverDefinition;
  row: Awaited<ReturnType<typeof getServiceRow>>;
  settings: ConfigObject;
  secrets: ConfigObject;
}

/** The service as a secret form needs it, or a refusal saying why it cannot have one. */
async function loadService(env: ServiceEnv, serviceId: string): Promise<Loaded> {
  const row = await getServiceRow(env.db, serviceId);
  const def = env.registry.has(row.driver) ? env.registry.get(row.driver) : undefined;
  if (!def) throw invalid(`service "${row.name}" needs the "${row.driver}" driver, which is not installed on this server`);
  if (def.configSchema === undefined) {
    throw invalid(
      `driver "${def.name}" publishes no config schema, so service "${row.name}" keeps its whole config as one ` +
        "sealed secret, set over REST only",
    );
  }
  if (!isSplit(row)) {
    throw invalid(`service "${row.name}" keeps its config as one sealed secret, so its secrets are set over REST only`);
  }
  const { settings, secrets } = readParts(row, env.config.masterKey);
  return { def, row, settings, secrets };
}

function fieldsFor(def: DriverDefinition, paths: string[], secrets: ConfigObject): SecretField[] {
  const set = new Set(secretsSet(def, secrets));
  return paths.map((path) => {
    const field = secretFieldFor(def, path)!;
    return {
      path,
      label: field.label,
      ...(field.description !== undefined ? { description: field.description } : {}),
      set: set.has(path),
    };
  });
}

/**
 * The paths to ask for when the agent names none: the secrets the service
 * still lacks, or, when it lacks none, every secret it holds (to replace them).
 *
 * "Lacks" is decided the way authoring checks a config without its secrets
 * (`neededSecrets`): of the ways to fill in what is missing, the
 * first the driver accepts. So a mail service on a password gets `pass`, and
 * one with an `oauth2` block gets that block's two secrets and not `pass`,
 * which the driver would refuse alongside them. When no way passes, every
 * missing path is asked for. A map path (`headers.*`) names no key, so it is
 * never asked for by default.
 */
function defaultPaths(def: DriverDefinition, settings: ConfigObject, secrets: ConfigObject): string[] {
  const merged = mergeConfig(settings, secrets);
  try {
    const needed = neededSecrets(def, merged);
    return needed.length > 0 ? needed : secretsSet(def, secrets);
  } catch {
    return pendingSecretCandidates(def, merged).pending;
  }
}

/** Where the secrets at `paths` go: every setting any of them is bound to, in the schema's order. */
function destinationsFor(def: DriverDefinition, row: Loaded["row"], settings: ConfigObject, paths: string[]): DestinationView[] {
  const bound: string[] = [];
  for (const path of paths) {
    for (const setting of secretFieldFor(def, path)?.boundTo ?? []) if (!bound.includes(setting)) bound.push(setting);
  }
  return describeDestinations(
    def,
    {
      settings,
      pins: JSON.parse(row.pins) as ServicePins,
      params: JSON.parse(row.params) as ServiceParamSpec[],
      actions: row.actions,
    },
    bound,
  );
}

function checkPaths(def: DriverDefinition, raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((p) => typeof p !== "string")) {
    throw invalid("paths must be a non-empty array of secret paths, e.g. [\"pass\"] or [\"headers.authorization\"]");
  }
  const paths = raw as string[];
  if (paths.length > MAX_SECRET_REQUEST_PATHS) {
    throw invalid(`a secret request takes at most ${MAX_SECRET_REQUEST_PATHS} paths`);
  }
  const declared = (def.configSchema?.secrets ?? []).map((field) => field.path);
  for (const [i, path] of paths.entries()) {
    if (paths.indexOf(path) !== i) throw invalid(`path "${path}" is listed twice`);
    if (!secretFieldFor(def, path)) {
      throw invalid(
        `"${path}" is not a secret path of driver "${def.name}" (its secret paths: ${declared.join(", ") || "none"}; ` +
          "spell a * out as the key, e.g. headers.authorization)",
      );
    }
  }
  return paths;
}

function formUrls(config: YapConfig, requestId: string, ttlSeconds: number): { submit_url: string; token: string } {
  return {
    submit_url: `${config.baseUrl}/v1/secret-requests/${requestId}/submit`,
    token: signToken({ scope: "secret-submit", requestId }, config.masterKey, ttlSeconds),
  };
}

/**
 * `secret_request`: reserves a one-off form for some of a service's secret
 * paths (see `defaultPaths` when `paths` is omitted) and returns what the
 * agent needs to hand it to a human. Expired requests of every service are
 * swept here, so the table holds only live ones and their recent remains.
 */
export async function requestSecrets(
  env: ServiceEnv,
  userId: string,
  bundleId: string,
  input: { service: string; paths?: unknown },
): Promise<{ result: SecretRequestResult; form: SecretFormData }> {
  const { db, config } = env;
  const ctx = await getBundleContext(db, bundleId);
  await requireBundleCapability(db, userId, "edit_services", ctx);
  const serviceId = await resolveServiceId(db, bundleId, input.service);
  const { def, row, settings, secrets } = await loadService(env, serviceId);
  // Setting a secret changes the service as an update would, so the same rule
  // about a driver's writes into the bundle applies.
  await requireWriteCapabilities(db, userId, def, ctx);

  let paths: string[];
  if (input.paths === undefined) {
    paths = defaultPaths(def, settings, secrets);
    if (paths.length === 0) {
      throw invalid(
        `name the secret paths to ask for (driver "${def.name}" marks ${(def.configSchema?.secrets ?? []).map((f) => f.path).join(", ") || "nothing"} secret; ` +
          "spell a * out as the key, e.g. headers.authorization)",
      );
    }
  } else {
    paths = checkPaths(def, input.paths);
  }

  const { secretRequests } = db.tables;
  const now = Date.now();
  const ttl = config.secretRequestTtlSeconds;
  await db.client.delete(secretRequests).where(lt(secretRequests.expiresAt, new Date(now).toISOString()));
  const id = newId();
  await db.client.insert(secretRequests).values({
    id,
    bundleId,
    serviceId,
    paths: JSON.stringify(paths),
    createdBy: userId,
    createdAt: nowIso(),
    expiresAt: new Date(now + ttl * 1000).toISOString(),
    usedAt: null,
  });

  const fields = fieldsFor(def, paths, secrets);
  const originToken = signToken({ scope: "widget", widget: "secret-input", requestId: id }, config.masterKey, ttl);
  return {
    result: {
      request_id: id,
      service: { id: row.id, name: row.name },
      fields,
      expires_in: ttl,
      origin_url: `${config.baseUrl}/w/secret-input?token=${originToken}`,
    },
    form: {
      request_id: id,
      service_name: row.name,
      fields,
      destinations: destinationsFor(def, row, settings, paths),
      ...formUrls(config, id, ttl),
    },
  };
}

type RequestRow = {
  id: string;
  bundleId: string;
  serviceId: string;
  paths: string;
  createdBy: string;
  expiresAt: string;
  usedAt: string | null;
};

/** A request that can still take a submission, or the reason it cannot. */
async function openRequest(env: ServiceEnv, requestId: string): Promise<RequestRow> {
  const { secretRequests } = env.db.tables;
  const rows = await env.db.client.select().from(secretRequests).where(eq(secretRequests.id, requestId));
  const row = rows[0];
  // Gone (swept, or its service deleted) reads like expired: the form is dead either way.
  if (!row || row.expiresAt < nowIso()) throw unauthorized("this form has expired: ask for a new one");
  if (row.usedAt !== null) throw new YapError("conflict", "this form has already been used: ask for a new one");
  return row;
}

/**
 * The form as the server has it (token checked by the caller): what an
 * origin-hosted form is served with, and what the widget in a host's frame
 * fetches before it shows anything, since the data it was handed there came
 * through the model.
 */
export async function secretPageData(env: ServiceEnv, requestId: string): Promise<SecretFormData> {
  const request = await openRequest(env, requestId);
  const { def, row, settings, secrets } = await loadService(env, request.serviceId);
  const remaining = Math.max(1, Math.floor((Date.parse(request.expiresAt) - Date.now()) / 1000));
  const paths = JSON.parse(request.paths) as string[];
  return {
    request_id: requestId,
    service_name: row.name,
    fields: fieldsFor(def, paths, secrets),
    destinations: destinationsFor(def, row, settings, paths),
    ...formUrls(env.config, requestId, remaining),
    logins: loginOptions(env.config),
  };
}

function checkValues(paths: string[], raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalid("values must be an object of secret path to value");
  }
  const values: Record<string, string> = {};
  for (const [path, value] of Object.entries(raw)) {
    if (!paths.includes(path)) throw invalid(`this form does not ask for "${path}"`);
    if (typeof value !== "string" || value === "") throw invalid(`the value for "${path}" must be a non-empty string`);
    if (value.length > MAX_SECRET_VALUE_LENGTH) {
      throw invalid(`the value for "${path}" is longer than ${MAX_SECRET_VALUE_LENGTH} characters`);
    }
    values[path] = value;
  }
  if (Object.keys(values).length === 0) throw invalid("fill in at least one field");
  return values;
}

const KEY_LOGIN_REFUSED: KeyLoginRefusalWords = {
  missing: "Enter your access key to save.",
  sysadmin: "The sysadmin key cannot enter a service's secrets: enter one of your user access keys.",
  "oauth-token": "An app's token cannot enter a service's secrets: enter one of your user access keys.",
  "scoped-key": SCOPED_KEY_LOGIN_REFUSED,
  invalid: "That access key is invalid or revoked.",
};

/**
 * A submission of the form (token checked by the caller): logs the person
 * in (an access key, or the ticket of a provider login made for this form),
 * sets the values given at the paths the form asked for, and uses the form up.
 * Returns the paths set and nothing else. A refused login leaves the form
 * open; a provider login is spent by the attempt, so after any refusal the
 * person logs in again.
 */
export async function submitSecrets(
  env: ServiceEnv,
  requestId: string,
  rawValues: unknown,
  presented: { accessKey?: unknown; loginTicket?: unknown } = {},
): Promise<{ saved: true; paths: string[] }> {
  const { db, config } = env;
  const request = await openRequest(env, requestId);
  const values = checkValues(JSON.parse(request.paths) as string[], rawValues);

  const login = await identifyPerson({ db, config }, presented, {
    purpose: "secret-input",
    context: { request_id: requestId },
  });
  if (!login.ok) throw unauthorized(loginRefusedMessage(config, login.reason, KEY_LOGIN_REFUSED, "save"));
  const ctx = await getBundleContext(db, request.bundleId);
  if (!(await hasBundleCapability(db, request.createdBy, "edit_services", ctx))) {
    throw forbidden("the user who asked for this form no longer holds edit_services on this bundle");
  }
  if (!(await hasBundleCapability(db, login.userId, "edit_services", ctx))) {
    throw forbidden("entering a service's secrets needs edit_services on its bundle, which this account does not hold");
  }
  const { def, row, settings, secrets } = await loadService(env, request.serviceId);
  // A config change closes open forms before it lands (services.ts). Checking
  // again now, after reading the service, means the config read here is one
  // this form was issued for, so the driver's online check below cannot send
  // the new secret to a destination changed since.
  await openRequest(env, requestId);
  await requireWriteCapabilities(db, request.createdBy, def, ctx);
  if (login.userId !== request.createdBy) await requireWriteCapabilities(db, login.userId, def, ctx);
  const next = setSecrets(settings, secrets, values);
  await validatePendingConfig(env, def, next.merged);
  const columns = splitColumns(next, config.masterKey);

  const { secretRequests, services } = db.tables;
  const usedAt = nowIso();
  await db.transaction(function* (tx) {
    // Expiry is checked again here, at the moment of use: the driver's online
    // check above can take a while, and a form must not outlive its time in it.
    const claimed: unknown[] = yield tx
      .update(secretRequests)
      .set({ usedAt, submittedBy: login.userId })
      .where(
        and(eq(secretRequests.id, requestId), isNull(secretRequests.usedAt), gt(secretRequests.expiresAt, usedAt)),
      )
      .returning({ id: secretRequests.id });
    if (claimed.length === 0) {
      throw new YapError("conflict", "this form has already been used or has expired: ask for a new one");
    }
    // Lands only on the config this submission was checked against; a write in
    // between (an author's update, another form) fails it, and the form stays open.
    const written: unknown[] = yield tx
      .update(services)
      .set({ ...columns, updatedAt: usedAt })
      .where(and(eq(services.id, row.id), eq(services.configEncrypted, row.configEncrypted)))
      .returning({ id: services.id });
    if (written.length === 0) {
      throw new YapError("conflict", "the service changed while this form was open: submit it again");
    }
  });
  return { saved: true, paths: Object.keys(values).sort() };
}
