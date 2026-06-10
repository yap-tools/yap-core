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
- **Docs** — a bundle's operating instructions. They are binding: read them
  via load_bundle and follow them while working in that bundle.
- **Item / item-type** — structured records conforming to per-bundle schemas.
  Properties are typed (text, number, boolean, date); writes are validated.
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

1. **load** — discover your spaces (id, name, description, keywords, role).
   Match the user's intent against this metadata instead of opening
   everything. Autoloading user docs arrive here too.
2. **load_space(space_id)** — the space's instructions and its bundles.
3. **load_bundle(bundle_ids)** — required before calling into a bundle:
   returns docs (follow them), item-type schemas, files, and hooks.
4. **call(space_id, calls)** — execute. Batch related operations in one
   round trip; each call succeeds or fails independently. Second-tier tools:
   items (query/get/create/update/delete), docs (read/update), files
   (list_files, show_file, upload_request, upload_complete, delete_file),
   hooks (fire_hook).

Run the discovery chain silently — do not narrate loading steps.

## Permissions

Access keys identify you; roles (sets of capabilities granted on spaces and
bundles) decide what you may do. A space grant is the baseline; bundle-level
grants override per capability. Checks are per-capability (read_items,
edit_items, edit_docs, read_files, edit_files, fire_hooks, ...).

## Reference URIs

Stored references stay opaque — resolve before showing them to a user:
- file://{uuid} — resolve via show_file (returns an expiring link/widget)
- item://{uuid} — resolve via get_items to the item's fields
- hook://{uuid} — an invokable hook; call it by name via fire_hook

Never surface raw reference URIs, durable storage locations, or hook
transports to the user.
`;
