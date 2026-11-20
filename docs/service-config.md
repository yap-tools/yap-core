# Service config: settings and secrets

A service is a driver plus a config. When the driver publishes a [config schema](driver-config-schema.md), Core stores that config in two parts, split along the schema's secret paths:

- **Settings**: every field that is not at a secret path. Stored as plain JSON and returned to the service's authors, so an author can read what a service is set up to do and change it.
- **Secrets**: only the values at secret paths. Encrypted at rest with `YAP_MASTER_KEY` (AES-256-GCM) and write-only. A read tells you which secret paths hold a value, never the value.

When the service runs, the two parts are merged back into one config object. The driver gets exactly the object it would have got before, so drivers need no change.

A driver without a schema keeps the whole config as one encrypted blob. It runs as before, nobody can read it back, and an update replaces it whole.

The code is in `src/core/serviceConfig.ts`.

## An example

The built-in `http` driver marks `headers.*` as secret: every header value. A service authored with

```json
{
  "url": "https://api.example.com/notify",
  "method": "POST",
  "headers": { "authorization": "Bearer <token>" },
  "body_json": { "text": "{{message}}" }
}
```

reads back to its authors as

```jsonc
{
  "id": "…", "name": "notify", "driver": "http", "actions": [ … ],
  "settings": {
    "url": "https://api.example.com/notify",
    "method": "POST",
    "headers": {},
    "body_json": { "text": "{{message}}" }
  },
  "secretsSet": ["headers.authorization"]
}
```

`secretsSet` lists the secret paths that hold a value, with map keys spelled out (`headers.authorization`, not `headers.*`), sorted.

## Who sees what

| Caller | Sees |
|---|---|
| Holds `edit_services` on the bundle | id, name, description, driver, actions, plus the record's `params` and `pins`, `settings` and `secretsSet`. Returned by `GET /v1/bundles/:id/services`, by MCP `get_service`, and by the create and update calls on both surfaces. |
| Any other reader of the bundle, and `load_bundle` for everyone | id, name, description, driver and actions, as before. No settings: they can carry a destination host or an account name, which an agent running the service does not need. |
| Nobody | A secret's value. It leaves the database only inside a run, in memory. |

`settings` and `secretsSet` are `null` when the config is one sealed blob: the driver has no schema, or the boot split (below) left the service alone.

## Writing a config

`POST /v1/bundles/:id/services` and `PATCH /v1/services/:id` take `config` as before: the full config object, secrets and all. Over MCP, `create_service` and `update_service` take the same object as `settings`, without the secrets: a value at a secret path is refused there, and secrets are entered through a secret form instead. See [mcp-service-authoring.md](mcp-service-authoring.md).

For a driver with a schema, a `PATCH` with `config` works like this:

- The **settings** in it replace the stored settings whole.
- The **secrets** in it are applied path by path on top of the stored ones. A value sets that secret, `null` removes it, and a secret the write leaves out is **kept**, as long as the object that holds it is still in the new settings.
- Leaving out (or nulling) an object removes the secrets inside it. That is how a block is dropped.

So an author can take the `settings` a read returned, edit them, and send them back as `config` without the credentials, and the service keeps its credentials: the read returns every object that holds a secret (`"headers": {}` for http, `"oauth2": {"client_id": …}` for mail). To change a credential, send its new value at its path. To switch a mail service from a password to OAuth, send the `oauth2` block and `"pass": null`; to switch back, send `pass` and no `oauth2`.

The driver's own `validateConfig` (and `validateConfigOnline`) checks the merged config, the one its runs will get. When that check fails and stored secrets were carried over, the error says which ones, because the complaint may be about a secret the author did not send this time:

```
invalid config for driver "mail": … (checked with the stored secrets this write left out: pass; set a secret path to null to remove it)
```

A config whose shape breaks a secret path (a string where the schema says `headers` is a map of values) is refused, naming the path. A `PATCH` without `config` leaves both parts alone.

The legacy `PATCH /v1/hooks/:id` keeps its old contract: its `transport` replaces the whole config, headers included. So does any write to a service whose sealed config cannot be read or split (see below): there are no stored secrets to keep.

## Storage

Three columns on `services`:

| Column | Holds |
|---|---|
| `config_encrypted` | The whole config, encrypted. Written on every config change, also for split services, so a release from before the split still runs every service after a rollback. Not read for a split service. To be dropped in a later release. |
| `settings` | The settings as JSON, or null while the config is one sealed blob. |
| `secrets_encrypted` | The secrets as an encrypted JSON object of the same shape as the config (only the secret paths), or null with `settings`. |

A service is split when `settings` is not null. Backups carry all three columns.

## The boot split

On every start, after the operator's drivers are loaded, Core decrypts the sealed config of every service whose driver publishes a schema and splits it by that schema:

- A service **not yet split** gets `settings` and `secrets_encrypted` written for the first time.
- A **split** service whose parts still match is not touched. That is every service this release wrote, so a second start changes nothing.
- A **split** service whose parts no longer match has them rebuilt from the sealed config, with a warning. That happens when a release from before the split edited the service after a rollback (it writes only `config_encrypted`), and when the driver's secret paths changed, so a field newly marked secret leaves the readable settings.

It never changes `config_encrypted` or the service's `updatedAt`. It leaves a service not yet split exactly as it is, and logs it with its id, name and bundle, when:

- its driver is not installed (warning);
- its driver publishes no schema (info: a supported state, logged on every start);
- its config cannot be decrypted with the current `YAP_MASTER_KEY`, is not JSON, or is not a JSON object (warning);
- its config has a non-object where a secret path goes through an object, so Core cannot tell whether that value is a secret (warning, naming the path).

A service left alone keeps running from its sealed config, as before. When a driver ships a schema in a later version, the next start splits its services. A split service whose driver is uninstalled or drops its schema keeps running from its parts.

When there is something to split, the pre-migration backup (`YAP_BACKUP_BEFORE_MIGRATE`) is taken first, if it was not already taken for a schema migration on the same start. If the split cannot complete (a database error, or that backup failing), the server refuses to start; nothing it could not split has been changed.

### First start after upgrading

On an instance upgraded from a release before the split:

1. The pre-migration backup is written and migration `0013_service_config_split` adds the two nullable columns.
2. Every `http` and `mail` service, and every service on an installed driver with a schema, is split. The log says `service configs: split N services into settings and secrets`, followed by one line per service left alone.
3. Services run exactly as before.
4. Everyone holding `edit_services` on a bundle can now read the settings of its services: every field the driver does not mark secret. Before, nobody could read a config back. For `http` that includes the URL and the body; for `mail`, the account name, hosts and addresses. An http service that carries a token in its URL or body rather than in a header now shows that token to those callers: move it into a header.

Nothing else needs doing by hand. Rolling back to the earlier release works: it reads `config_encrypted`, which stays current. Edits made while running it are picked up on the next start after upgrading again.
