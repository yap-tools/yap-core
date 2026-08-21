# The built-in `mail` driver

Yap ships a `mail` driver alongside `http`. It lets an agent read, search, flag, send, and draft email through one operator-configured IMAP/SMTP account — and the *service* decides which of those a given agent may do. A read-only mailbox, a triage assistant that can only propose replies, and a notifier that can send but not choose recipients are three services on the same driver.

The host, port, and credentials live encrypted in the service record and never reach the agent. Every connection goes through the same guarded egress door the `http` driver uses, so it is subject to the server's SSRF policy (`YAP_HOOK_ALLOW_HOSTS` to allowlist a private mail server); TLS is verified; credentials are never sent in the clear unless an operator explicitly says so for a lab server.

Nothing to install: a service with `"driver": "mail"` works on every instance. (The [`examples/drivers/smtp`](../examples/drivers/smtp) folder is something else — the minimal, send-only reference for what a driver written *outside* Yap looks like, kept for driver authors.)

## Configuration

```jsonc
{
  "user": "me@example.com",
  "pass": "app-password",                   // exactly one of pass / oauth2
  "from": "me@example.com",
  "name": "Me",                             // optional display name
  "imap": { "host": "imap.example.com", "port": 993 },        // optional block
  "smtp": { "host": "smtp.example.com", "port": 465 },        // optional block
  "drafts_folder": "Drafts",                // optional
  "sent_folder": "Sent",                    // optional
  "save_sent": false,                       // optional, default false
  "allow_plaintext_auth": false             // optional, default false
}
```

| field | meaning |
|---|---|
| `user` | Login name for both protocols. Required. |
| `pass` | Password or app password. Exactly one of `pass` / `oauth2`. |
| `oauth2` | `{ client_id, client_secret, refresh_token, token_url }` — the driver exchanges the refresh token for an access token (through the egress guard, cached until shortly before expiry) and authenticates with XOAUTH2 on both protocols. `token_url` must be https. |
| `from` | The address mail is sent as. Required. `name` is the optional display name. |
| `imap` | `{ host, port, security? }`. Needed by `folders`, `search`, `read`, `mark`, `draft`, by replies, and by `save_sent`. |
| `smtp` | `{ host, port, security? }`. Needed by `send`. At least one of `imap` / `smtp` is required. |
| `security` | `"tls"` (implicit TLS from the first byte), `"starttls"` (upgrade after the greeting; refused if the server does not offer it), or `"none"`. Defaults by port: 993 and 465 → `tls`, 143 and 587 → `starttls`, anything else → `tls`. `none` is never a default. |
| `allow_plaintext_auth` | Send credentials over a `security: "none"` connection. Lab servers only. |
| `drafts_folder` | Where `draft` writes. Default: the folder the server flags `\Drafts`, else a folder whose last path segment is `Drafts` (case-insensitive), else an error asking you to set this. |
| `sent_folder` / `save_sent` | With `save_sent: true`, every sent message is also appended (flagged `\Seen`) to `sent_folder`, discovered the same way via `\Sent` / `Sent`. The folder is resolved *before* the message is sent, so a missing folder fails the run before anything leaves; a failed append *after* delivery is logged, not failed, to avoid inviting a duplicate send. |

A malformed config is rejected at authoring time naming the field. Authoring also connects, negotiates TLS, authenticates, and logs out of every configured block — so a wrong password fails when the service is authored (HTTP 400, `invalid config for driver "mail": imap: authentication failed …`), not on its first run.

### Provider matrix

| provider | auth | imap | smtp | notes |
|---|---|---|---|---|
| Fastmail | app password (`pass`) | `imap.fastmail.com` 993 | `smtp.fastmail.com` 465 | Create the app password in Settings → Privacy & Security → Integrations; scope it to Mail (IMAP/SMTP). |
| Gmail (personal) | app password (`pass`) | `imap.gmail.com` 993 | `smtp.gmail.com` 465 | App passwords require 2-Step Verification on the Google account. IMAP must be enabled in Gmail settings. |
| Google Workspace | `oauth2` | `imap.gmail.com` 993 | `smtp.gmail.com` 465 | `token_url`: `https://oauth2.googleapis.com/token`. An OAuth client with the `https://mail.google.com/` scope; the admin may need to allow it. Basic auth is disabled on Workspace. |
| Microsoft 365 | `oauth2` | `outlook.office365.com` 993 | `smtp.office365.com` 587 (starttls) | `token_url`: `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`. The app registration needs `IMAP.AccessAsUser.All` and `SMTP.Send`, and SMTP AUTH must be enabled on the mailbox. |
| Dovecot / self-hosted | `pass` | whatever the server offers | whatever the server offers | 993/465 implicit TLS or 143/587 STARTTLS; the certificate must verify. A private address needs `YAP_HOOK_ALLOW_HOSTS`. |
| GreenMail (lab) | `pass` | `greenmail` 3143, `security: "none"` | `greenmail` 3025, `security: "none"` | Set `allow_plaintext_auth: true`. The egress policy must allowlist the lab host. |

## Actions

Every parameter is a string; the driver parses numbers and dates.

| action | needs | params | result |
|---|---|---|---|
| `folders` | imap | — | `{ folders: [{ name, special_use?, messages? }] }` — `special_use` is one of `drafts`, `sent`, `trash`, `junk`, `archive`, `all`, `flagged`, `important`; `messages` is absent for folders that cannot be selected. |
| `search` | imap | `folder?` (INBOX), `query?` (anywhere in the message), `from?`, `to?`, `subject?`, `since?` / `before?` (`YYYY-MM-DD`, calendar days as IMAP defines them), `unseen?` (`"true"`), `limit?` (default 20, max 100) | `{ folder, uidvalidity, total, messages: [{ uid, date, from, to, subject, flags, size }] }` newest first. `total` is the number of matches; `messages` holds at most `limit`. `from`/`to`/`subject` are cut at 512 characters. |
| `read` | imap | `uid`, `folder?`, `max_chars?` (default 20 000, max 100 000) | `{ uid, folder, uidvalidity, message_id, in_reply_to, references, date, from, to, cc, subject, text, truncated, attachments: [{ filename, content_type, size }] }`. The best text part is fetched (text/plain, else text/html converted to text), capped at 512 KiB on the wire and `max_chars` in the result. Attachments are listed, never downloaded. Reading uses `BODY.PEEK`, so it does not mark the message seen. |
| `mark` | imap | `uid`, `flag` ∈ `seen` / `unseen` / `flagged` / `unflagged`, `folder?` | `{ uid, flags }` — the message's flags after the change. |
| `send` | smtp (+imap for `reply_to_uid` and `save_sent`) | `to` (comma-separated; required unless replying), `cc?`, `bcc?` (comma-separated; at most 50 recipients in all), `subject` (required unless replying), `body`, `reply_to_uid?`, `folder?` | `{ accepted: true, message_id }`. `bcc` recipients are on the envelope only, never in a header. If any recipient is refused, nothing is sent. |
| `draft` | imap | same as `send` | `{ folder, uid }` — `uid` is `null` when the server lacks UIDPLUS. Nothing is delivered; `bcc` is written as a `Bcc:` header, which is how a mail client carries it until the human sends. |

`reply_to_uid` fetches the original's `Message-ID`, `References`, `Subject`, `Reply-To` and `From` and sets `In-Reply-To` and `References` so the reply threads in every client; when `subject` is omitted it becomes `Re: <original subject>` (not doubled if the original already starts with `Re:`), and when `to` is omitted the reply goes to the original's `Reply-To`, else its `From`. A reply never adds `cc` on its own — reply-all is an explicit choice, made by supplying `cc`.

Non-ASCII search text is sent as a UTF-8 literal. IMAP allows one such literal per command, so only one of `from`/`to`/`subject`/`query` may contain non-ASCII text (or quotes) in a single search; a server that cannot search UTF-8 is reported as such.

## Three service shapes

The `actions` allowlist on the service record is what turns one driver into very different capabilities. An agent cannot see or call an action that is not listed.

**Reader** — can look, cannot change anything:

```
POST /v1/bundles/:id/services
{
  "name": "inbox",
  "driver": "mail",
  "actions": ["folders", "search", "read"],
  "config": { "user": "…", "pass": "…", "from": "me@example.com",
              "imap": { "host": "imap.fastmail.com", "port": 993 } }
}
```

**Triage** — reads, flags, and proposes replies; no mail leaves without a human:

```
{
  "name": "triage",
  "driver": "mail",
  "actions": ["search", "read", "mark", "draft"],
  "config": { "user": "…", "pass": "…", "from": "me@example.com",
              "imap": { "host": "imap.fastmail.com", "port": 993 } }
}
```

**Notifier** — can send, cannot aim:

```
{
  "name": "ops-alerts",
  "driver": "mail",
  "actions": ["send"],
  "pins": { "to": "ops@example.com" },
  "config": { "user": "…", "pass": "…", "from": "bot@example.com",
              "smtp": { "host": "smtp.fastmail.com", "port": 465 } }
}
```

A pinned parameter is injected server-side and never appears in the run record or the result; the agent supplies only `subject` and `body`. Pins are per parameter *name*, so on their own they would leave `cc` and `bcc` open — which is why the driver treats the three recipient fields as one: **pinning any of `to`, `cc`, `bcc` locks the others.** On such a service, supplying an unpinned recipient field fails with `recipients are fixed on this service; cc cannot be supplied`, and a reply may not derive `to` from the original message either (that would be aiming by proxy). The host tells the driver which parameters were pinned through `ctx.pinned`. Pin `to` and allow only `draft` for a service that may propose replies to one person and nothing else; leave all three unpinned for a service that may address mail freely.

Invoking:

```
run_service {"id": "inbox", "action": "search", "params": {"unseen": "true", "limit": "10"}, "wait_ms": 15000}
run_service {"id": "inbox", "action": "read", "params": {"uid": "4711"}}
run_service {"id": "triage", "action": "draft", "params": {"to": "alice@example.com", "reply_to_uid": "4711", "body": "Thanks — on it."}}
```

## Draft-for-approval

`draft` writes the message into the account's Drafts folder with the `\Draft` flag and threading headers intact. The human opens their usual mail client, finds the draft, edits it if they like, and presses send — or deletes it. There is nothing new to build or learn: the approval surface is the Drafts folder the user already has, the audit trail is the run record, and mail leaves only through a client the human controls. When the server supports UIDPLUS the result carries the new draft's `uid`, which a follow-up `read` in that folder can show.

## Limits and safety

- Results never contain config, credentials, hosts, or pinned values. Folder names and message ids are returned — the agent needs them to refer to things.
- `search` returns at most 100 summaries per call; `read` text is capped at `max_chars` (≤ 100 000) and the fetched section at 512 KiB, with `truncated: true` when either cap applied.
- Attachments are listed with name, type, and size, never fetched.
- Header injection is blocked: no CR/LF in any header-bound parameter (addresses, subject, display name). Bodies are normalised to CRLF and dot-stuffed on the wire so no line can impersonate the SMTP terminator.
- Credentials travel only over TLS unless `allow_plaintext_auth` is set; a server advertising `LOGINDISABLED`, or one that does not offer STARTTLS when `starttls` was configured, fails the run rather than downgrading.
- Every read races the run's abort signal; sockets are closed in `finally`; IMAP reply lines are bounded at 64 KiB and literals at 25 MiB.
- `search` and `read` results carry `uidvalidity` so a caller can detect a mailbox that was rebuilt between calls; a UID that vanished reads as "not found".
- Recipients are capped at 50 per message; an outbound `body` at 1 MiB (UTF-8 bytes); each free-text search criterion (`query`, `from`, `to`, `subject`) at 1000 characters.
- Configured `drafts_folder` / `sent_folder` names are refused at authoring time if they contain CR, LF, or NUL, and the IMAP layer refuses to quote such a string even if one got through.
- The OAuth2 token endpoint's response is read with a 64 KiB cap; an oversized body fails the refresh without any of it being surfaced.

### What the agent sees when a run fails

The runs layer shows an agent only the failures a driver raises as Yap's own errors; any other error collapses to a flat "run failed" on the run row, with the detail kept in the operator log. The mail driver raises an agent-visible error for what an agent can act on:

- `invalid_request`: a missing, malformed, or too-large parameter (uid, limit, max_chars, dates, flag, addresses, subject, body, search text, a header-bound value with a line break, a recipient field supplied on a service whose recipients are pinned, two non-ASCII criteria in one search); an action the service's account cannot do (`send` without an `smtp` block, a reply or `save_sent` without `imap`); an unknown action; no Drafts/Sent folder found (the error names the config field that settles it); a server that cannot search non-ASCII text; a replied-to message with no usable Reply-To or From; and a recipient the server refused — reported as exactly that, with neither the address (it may be pinned) nor the server's reply line, both of which go to the log.
- `not_found`: `folder "…" not found` (the name is the agent's own input) and `message <uid> not found` in the given folder.

Connection, TLS, authentication, and other protocol failures — and a service config that no longer validates — are never shown: their messages can name the host or carry a server reply, so they reach the operator log only.

## Trust model

The mail driver is part of the server, so it carries the server's trust. The egress guard protects against hostile *parameters* flowing through it — an agent cannot point the account at a different host, because the host is config — and the action allowlist plus pins decide what an agent may do with the account at all. The driver's errors and logs redact credentials and message bodies; the server's reply lines (which can echo an address) survive only in the operator log. See [SECURITY.md](../SECURITY.md).
