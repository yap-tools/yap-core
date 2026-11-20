# Service approval

A service written over MCP does not run until a person approves it. A service can send data out of the instance, and an agent can be steered by something it read, so over MCP the agent proposes and a person decides.

This sits on top of MCP authoring ([mcp-service-authoring.md](mcp-service-authoring.md)): the agent writes the settings, a person enters the secrets through a secret form, and a person approves the result through an approve page. The code is in `src/core/serviceApprovals.ts` (requests, the view, the decision), `src/core/services.ts` (setting and clearing the state), `src/core/runs.ts` (`prepareRun`, the gate) and `src/widgets/registry.ts` (the `service-approve` widget).

## The state

Two columns on the service: `approved_at` (when a person last approved it as it stands, or null) and `approved_by` (their user id). A service with `approved_at` null is *waiting*.

| Write | Effect |
|---|---|
| `create_service` over MCP | waiting |
| `update_service` over MCP that changes params, pins, actions, settings, or which secrets are set | waiting again |
| `update_service` over MCP that renames or re-describes it, or sends back what is stored | unchanged |
| A secret entered through a secret form (which needs the person's login) | unchanged |
| Create over REST (`POST /v1/bundles/:id/services`) | approved, by the author |
| Update over REST that sends `config` | approved, by the author |
| Update over REST without `config` | unchanged |
| Services that existed before migration 0015 | approved (backfilled with their `updated_at`) |

A REST author sends the whole config, secrets included, so their write is their approval. The MCP comparison is of what an approval covers: params, pins, the allowlist, settings, and the list of set secret paths. Sending back exactly what `get_service` returned changes none of them. A secret dropped because the setting it is bound to moved (`boundTo`) changes the list, so that write also puts the service back to waiting.

Listings say where a service stands: `approved` (true or false) in every service listing, including `load_bundle` and `get_service` for a runner, and `approvedAt` / `approvedBy` in the author's view (REST listing to `edit_services` holders, MCP `get_service`).

## The gate

`prepareRun` refuses a waiting service before it looks at anything else:

```
service "notify" is waiting for approval: it was written or changed over MCP, and it does not run until a
person who holds edit_services on this bundle approves it (approval_request gives them the page)
```

The error is `forbidden` (403 over REST). Every run goes through `prepareRun` (`run_service`, `POST /v1/services/:id/run`, the `fire_hook` alias), and so does creating a schedule or changing what one runs. A schedule that already exists keeps its cron: while its service waits, each fire records the refusal in the schedule's `lastError` and starts no run. Once the service is approved again, the next fire runs.

## Asking for approval

`approval_request {id}` (MCP, `edit_services`), or `POST /v1/services/:id/approval-request` (REST, the same gate), reserves a row in `service_approvals` and returns:

```jsonc
{
  "request_id": "…",
  "service": { "id": "…", "name": "notify" },
  "expires_in": 600,
  "origin_url": "<BASE_URL>/w/service-approve?token=…"
}
```

with a `service-approve` widget pointer in `_meta` over MCP. The widget's data is `{ request_id, token }` and nothing else. A service that is approved already is refused (`invalid_request`). The page expires after `YAP_SECRET_REQUEST_TTL_SECONDS`, the same as a secret form, and takes one decision. Expired rows are swept when a new one is asked for.

The agent should enter the secrets first, so the page shows them as set.

## The page

The page shows the service as the server has it, never as the agent describes it:

1. **Where data goes**, first and boxed: the driver's `destinations` (below), with the service's pins filled in and what a run chooses named.
2. The driver, its description, and whether it writes items or files into the bundle.
3. The allowed actions, each with the parameters a run supplies.
4. Pinned parameters and their values.
5. The settings, as JSON.
6. Which secret paths are set: names only.

Then an access-key field and two buttons, Approve and Reject.

On its origin page the view is built at serve time. In a host's frame the widget's data came through the model, which could put anything in it, so the widget ignores everything but `request_id` and `token` and fetches the view itself:

```
POST /v1/service-approvals/:id/view     { "token": "…" }  →  { "view": {…}, "fingerprint": "…" }
POST /v1/service-approvals/:id/decide   { "token": "…", "decision": "approve" | "reject",
                                          "access_key": "…", "fingerprint": "…" }
                                        →  { "decision": "approved" | "rejected", "service": { "id", "name" } }
```

Both are public routes gated by the page's own signed token, sent in the body so it stays out of access logs. The widget sends them only to the instance its HTML was served by (`window.__YAP_BASE__`, baked in by the server), never to a URL from its data, so a steered agent cannot point the access-key field at a server of its own. The secret form follows the same rule (see below).

### Who may approve

- **A login, not the link.** Approve needs a user access key in the body, checked by `pageLogin` (`src/core/keys.ts`), the same login the OAuth consent screen and the connected-apps page use. The sysadmin key is refused (an operator credential, not a person). An OAuth access token is refused, so an agent connected over OAuth, which holds a token and never the key, cannot approve its own service.
- **The right person.** The key's user must hold `edit_services` on the bundle, plus `edit_items` / `edit_files` for a driver that writes into it, as an author must: approving is vouching for the service.
- **Refusals leave the page open.** A missing or wrong key (401), a user without the capability (403) or a stale page (409) change nothing, and the same page can be used again.

Core has no delegated login of its own; where a client logs a person in some other way, it can open the same page. If Core gains another login method for the consent screen, it goes into `pageLogin` and the approve page gets it too.

### Known limit

An agent that holds a raw access key itself (a key pasted into its MCP configuration, a script that runs with one) can open the page and approve with that key, and enter secrets on a form with it. That is discouraged, not prevented. Passkeys and a separate approval key were considered and not taken. The MCP help says this plainly.

### Approving what was shown

The view carries a fingerprint: a SHA-256 of the view (everything but the `approved` flag), in canonical JSON. Approve sends it back. The server builds the view again, compares, and refuses with 409 if they differ. It then writes the approval inside one transaction that also claims the page, and only onto the row it read (`updated_at` and the sealed config column unchanged), so a write landing in between fails the approval rather than approving something nobody saw.

An MCP write that puts the service back to waiting also deletes its open approve pages, so a page opened before the change answers 401 like an expired one. A secret replaced through the form changes no fingerprint, so a page stays good across a rotation; a secret newly set or removed changes the set paths the page showed, so the person reloads it and sees the new list.

The MCP update side has the matching guard: `update_service` decides whether a write keeps the approval against the row it read, and lands only on that row (`updated_at` and the sealed config column unchanged). A write in between (another update, a secret entered, an approval) fails it with 409, rather than letting a stale write keep an approval given to something else.

### Reject

Reject needs no login. It uses the page up and changes nothing else: the service stays off, and the page says so. To approve after a rejection, ask for a new page.

## Destinations

A driver says where its services send data in its config schema (`destinations`, see [driver-config-schema.md](driver-config-schema.md#destinations)): a setting (the http `url`, the mail `smtp` server) or a parameter (the mail `to` of `send`). `describeDestinations` turns them into what a person reads:

- a string setting with its `{{placeholders}}` filled from the service's pins; what is left is listed under `chosenPerRun`;
- a server block as `host:port (security)`;
- a parameter destination as the pinned value, or as chosen by whoever runs the service; one no allowed action takes is left out (a read-only mail service names no recipient);
- a setting that is not there (a mail service without `smtp`) is left out.

| Driver | Destinations |
|---|---|
| `http` | `url` |
| `mail` | `imap`, `smtp`, `oauth2.token_url`, and the `to`, `cc`, `bcc` of `send` |

An http pin can change the path or query on the approved host, never the host itself; the URL shown has the pins filled in, so the person sees the URL the service will call.

## The secret form needs the same login

The agent that asked for a secret form sees its token. If the token alone could save a secret, the agent could enter one itself, say a bearer token for its own account at the same API, into a service a person approved, and runs would send data into that account; since entering a secret keeps the approval, nothing would stop it. So saving a secret form needs the same login as approving: a user access key (`pageLogin`), whose user holds `edit_services` on the bundle. Every stored secret is then one a person entered, and keeping the approval across it is safe. Details in [mcp-service-authoring.md](mcp-service-authoring.md#rules).

## The secret form shows where its secrets go

The secret form uses the same helper for the settings each requested secret is bound to (`boundTo`): an http header shows the URL, a mail password the IMAP and SMTP servers (and `allow_plaintext_auth`). `secret_request`'s widget data carries them as `destinations`, and so does `POST /v1/secret-requests/:id/view {token}`, which the widget in a host's frame calls before showing anything. The form posts only to its own instance, like the approve page.
