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
  datatype). A property may declare config constraints, enforced on every
  write: text {pattern, enum}; number {min, max, decimals} (default 2 decimals,
  out-of-precision writes rejected); item {itemType} to pin the referent's
  type; any multi field {minItems, maxItems}; single-valued text/number
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
  leaves a reply in the Drafts folder for a human to send). Services are
  authored over REST only (edit_services); agents run them.
- **Run** — one execution of a service, and always asynchronous. run_service
  starts one and returns the run record; poll get_run until status is
  succeeded or failed. wait_ms folds the first poll into the dispatch — if the
  run finishes inside that window (capped server-side) the record comes back
  already terminal, otherwise it keeps going on the server and nothing is lost
  by giving up on the wait. A failed run is a record with status "failed" and
  an error string, not a call error, so read run.status before reporting
  success. list_runs is the bundle's run log. All three need run_services.
- **User doc** — account-level guidance attached to you, available across all
  your spaces. Docs flagged autoload are returned by load at session start.
- **Widget** — an interactive panel some results render inline (file cards,
  upload dropzones). Delivered as ui:// resources. On a widget-capable host,
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
   files (list_files, show_file, upload_request, upload_complete, delete_file),
   services (run_service, get_run, list_runs — fire_hook is a deprecated alias
   for run_service, kept until 1.0), and management — gated by the matching capability:
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

Service *authoring* is the one management action not available over MCP —
defining a service's driver configuration and secrets is REST-only by design
(edit_services); agents only run services (run_services).

Run the discovery chain silently — do not narrate loading steps.

## Permissions

Access keys identify you; roles (sets of capabilities granted on spaces and
bundles) decide what you may do. A space grant is the baseline; bundle-level
grants override per capability. Checks are per-capability (read_items,
edit_items, edit_docs, read_files, edit_files, run_services, ...).

Sessions may also be authenticated by an OAuth token — a delegation of an
access key, possibly narrowed to a role (admin | member | read-only) and/or
specific spaces or bundles. A narrowed session sees correspondingly smaller
role lists from load, and denied calls report the missing capability; tell
the user the authorization's scope doesn't cover the action (they can
reconnect the app with a wider scope) rather than retrying.

## Reference URIs

Stored references stay opaque — resolve before showing them to a user:
- file://{uuid} — resolve via show_file (returns an expiring link/widget)
- item://{uuid} — resolve via get_items to the item's fields

Never surface raw reference URIs, durable storage locations, or a service's
destination to the user.
`;
