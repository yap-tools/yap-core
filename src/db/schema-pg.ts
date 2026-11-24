/**
 * Postgres schema. Twin of schema-sqlite.ts — table and column names must
 * stay identical; only the dialect-specific column builders differ. See
 * schema-sqlite.ts for the portability conventions.
 */
import { valueIndexPrefix } from "./valueIndex.js";
import { index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // Correlation id supplied by whatever system created the user. Opaque to
    // Yap; unique when set, and any number of users may leave it null.
    externalId: text("external_id"),
    // Account-level capabilities the operator has denied this user, as a JSON
    // array of names (see core/accountCapabilities.ts). Empty: unrestricted.
    deniedCapabilities: text("denied_capabilities").notNull().default("[]"),
    // An email address the operator gave the user (an invite) or a provider
    // vouched for at sign-up, lowercased. Used only to match a first provider
    // login to an invite and to check the sign-up allowlist; never to
    // recognise a returning user (see user_identities). Not unique.
    email: text("email"),
    // 1: this user logs in only through a login provider. Their access keys
    // are refused everywhere and none can be made for them (core/keyLogin.ts).
    // Set by the sysadmin, and on for users a provider login created.
    providerLoginOnly: integer("provider_login_only").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("users_external_id_idx").on(t.externalId), index("users_email_idx").on(t.email)],
);

/** Login-provider identities linked to a user (core/oidc.ts): the provider's
 * issuer and its stable subject id. A returning provider login is recognised
 * by this pair alone, never by email. Dies with its user. */
export const userIdentities = pgTable(
  "user_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("user_identities_issuer_subject_idx").on(t.issuer, t.subject),
    index("user_identities_user_idx").on(t.userId),
  ],
);

export const accessKeys = pgTable(
  "access_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull().default(""),
    // Who issued the key: "user" (minted or rotated by the user themself) or
    // "sysadmin" (the initial key, or one issued over the sysadmin key lane).
    // A fact about the key's origin — it carries no authority of its own.
    issuer: text("issuer").$type<"user" | "sysadmin">().notNull().default("user"),
    // The key's fixed scope, as JSON (`{"role":"member"}`): a role mask that
    // narrows what the key may do below its user's authority. Null means an
    // unscoped key with the user's full authority. Set at creation, never changed.
    scope: text("scope"),
    keyHash: text("key_hash").notNull(),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (t) => [uniqueIndex("access_keys_key_hash_idx").on(t.keyHash)],
);

export const spaces = pgTable("spaces", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  keywords: text("keywords").notNull().default(""),
  context: text("context").notNull().default(""),
  personal: integer("personal").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const grants = pgTable(
  "grants",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(), // 'space' | 'bundle'
    resourceId: text("resource_id").notNull(),
    capability: text("capability").notNull(),
    effect: text("effect").notNull(), // 'allow' | 'deny'
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("grants_lookup_idx").on(t.userId, t.resourceId, t.capability)],
);

export const bundles = pgTable(
  "bundles",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("bundles_space_name_idx").on(t.spaceId, t.name)],
);

export const bundleDocs = pgTable(
  "bundle_docs",
  {
    id: text("id").primaryKey(),
    bundleId: text("bundle_id")
      .notNull()
      .references(() => bundles.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    content: text("content").notNull().default(""),
    autoload: integer("autoload").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("bundle_docs_bundle_name_idx").on(t.bundleId, t.name)],
);

export const itemTypes = pgTable(
  "item_types",
  {
    id: text("id").primaryKey(),
    bundleId: text("bundle_id")
      .notNull()
      .references(() => bundles.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("item_types_bundle_name_idx").on(t.bundleId, t.name)],
);

export const properties = pgTable(
  "properties",
  {
    id: text("id").primaryKey(),
    itemTypeId: text("item_type_id")
      .notNull()
      .references(() => itemTypes.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    datatype: text("datatype").notNull(), // 'text' | 'number' | 'boolean' | 'date' | 'item' | 'file'
    required: integer("required").notNull().default(0),
    multi: integer("multi").notNull().default(0), // holds an ordered list of values
    config: text("config").notNull().default(""), // JSON: per-datatype constraints ("" = none)
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("properties_item_type_idx").on(t.itemTypeId)],
);

export const items = pgTable(
  "items",
  {
    id: text("id").primaryKey(),
    bundleId: text("bundle_id")
      .notNull()
      .references(() => bundles.id, { onDelete: "cascade" }),
    itemTypeId: text("item_type_id")
      .notNull()
      .references(() => itemTypes.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("items_bundle_idx").on(t.bundleId), index("items_item_type_idx").on(t.itemTypeId)],
);

export const itemValues = pgTable(
  "item_values",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    propertyId: text("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    position: integer("position").notNull().default(0), // element order for multi-valued properties
  },
  (t) => [
    // Prefix only: see src/db/valueIndex.ts.
    index("item_values_prop_value_prefix_idx").on(t.propertyId, valueIndexPrefix(t.value)),
    index("item_values_item_idx").on(t.itemId),
  ],
);

export const files = pgTable(
  "files",
  {
    id: text("id").primaryKey(),
    bundleId: text("bundle_id")
      .notNull()
      .references(() => bundles.id, { onDelete: "cascade" }),
    spaceId: text("space_id").notNull(),
    ownerId: text("owner_id").notNull(),
    status: text("status").notNull(), // 'reserved' | 'finalized'
    name: text("name").notNull().default(""),
    mimeType: text("mime_type").notNull().default(""),
    size: integer("size").notNull().default(0),
    storageKey: text("storage_key").notNull(),
    uploadConsumed: integer("upload_consumed").notNull().default(0),
    createdAt: text("created_at").notNull(),
    finalizedAt: text("finalized_at"),
  },
  (t) => [index("files_bundle_idx").on(t.bundleId)],
);

export const services = pgTable(
  "services",
  {
    id: text("id").primaryKey(),
    bundleId: text("bundle_id")
      .notNull()
      .references(() => bundles.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    driver: text("driver").notNull().default("http"),
    params: text("params").notNull().default("[]"), // JSON: declared parameter specs
    pins: text("pins").notNull().default("{}"), // JSON: driver-specific pinned targets
    actions: text("actions"), // JSON array of allowed action names; null = every action the driver declares
    // The whole config, AES-GCM-encrypted, never returned. Kept current on every
    // write, so earlier releases (which read only this) still run the service.
    configEncrypted: text("config_encrypted").notNull(),
    // The config split by the driver's schema (src/core/serviceConfig.ts):
    // settings as readable JSON, secrets AES-GCM-encrypted and write-only.
    // Both null while the config is one sealed blob (a driver without a schema).
    settings: text("settings"),
    secretsEncrypted: text("secrets_encrypted"),
    // When a person approved the service as it now stands (core/serviceApprovals.ts);
    // null while it waits for approval, which an MCP write puts it into, and then
    // it cannot run. REST writes and services from before the column count as
    // approved. approved_by is the approver's user id: history, not a link.
    approvedAt: text("approved_at"),
    approvedBy: text("approved_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("services_bundle_name_idx").on(t.bundleId, t.name)],
);

/** Service schedules: a cron expression that starts a run of one service
 * action, as the user who created it. Its own object rather than a field on
 * the service, so one service can carry several schedules with different
 * params. Dies with its service (and so with its bundle) and with its owner. */
export const schedules = pgTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    bundleId: text("bundle_id")
      .notNull()
      .references(() => bundles.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    params: text("params").notNull().default("{}"), // JSON: the caller half, validated like run_service
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull().default("UTC"), // IANA
    enabled: integer("enabled").notNull().default(1),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastFiredAt: text("last_fired_at"),
    // No FK: runs are pruned by retention, and the pointer is history, not a link.
    lastRunId: text("last_run_id"),
    lastError: text("last_error"),
    lastSkippedAt: text("last_skipped_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("schedules_bundle_idx").on(t.bundleId, t.createdAt),
    index("schedules_service_idx").on(t.serviceId),
  ],
);

/** One-off forms for entering a service's secrets (core/secretRequests.ts).
 * An agent asks for one; the human fills it in, straight to the server. Each
 * row is good for one submission until it expires, and dies with its service
 * and with the user who asked for it. */
export const secretRequests = pgTable(
  "secret_requests",
  {
    id: text("id").primaryKey(),
    bundleId: text("bundle_id")
      .notNull()
      .references(() => bundles.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    paths: text("paths").notNull(), // JSON array of concrete secret paths the form asks for
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    // Set by the one submission that claims the form; null while it is open.
    usedAt: text("used_at"),
    // The user who logged in on the form to submit it: history, not a link.
    submittedBy: text("submitted_by"),
  },
  (t) => [index("secret_requests_service_idx").on(t.serviceId)],
);

/** One-off approval pages for a service written over MCP (core/serviceApprovals.ts).
 * An agent asks for one; a person logs in on it and approves or rejects the
 * service as it stands. Each row takes one decision until it expires, and dies
 * with its service and with the user who asked for it. */
export const serviceApprovals = pgTable(
  "service_approvals",
  {
    id: text("id").primaryKey(),
    bundleId: text("bundle_id")
      .notNull()
      .references(() => bundles.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    // Set by the one decision that claims the page; null while it is open.
    usedAt: text("used_at"),
    decision: text("decision"), // "approved" | "rejected", with usedAt
    decidedBy: text("decided_by"), // the user who logged in to decide: history, not a link
  },
  (t) => [index("service_approvals_service_idx").on(t.serviceId)],
);

/** Async service invocations — the audit trail for calls and their write-backs.
 * A run outlives the service it came from (service_id goes null; service_name
 * keeps the label) but dies with its bundle. */
export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    bundleId: text("bundle_id")
      .notNull()
      .references(() => bundles.id, { onDelete: "cascade" }),
    serviceId: text("service_id").references(() => services.id, { onDelete: "set null" }),
    serviceName: text("service_name").notNull(),
    action: text("action").notNull(),
    status: text("status").notNull(), // 'queued' | 'running' | 'succeeded' | 'failed'
    params: text("params").notNull().default("{}"), // JSON: the call's arguments
    result: text("result"),
    error: text("error"),
    errorCode: text("error_code"), // the YapError code behind `error`, for faithful re-throws
    writes: text("writes").notNull().default("[]"), // JSON: write-backs applied
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    // Who started the run and through what. Null on runs written before the
    // columns existed. No FK on user_id: like the service, the run outlives
    // the user it records.
    userId: text("user_id"),
    source: text("source"), // 'mcp' | 'rest' | 'hook' | 'schedule'
    scheduleId: text("schedule_id").references(() => schedules.id, { onDelete: "set null" }),
  },
  (t) => [
    index("runs_bundle_created_idx").on(t.bundleId, t.createdAt),
    index("runs_service_created_idx").on(t.serviceId, t.createdAt),
    // The retention sweep's predicate: terminal runs with a finished_at older
    // than the window. Without it the sweep is a full scan of every run ever.
    index("runs_finished_idx").on(t.status, t.finishedAt),
    // The scheduler's overlap check reads a run by id, but deleting a schedule
    // nulls its runs' pointer — without this that is a scan of every run.
    index("runs_schedule_idx").on(t.scheduleId),
  ],
);

/** OAuth clients (RFC 7591 dynamic registration). Public clients only — no
 * secret column by design; PKCE is the proof of possession. */
export const oauthClients = pgTable("oauth_clients", {
  id: text("id").primaryKey(), // the client_id
  name: text("name").notNull().default(""),
  redirectUris: text("redirect_uris").notNull(), // JSON string array
  createdAt: text("created_at").notNull(),
});

/** Pending authorization codes: single-use, short-lived, stored hashed. */
export const oauthCodes = pgTable(
  "oauth_codes",
  {
    id: text("id").primaryKey(),
    codeHash: text("code_hash").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The access key the person logged in with; null when they logged in
    // through a login provider (the grant then belongs to the user directly).
    keyId: text("key_id").references(() => accessKeys.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(), // JSON TokenScope
    codeChallenge: text("code_challenge").notNull(), // PKCE S256
    redirectUri: text("redirect_uri").notNull(),
    expiresAt: text("expires_at").notNull(),
    // The end of the grant this code becomes: set for a provider login only.
    grantExpiresAt: text("grant_expires_at"),
  },
  (t) => [uniqueIndex("oauth_codes_code_hash_idx").on(t.codeHash)],
);

/** One row per user↔client consent — the "connected apps" view. key_id binds
 * a grant to the access key presented at the authorize screen so revoking
 * that key kills the grant (and, via FK cascade, its tokens). A grant made
 * after a provider login has no key: it belongs to the user, dies with them
 * or when disconnected, and ends at expires_at. */
export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The access key the person logged in with; null when they logged in
    // through a login provider (the grant then belongs to the user directly).
    keyId: text("key_id").references(() => accessKeys.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(), // JSON TokenScope
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
    // A provider-login grant's maximum lifetime, counted from createdAt and
    // never extended by refresh: past it, refresh fails and its tokens stop
    // working. Null for a key-backed grant, which lives until revoked.
    expiresAt: text("expires_at"),
  },
  (t) => [index("oauth_grants_user_idx").on(t.userId), index("oauth_grants_key_idx").on(t.keyId)],
);

/** Access/refresh tokens, stored hashed. Rotated refresh tokens keep their
 * row (revoked_at set) so replay of a rotated token is detectable. */
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    grantId: text("grant_id")
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // 'access' | 'refresh'
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (t) => [uniqueIndex("oauth_tokens_token_hash_idx").on(t.tokenHash), index("oauth_tokens_grant_idx").on(t.grantId)],
);

/** One login-provider round trip (core/oidc.ts): created when a page sends
 * the person to their provider, claimed once by the callback, and then holding
 * a one-off login ticket that the page rendered after the callback presents
 * with the person's decision. Expires; swept on the next start. */
export const oidcTransactions = pgTable(
  "oidc_transactions",
  {
    id: text("id").primaryKey(),
    stateHash: text("state_hash").notNull(),
    provider: text("provider").notNull(), // the configured provider's name
    purpose: text("purpose").notNull(), // the page: consent | connections | service-approve | secret-input
    context: text("context").notNull(), // JSON: what the page was about (authorize params, request id)
    nonce: text("nonce").notNull(), // encrypted
    codeVerifier: text("code_verifier").notNull(), // PKCE, encrypted
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    // Set by the one callback that claims the row.
    calledBackAt: text("called_back_at"),
    // The person the callback identified, and the ticket the page carries.
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    ticketHash: text("ticket_hash"),
    ticketExpiresAt: text("ticket_expires_at"),
    // Set by the one decision that spends the ticket.
    usedAt: text("used_at"),
  },
  (t) => [
    uniqueIndex("oidc_transactions_state_idx").on(t.stateHash),
    uniqueIndex("oidc_transactions_ticket_idx").on(t.ticketHash),
    index("oidc_transactions_expires_idx").on(t.expiresAt),
  ],
);

export const userDocs = pgTable(
  "user_docs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    content: text("content").notNull().default(""),
    autoload: integer("autoload").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("user_docs_user_name_idx").on(t.userId, t.name)],
);
