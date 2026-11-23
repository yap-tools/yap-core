/** Static reference documentation returned by the `help` tool. */

export const HELP_TEXT = `# Yap reference

Yap stores navigable context. The tree: context (root) → spaces → bundles.
A bundle holds docs, item-types (schemas with items), static files, and services.

## Core concepts

- **Space** — a grouping of bundles. Spaces do not nest. Every user has an
  undeletable, unshareable personal space, plus any spaces they create or are
  granted into.
- **Bundle** — the self-contained unit of stored context. Loading several
  bundles combines them for your session only; bundles are never merged in
  storage.
- **Docs** — named markdown docs a bundle carries. Autoloaded ones are
  binding operating instructions: returned in full by load_bundle, follow them
  while working in that bundle. Other docs are available on demand via
  read_docs.
- **Item / item-type** — structured records conforming to per-bundle schemas.
  Properties are typed (text, number, boolean, date, plus item — a reference to
  another item in the same bundle, item://<id> — and file — a reference to a
  finalized file, file://<id>) and may be multi-valued (an ordered list of that
  datatype). A date holds an instant by default: it takes YYYY-MM-DD (stored as
  midnight UTC) or a timestamp with Z or an offset (2026-11-16T09:00:00+01:00);
  anything else, a zoneless timestamp included, is refused, and it reads back
  as UTC ISO-8601. A date with config {precision: "day"} holds a calendar day
  (a due date, a birthday): it takes only YYYY-MM-DD, reads back exactly as
  sent (2026-11-16) and refuses timestamps. A property may declare config
  constraints, enforced on every write: text {pattern, enum}; date {precision}; number {min, max, decimals} (default 2 decimals,
  out-of-precision writes rejected); item {itemType} to pin the referent's
  type (send a name or id; it is stored and read back as the type's id, so a
  rename never breaks the link); any multi field {minItems, maxItems}; single-valued text/number
  {unique} — no two items of the type may share a value. Query multi fields with the set
  operators has/has_any/has_all/has_none, or a comparison op with a quantifier
  (any/all/none).
- **Service** — a named capability owned by a bundle: a driver plus the
  configuration that driver needs. You see the service's id, name, description,
  driver, and the declared parameters of each of its actions — never its
  destination, headers, or secrets, and never a parameter its operator pinned
  to a fixed value. The actions listed are the only ones the service has: an
  operator may expose just some of a driver's actions, and a service with one
  action needs no "action" argument. Built-in drivers: "http" (fires a
  configured request) and "mail" (one IMAP/SMTP account: folders, search,
  read, mark, send, draft — a service exposes only the ones it allows; draft
  leaves a reply in the Drafts folder for a human to send). list_drivers
  shows the installed drivers, their actions and, where a driver publishes
  one, its config schema: a JSON Schema for the service config plus the
  paths in it that hold secrets. It never shows any service's config.
- **Authoring a service** (edit_services) — create_service and
  update_service take the service's settings: its config without any secret.
  A value at a path the driver marks secret is refused; never ask the user
  to paste a secret into the chat either. Instead call secret_request for the
  paths you need: it returns a one-off form (a secret-input widget, and an
  origin_url to give the user) whose password fields go straight to the
  server; the user saves it with their own full access key, so you cannot fill
  it in yourself. You see the paths, their labels and whether each is set, never a
  value. The form takes one submission and expires. get_service shows an
  author the settings, pins and secretsSet; read it before update_service,
  whose settings replace the stored ones (a secret is kept while the object
  holding it stays; null at a secret path removes one; changing where a
  secret is sent, such as an http url or a mail server, drops it, and the
  user enters it again). The driver's checks
  run as if the missing secrets were filled in; the rest run when they are
  entered. A driver without a config schema is authored over REST only, and
  a driver that writes into the bundle also needs edit_items / edit_files.
- **Approval** — a service you create over MCP is off until a person
  approves it, because a service can send data out and you may have been
  steered by something you read. run_service and schedules refuse it, and
  listings show approved: false. Changing its params, pins, actions or
  settings over MCP turns it off again; renaming it, or entering secrets
  through secret_request, does not. Services written over REST with a full
  key count as approved; with a scoped key they wait like yours do. Enter the secrets first, then call approval_request and give the
  user its page (a service-approve widget, or origin_url): it shows where
  data goes, the actions, params, pins, settings and which secrets are set,
  and the person approves by logging in with one of their full access keys while
  holding edit_services. The link alone is not enough, and an OAuth token or
  a scoped access key is never accepted, so an agent connected over OAuth or
  with a scoped key cannot approve its own service. One known limit: an
  agent that holds a full access key itself (a key pasted into its MCP
  config, a script) could approve on the page with it. That is discouraged,
  not prevented. Never ask the user for a key.
- **Run** — one execution of a service, and always asynchronous. run_service
  starts one and returns the run record; poll get_run until status is
  succeeded or failed. wait_ms folds the first poll into the dispatch — if the
  run finishes inside that window (capped server-side) the record comes back
  already terminal, otherwise it keeps going on the server and nothing is lost
  by giving up on the wait. A failed run is a record with status "failed" and
  an error string, not a call error, so read run.status before reporting
  success. list_runs is the bundle's run log. All three need run_services.
  A run records who started it (user_id) and how (source: mcp, rest, hook, or
  schedule — with schedule_id for the last).
- **Schedule** — a cron (5-field, in an IANA timezone, UTC by default) that
  runs one service action with fixed params, as its owner: the user who
  created it. It skips a tick while its previous run is still going, and
  disables itself, saying why, if its owner loses run_services. Scheduling is
  running later, so it needs run_services and nothing more: create_schedule,
  update_schedule, delete_schedule and list_schedules (load_bundle shows them
  too). Only the owner may change what or when a schedule runs, or turn it
  back on; anyone else with run_services may disable or delete it.
- **User doc** — account-level guidance attached to you, available across all
  your spaces. Docs flagged autoload are returned by load at session start.
- **Widget** — an interactive panel some results render inline (file cards,
  upload dropzones, secret forms, approve pages). Delivered as ui:// resources. On a widget-capable host,
  render with show_widget, which carries the CSP the widget needs to reach the
  server (load file bytes, PUT an upload); the in-band result metadata and
  origin-hosted links are the fallback for hosts that don't render widgets.

## How to work

1. **load** — discover your spaces (id, name, description, keywords, role,
   and the names of the bundles inside). Match the user's intent against this
   metadata instead of opening everything; if several spaces could match, ask
   the user. Autoloading user docs, the current time, and a lightweight
   second-tier tool manifest arrive here too.
2. **load_space(space_id)** — the space's instructions and its bundles.
3. **load_bundle(bundle_ids)** — required before calling into a bundle:
   returns docs (autoloaded ones in full — follow them; list and fetch the rest
   with read_docs), item-type schemas, files, and services.
4. **get_tools(names?)** — expand the second-tier manifest when you need full
   tool descriptions or parameter specs before calling. Pass names to fetch
   only those full specs; omit names to return the manifest.
5. **call(space_id, calls)** — execute. Batch related operations in one
   round trip; each call succeeds or fails independently. Results include
   durationMs per call and as a total. A call targets a bundle (provide
   bundle_id) or the space (omit bundle_id). Full second-tier specs come from
   get_tools; load exposes only the manifest. Second-tier tools:
   items (query/get/create/update/delete), docs (get/read/create/update/patch/delete),
   files (list_files, show_file, upload_request, upload_complete, sideload_file — store
   a file straight from a URL, where the instance allows it — update_file to rename
   one, and delete_file),
   services (run_service, get_run, list_runs — fire_hook is a deprecated
   alias for run_service, kept until 1.0; get_service, create_service,
   update_service, delete_service, secret_request and approval_request for
   authors),
   schedules (create_schedule,
   update_schedule, delete_schedule, list_schedules), and management — gated by the matching capability:
   spaces (update_space/delete_space, manage_space), roles
   (list_grants/grant_role/revoke_grant, manage_roles), bundles & schemas
   (update_bundle/delete_bundle, create/update/delete_item_type,
   add/update/delete_property, edit_bundles).

   **get_doc** fetches a single doc by name or id. **patch_doc** (and the
   first-tier patch_user_doc / get_user_doc) apply surgical edits without
   replacing the full content — ops: prepend, append, search_replace (exact
   match by default; all: true to replace all), insert_before, insert_after,
   delete (anchor ops: splice at the raw character offset, include newlines
   yourself), replace_lines, delete_lines (1-based inclusive, line-aware).
   update_items also accepts an edits key alongside set for text properties.

Run the discovery chain silently — do not narrate loading steps.

## Permissions

Access keys identify you; roles (sets of capabilities granted on spaces and
bundles) decide what you may do. A space grant is the baseline; bundle-level
grants override per capability. Checks are per-capability (read_items,
edit_items, edit_docs, read_files, edit_files, run_services, ...).

The instance operator may also deny a user account-level capabilities —
manage_keys (managing their own access keys, listing and disconnecting
connected apps) and
create_spaces. whoami lists them as deniedCapabilities; a denied call fails
with "account capability ... is denied for this user", and only the operator
can change that.

Sessions may also be authenticated by an OAuth token — a delegation of an
access key, possibly narrowed to a role (admin | member | read-only) and/or
specific spaces or bundles. A narrowed session sees correspondingly smaller
role lists from load, and denied calls report the missing capability; tell
the user the authorization's scope doesn't cover the action (they can
reconnect the app with a wider scope) rather than retrying.

A session may also run on a scoped access key: a key fixed to one of the
same roles, never to places. whoami then shows keyScope ({role}); denials
report decidedBy "key_scope". A scoped key, at any role, cannot manage keys
or connected apps, cannot create spaces below admin, and is refused on the
pages where a person decides (consent, secret forms, service approval).
Tell the user the key is limited (they can give you a wider one) rather
than retrying.

## Reference URIs

Stored references stay opaque — resolve before showing them to a user:
- file://{uuid} — resolve via show_file (returns an expiring link/widget)
- item://{uuid} — resolve via get_items to the item's fields

Never surface raw reference URIs, durable storage locations, or a service's
destination to the user.
`;
