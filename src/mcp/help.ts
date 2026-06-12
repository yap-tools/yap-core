/** Static reference documentation returned by the `help` tool. */

export const HELP_TEXT = `# Yap reference

Yap stores navigable context. The tree: context (root) → spaces → bundles.
A bundle holds docs, item-types (schemas with items), static files, and hooks.

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
  write: text {pattern}; number {min, max, decimals} (default 2 decimals,
  out-of-precision writes rejected); item {itemType} to pin the referent's
  type; any multi field {minItems, maxItems}. Query multi fields with the set
  operators has/has_any/has_all/has_none, or a comparison op with a quantifier
  (any/all/none).
- **Hook** — a named outbound HTTP call owned by a bundle. You see only the
  hook's name, description, and declared parameters — never its URL, headers,
  or secrets. Firing requires the fire_hooks capability. Hooks are authored
  over REST only.
- **User doc** — account-level guidance attached to you, available across all
  your spaces. Docs flagged autoload are returned by load at session start.
- **Widget** — an interactive panel some results render inline (file cards,
  upload dropzones). Delivered as ui:// resources via result metadata,
  show_widget, or origin-hosted fallback links.

## How to work

1. **load** — discover your spaces (id, name, description, keywords, role,
   and the names of the bundles inside). Match the user's intent against this
   metadata instead of opening everything; if several spaces could match, ask
   the user. Autoloading user docs and the current time arrive here too.
2. **load_space(space_id)** — the space's instructions and its bundles.
3. **load_bundle(bundle_ids)** — required before calling into a bundle:
   returns docs (autoloaded ones in full — follow them; list and fetch the rest
   with read_docs), item-type schemas, files, and hooks.
4. **call(space_id, calls)** — execute. Batch related operations in one
   round trip; each call succeeds or fails independently. A call targets a
   bundle (provide bundle_id) or the space (omit bundle_id). Second-tier tools:
   items (query/get/create/update/delete), docs (read/create/update/delete), files
   (list_files, show_file, upload_request, upload_complete, delete_file),
   hooks (fire_hook), and management — gated by the matching capability:
   spaces (update_space/delete_space, manage_space), roles
   (list_grants/grant_role/revoke_grant, manage_roles), bundles & schemas
   (update_bundle/delete_bundle, create/update/delete_item_type,
   add/update/delete_property, edit_bundles).

Hook *authoring* is the one management action not available over MCP — defining
a hook's destination and secrets is REST-only by design; agents only fire
hooks (fire_hooks).

Run the discovery chain silently — do not narrate loading steps.

## Permissions

Access keys identify you; roles (sets of capabilities granted on spaces and
bundles) decide what you may do. A space grant is the baseline; bundle-level
grants override per capability. Checks are per-capability (read_items,
edit_items, edit_docs, read_files, edit_files, fire_hooks, ...).

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
- hook://{uuid} — an invokable hook; call it by name via fire_hook

Never surface raw reference URIs, durable storage locations, or hook
transports to the user.
`;
