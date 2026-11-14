# Item links and their target type

A property of datatype `item` holds a link to another item in the same bundle
(`item://<id>`). It may pin the type of item it links to with
`config.itemType`:

```json
{ "name": "project", "datatype": "item", "config": { "itemType": "Project" } }
```

## How the target is stored

Every save stores the target as the **id** of the item type, never its name. That is
what keeps a link pointing at the same type when the type is renamed, and what
stops a different type that later takes the old name from becoming the
target.

- **On save** — `create_item_type`, `add_property`, `update_property` (when
  the patch carries a `config`) and bundle creation with seeded item types,
  over REST and MCP alike — `config.itemType` may be given as the id or as the
  name of an item type in the property's own bundle. A name is resolved to the
  id once, at that moment, and the id is what gets stored. A value that
  matches no item type in the bundle is refused with a validation error that
  names the property and the value. Links never cross bundles: an item type
  of another bundle is refused, by id or by name.
- **Bundle creation in one call.** Seeded item types can link to each other,
  in either order and to themselves, by name, before any of them has an id.
  The whole design is validated before anything is written, so a target that
  is not one of the call's own types refuses the call and no bundle is
  created. Core then writes every item type first and the properties after,
  with their targets resolved to the new ids. (Bundle creation is not a
  database transaction: a storage failure part-way through can still leave a
  partial bundle, as before. Link resolution adds no new way for that to
  happen, because it cannot fail once validation has passed.)
- **On read** — REST schema responses, the MCP `load_bundle` output and every
  other read path return `config.itemType` as stored: the id, except for the
  rows the upgrade below had to leave alone, which still read back as the
  name they hold. `load_bundle` lists each item type's `id` next to its
  `name`, so a client can map one to the other.
- **`update_property` without a `config`** (a rename, a reorder, a flag
  change) leaves the stored config as it is. Only a patch that carries a
  `config` resolves its target.
- **On an item write** — a link value is checked against the pinned type by
  id. If the pin cannot be met, the error names the target type by its
  current name: `property "project" must reference an item of type "Project"`.

The implementation lives in `src/core/linkTargets.ts`.

## Upgrading an existing instance

Before this change Core stored `config.itemType` exactly as the caller sent
it, usually a name, and resolved it by name on every item write. A link whose
target type had been renamed then failed every write of a non-empty value.

On every start, right after the schema migrations, the server runs a link
target upgrade (`upgradeLinkTargets`, called from `src/serve.ts`):

- **What changes.** For each property of datatype `item` whose
  `config.itemType` is not the id of an item type in the property's own
  bundle: if exactly one item type in that bundle has that value as its name
  today, the value is rewritten to that type's id. Only that one value in the
  `config` column changes: the rewrite runs only on a config stored in the
  exact form Core writes it (compact JSON), so the rest of the text stays
  byte-for-byte the same. Each row is written only if, at that moment, it
  still holds the config that was read and the target type still has that
  name; a row that changed in between is skipped and looked at again on the
  next start.
- **What does not change.** Item values, other properties, other datatypes,
  constraints and the schema are never touched; no property is deleted. Rows
  that already hold an id are skipped, so running it again changes nothing.
- **Backup first.** When there is at least one row to rewrite and
  `YAP_BACKUP_BEFORE_MIGRATE` is on (the default), the server writes a
  `pre-migration` backup before the first rewrite, unless it already wrote
  one for schema migrations on the same start. If that backup fails, nothing
  is rewritten and the server refuses to start, as it does for schema
  migrations.
- **Rows left alone.** A value that matches no item type in the bundle (the
  type was renamed or deleted), or that is the name of a type in another
  bundle, is left exactly as it is and logged as a warning on every start,
  with the bundle, item type, property and stored value. So is a config that
  is not readable JSON, and one that resolves but is not in the form Core
  writes (say, hand-edited with extra spaces). Fix one by setting
  the target with `update_property` (`config: { "itemType": "<name or id>" }`).
  Until then it behaves as before: item writes resolve it by id first, then by
  name.
- **Restoring older backups.** A backup taken before this change carries
  names. Restore loads rows verbatim at the archive's schema position; the
  next server start migrates forward and runs the same upgrade, so the
  restored instance ends with ids by the same rule.
- **Clients that read the pin.** A client that read `config.itemType` from a
  schema response or from `load_bundle` and expected a name now gets an id.
  Map it through the item types' `id` and `name`.

### One case the upgrade cannot repair

If an item type was renamed or deleted and a different type later took its
old name, a link that still holds that name now silently points at the new
type. The upgrade cannot tell this apart from a link that was always meant
for that type, so it binds the link to the type that holds the name today.
This is exactly what Core already did on every item write, so behaviour does
not change on upgrade, but the earlier mix-up is not repaired. If you have
renamed item types that links pointed at, check those link properties after
upgrading.
