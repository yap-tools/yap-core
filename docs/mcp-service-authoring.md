# Authoring services over MCP

An agent with `edit_services` on a bundle can create, change and delete that bundle's services over MCP. Everything about a service passes through the agent except its secrets: those go from a human straight to the server through a one-off form. The agent sees which secrets are set, never a value. And a service the agent writes does not run until a person approves it on a one-off approve page ([service-approval.md](service-approval.md)).

This builds on the split of a service's config into settings and secrets ([service-config.md](service-config.md)), which in turn relies on the driver's config schema ([driver-config-schema.md](driver-config-schema.md)). REST authoring is unchanged: an author there sends the whole config, secrets included.

The code is in `src/core/services.ts` (the `authoring: "mcp"` path), `src/core/secretRequests.ts` (the form), `src/core/serviceApprovals.ts` (the approve page) and `src/widgets/registry.ts` (the `secret-input` and `service-approve` widgets).

## The tools

All are second-tier `call` tools on a bundle.

| Tool | Needs | Does |
|---|---|---|
| `get_service` `{id}` | read access | One service by name or id. To an `edit_services` holder: id, name, description, driver, actions, `approved`, plus the record's `params` and `pins`, `settings`, `secretsSet`, `approvedAt` and `approvedBy`. To anyone else: the listing view, as in `load_bundle`, which includes `approved`. |
| `create_service` `{name, driver?, description?, params?, pins?, actions?, settings}` | `edit_services` | Creates a service from its settings. It waits for approval. |
| `update_service` `{id, name?, description?, params?, pins?, actions?, settings?}` | `edit_services` | Changes a service. `settings` replaces the stored settings. A change to what it does or where data goes puts it back to waiting. |
| `delete_service` `{id}` | `edit_services` | Deletes a service, with its schedules, open forms and approve pages. Its runs stay. |
| `secret_request` `{id, paths?}` | `edit_services` | Opens a form for some of the service's secrets. |
| `approval_request` `{id}` | `edit_services` | Opens an approve page for a service that waits. |

`load_bundle` stays as it was: it lists services without settings. An agent reads a service with `get_service` before it changes it.

## Settings only

`create_service` and `update_service` take `settings`: the driver's config with the secrets left out. A value at any path the driver marks secret is refused:

```
settings.headers.authorization holds a secret value (driver "http" marks it secret). Secrets are never sent
through MCP: leave them out (null removes a stored one) and call secret_request, which gives the user a
one-off form that sends them straight to the server.
```

`null` at a secret path is allowed: on an update it removes that stored secret (switching a mail service from a password to OAuth sends `"pass": null`). An update's settings replace the stored ones, and a stored secret is kept as long as the object holding it is still in them, so sending back what `get_service` returned keeps every credential.

### A secret stays where it was entered

The agent never sees a secret, but without a further rule it could still send one somewhere: change an http service's `url` to a server it controls, keep the header, and run the service. So a driver binds each secret to the settings that decide where it goes (`boundTo` in its config schema; see [driver-config-schema.md](driver-config-schema.md#bindings)). When an MCP update changes any of them, the secrets bound to it are dropped, and `secretsSet` in the result no longer lists them. A human enters them again through a new secret form, which shows them the service they are entering them for.

| Driver | Secret | Dropped when this changes |
|---|---|---|
| `http` | every header value | `url` |
| `mail` | `pass` | `imap`, `smtp`, `allow_plaintext_auth` |
| `mail` | `oauth2.client_secret`, `oauth2.refresh_token` | `oauth2.token_url`, `imap`, `smtp`, `allow_plaintext_auth` |

Any other change (the method, the body, the from address) keeps them. Pins are not settings and are not bound: an http pin fills a placeholder in the path, query or body, never the host. REST updates keep the old behaviour, because the REST author sends the secrets themselves.

Two kinds of service cannot be authored over MCP at all, only over REST: one whose driver publishes no config schema (Core cannot tell its settings from its secrets), and one whose config is stored as a single sealed blob because the boot split could not split it. Either can still be deleted over MCP.

### Checking a config that has no secrets yet

A new service usually has none of its secrets when it is created. The driver's `validateConfig` would refuse it for that alone (the mail driver requires a password or an OAuth block), so over MCP the check runs as if the missing secrets were filled in with a placeholder:

1. First with only the secrets inside a nested object the agent sent (an `oauth2` block's `client_secret` and `refresh_token`).
2. Then with every missing secret, top-level ones too (`pass`).

The config is accepted when either passes. Two tries and not one because a driver may take one of several credentials, and filling both would break its own "exactly one" rule. A map path like `headers.*` names no key, so it is never missing. When the check fails, the error says which secrets were treated as filled in.

The config as it stands is checked first, so a complete config (a mail service with a whole `oauth2` block, which has no `pass`) counts as needing nothing. The driver's online check (`validateConfigOnline`; for http, the SSRF guard on the destination) needs the real config, so it runs only once nothing is missing: at authoring when no secret is missing, otherwise on the form submission that completes it. The http driver has no secret that can be missing, so its SSRF check always runs at authoring.

## The secret form

`secret_request` reserves a row in `secret_requests` for the service and the paths asked for, and returns:

```jsonc
{
  "request_id": "…",
  "service": { "id": "…", "name": "notify" },
  "fields": [
    { "path": "headers.authorization", "label": "Header value", "description": "…", "set": false }
  ],
  "expires_in": 600,
  "origin_url": "<BASE_URL>/w/secret-input?token=…"
}
```

with a `secret-input` widget pointer in `_meta`. On a widget-capable host the agent renders it with `show_widget(widget="secret-input", params=<_meta.data>)`; anywhere else it gives the user `origin_url`, a signed page with the same form.

In a host's frame the widget's data came through the model, so the widget shows none of it as given: it calls `POST /v1/secret-requests/:id/view {token}` and shows what the server returns, and it posts only to the instance its HTML was served by (`window.__YAP_BASE__`), never to a URL from its data. A steered agent can neither change what the person reads nor send the form to a server of its own.

`paths` names concrete secret paths. A map path is named with its key: `headers.authorization`, not `headers.*`. Left out, it defaults to the secrets the service still lacks, worked out the way authoring checks a config (above): of the ways to fill in what is missing, the first the driver accepts. A mail service on a password gets `pass`; one with an `oauth2` block gets `oauth2.client_secret` and `oauth2.refresh_token`, and not `pass`. A service that lacks nothing gets every secret it holds, to replace them. A map path is never a default, so an http form always names its header.

The form shows the service name, then where the secrets will be sent, then one password field per path, with the driver's label and description, saying when a path is already set, and last a field for the person's access key. "Where they will be sent" is every setting the requested secrets are bound to (`boundTo`), with the service's pins filled in: an http header shows the URL it goes to, a mail password the IMAP and SMTP servers. The same list is in the widget data and the view as `destinations` (see [service-approval.md](service-approval.md#destinations)). It POSTs straight to the server:

```
POST /v1/secret-requests/:id/submit
{ "token": "<the form's own signed token>", "access_key": "<the person's access key>",
  "values": { "headers.authorization": "Bearer …" } }
→ 200 { "saved": true, "paths": ["headers.authorization"] }
```

On success it shows "Saved" and nothing else. The token travels in the body, not the URL, so it stays out of access logs. The value never passes through the host or the model.

### Rules

- **A login.** Saving needs the person's full user access key in the body, checked by the same `pageLogin` as the service approve page ([service-approval.md](service-approval.md#who-may-approve)): the sysadmin key, an OAuth token and a scoped access key are refused (401), and the person must hold `edit_services` on the bundle (403), plus `edit_items` / `edit_files` for a driver that writes into it. The agent sees the form's token in `_meta`, so without the login it could enter a secret of its own (a bearer token for its own account at an approved API) into a service a person approved, and entering a secret does not take the approval away. With it, every stored secret is one a person entered. The row records who (`submitted_by`). A refused login leaves the form open.
- **One submission.** A form takes one successful submission. A second gets 409. Two submissions racing on one form store one set of values: the claim is a conditional update in the same transaction as the secret write.
- **Expiry.** A form expires after `YAP_SECRET_REQUEST_TTL_SECONDS` (default 600, the same as an upload link). An expired form gets 401, on submission and on its page. Expired rows are swept whenever a new form is asked for.
- **A refused submission leaves the form open.** Each submission runs the driver's checks on the config the service will now run with (the online one once nothing is missing). If they refuse it (400, with the driver's message), or the service changed while the form was open (409), nothing is stored and the same form can be submitted again.
- **The listed paths only.** A submission sets the paths it sends and leaves every other secret and setting as it is. A blank field is not sent, so it keeps what is stored. Asking for a new form for the same path and submitting it replaces that secret.
- **The requester is re-checked.** The token stands for the user who asked for the form. If they no longer hold `edit_services` on the bundle (or, for a driver that writes into the bundle, `edit_items` / `edit_files`; see below), the submission gets 403.
- **Expiry is checked again when the form is used**, inside the same transaction, so a submission that started just before the form expired and spent a while in the driver's online check is refused rather than stored.
- **A config change closes the service's open forms**, on either surface: a form delivers a secret only to the service as it was when the user was handed it, never to a destination changed since. Closed forms answer 401 like expired ones; ask for a new one.
- **Deleting the service deletes its forms.**

Storage is the same as for any split service: the values are encrypted into the service's secrets, the objects that hold them are added to the settings if missing (so `get_service` shows `"headers": {}`), and the sealed whole-config column stays current.

## Writes into the bundle

A run writes into its bundle with the service's authority, not the runner's: a driver that declares `writes.items` creates items without the runner holding `edit_items`. That was safe while only operators authored services. Now that any `edit_services` holder can, the author vouches for those writes: creating or changing a service whose driver declares `writes.items` needs `edit_items` on the bundle as well as `edit_services`, and `writes.files` needs `edit_files`. The rule applies on REST too, so a service's reach does not depend on which surface wrote it, and to asking for and submitting a secret form, which change the service as an update does. The built-in mail driver declares `writes.files` (its `attachment` action).

## Approval

A service written over MCP is off until a person approves it: `run_service` and schedules refuse it, and listings show `approved: false`. `update_service` that changes params, pins, actions, settings or which secrets are set turns it off again; renaming it, sending back what is stored, or entering a secret through the form does not. `approval_request` gives the person a page that shows the service as the server has it, where data goes first, and approves it once they log in with a full (unscoped) access key and hold `edit_services`. The full rules, and the known limit for an agent that holds a raw access key, are in [service-approval.md](service-approval.md).

## A worked example

An agent sets up an http service that posts to an API with a bearer token:

1. `create_service` `{name: "notify", driver: "http", params: [{name: "text", required: true}], settings: {url: "https://api.example.com/notify", method: "POST", headers: {}, body_json: {text: "{{text}}"}}}`. The SSRF check runs on the URL. `secretsSet` is `[]`.
2. `secret_request` `{id: "notify", paths: ["headers.authorization"]}`. The agent shows the widget or gives the user the link.
3. The user types `Bearer <token>` into the field, enters their access key, and saves.
4. `get_service` `{id: "notify"}` shows `secretsSet: ["headers.authorization"]`.
5. `run_service` `{id: "notify", params: {text: "hello"}}` is refused: the service waits for approval.
6. `approval_request` `{id: "notify"}`. The agent shows the widget or gives the user the link.
7. The user reads where the service sends data, enters their access key and approves.
8. `run_service` `{id: "notify", params: {text: "hello"}}` sends the header.
