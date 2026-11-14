# The built-in `mail` driver

Yap ships a `mail` driver alongside `http`. It lets an agent read, search, flag, send, draft, and delete drafts through one operator-configured IMAP/SMTP account, download an attachment into the service's bundle, and attach files from that bundle to a draft or a sent message — and the *service* decides which of those a given agent may do. A read-only mailbox, a triage assistant that can only propose replies, and a notifier that can send but not choose recipients are three services on the same driver.

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
| `imap` | `{ host, port, security? }`. Needed by `folders`, `search`, `read`, `attachment`, `mark`, `draft`, `delete_draft`, by replies, and by `save_sent`. |
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
| `read` | imap | `uid`, `folder?`, `max_chars?` (default 20 000, max 100 000) | `{ uid, folder, uidvalidity, message_id, in_reply_to, references, date, from, to, cc, subject, text, truncated, attachments: [{ part, filename, content_type, size }] }`. The best text part is fetched (text/plain, else text/html converted to text), capped at 512 KiB on the wire and `max_chars` in the result. Attachments are listed, not downloaded: `part` is the attachment's IMAP section number (`"2"`, `"1.3"`), which is what `attachment` takes; `filename` is `null` when the sender gave none, and `size` is the encoded size on the server. Reading uses `BODY.PEEK`, so it does not mark the message seen. |
| `attachment` | imap | `uid`, `folder?`, `part` (from `read`'s `attachments`) | `{ uid, folder, part, filename, content_type, size, file }`. Downloads that one attachment, transfer-decoded, and stores it as a finalized file in the service's bundle; `file` is the stored file (`id`, `ref`, `name`, `mimeType`, `size`, …), ready for `show_file` or to put on an item. `size` is the decoded byte count. Uses `BODY.PEEK`, so the message is not marked seen. See [Downloading attachments](#downloading-attachments). |
| `mark` | imap | `uid`, `flag` ∈ `seen` / `unseen` / `flagged` / `unflagged`, `folder?` | `{ uid, flags }` — the message's flags after the change. |
| `send` | smtp (+imap for `reply_to_uid` and `save_sent`) | `to` (comma-separated; required unless replying), `cc?`, `bcc?` (comma-separated; at most 50 recipients in all), `subject` (required unless replying), `body`, `attachments?` (see [Attaching files](#attaching-files)), `reply_to_uid?`, `folder?` | `{ accepted: true, message_id }`, plus `attachments: [{ name, mime_type, size }]` when files were attached. `bcc` recipients are on the envelope only, never in a header. If any recipient is refused, nothing is sent. |
| `draft` | imap | same as `send` | `{ folder, uid }` — `uid` is `null` when the server lacks UIDPLUS — plus `attachments: [{ name, mime_type, size }]` when files were attached. Nothing is delivered; `bcc` is written as a `Bcc:` header, which is how a mail client carries it until the human sends. |
| `delete_draft` | imap with UIDPLUS | `uid` | `{ folder, uid }` — deletes exactly that UID from the resolved Drafts folder. There is deliberately no `folder` parameter, so the action cannot be aimed at any other mailbox. |

`reply_to_uid` fetches the original's `Message-ID`, `References`, `Subject`, `Reply-To` and `From` and sets `In-Reply-To` and `References` so the reply threads in every client; when `subject` is omitted it becomes `Re: <original subject>` (not doubled if the original already starts with `Re:`), and when `to` is omitted the reply goes to the original's `Reply-To`, else its `From`. A reply never adds `cc` on its own — reply-all is an explicit choice, made by supplying `cc`.

Non-ASCII search text is sent as a UTF-8 literal. IMAP allows one such literal per command, so only one of `from`/`to`/`subject`/`query` may contain non-ASCII text (or quotes) in a single search; a server that cannot search UTF-8 is reported as such.

## Downloading attachments

`attachment` is the one action that leaves something behind in Yap: every other read only returns a result, while this one writes a file into the bundle the service belongs to, where it stays until someone deletes it. Each call stores a new file, so downloading the same attachment twice gives two files. The driver declares `writes: { files: true }` for it; the service's `actions` allowlist still decides whether an agent gets the action at all, so adding it to the driver exposes nothing until an operator lists `attachment` on a service.

The flow is `read`, then `attachment` with a `part` from the list:

```
run_service {"id": "inbox", "action": "read", "params": {"uid": "4711"}}
  → … "attachments": [{ "part": "2", "filename": "invoice.pdf", "content_type": "application/pdf", "size": 48213 }]
run_service {"id": "inbox", "action": "attachment", "params": {"uid": "4711", "part": "2"}}
  → { "uid": 4711, "folder": "INBOX", "part": "2", "filename": "invoice.pdf", "content_type": "application/pdf", "size": 35189, "file": { "id": "…", "ref": "file://…", … } }
```

How a download works, and what it refuses:

- **Only listed attachments.** The driver fetches the message's BODYSTRUCTURE and looks `part` up among the parts `read` lists as attachments. The message's text body, a multipart container, `HEADER`, `TEXT`, or a part that does not exist is refused with `part "…" is not an attachment of message <uid>`; the agent's string never reaches the wire unless it equals a listed attachment's number. A forwarded message (`message/rfc822`) is one attachment and downloads whole, as an `.eml`.
- **Decoding.** base64 and quoted-printable are decoded; `7bit`, `8bit`, and `binary` are stored as they are. Any other transfer encoding (`x-uuencode`, say) is refused rather than stored undecoded.
- **Size.** At most 25 MiB after decoding. A part whose BODYSTRUCTURE size already rules that out is refused before anything is fetched. Otherwise the part is read in 4 MiB partial fetches (`BODY.PEEK[part]<offset.count>`), so no single literal approaches the 25 MiB transport cap, and reading stops — refused — as soon as the encoded bytes pass what a 25 MiB attachment could take in that encoding. A part the server returns shorter than its BODYSTRUCTURE size is refused as incomplete. A refusal stores nothing: a partial file is never written. The instance's own file limits still apply on top (`maxFileSizeBytes`, the MIME allowlist); their refusals reach the agent as they are.
- **Naming.** The stored file takes the attachment's own filename with control characters, bidirectional-override characters (which can make a name display as something it is not), and `/` `\` replaced by `_`, leading dots removed, and names over 255 characters shortened with the extension kept. A nameless attachment is stored as `attachment-<uid>-<part>.<ext>`, the extension taken from the content type (`bin` when nothing fits). The file's MIME type is the part's `type/subtype`, lowercased.

Not covered: downloading every attachment of a message at once, linking the stored file to an item (an agent can do that itself with the `file` it gets back), deduplicating repeat downloads, and walking into the parts of a forwarded message. (Putting files *on* a message is the other direction; see the next section.)

## Attaching files

`draft` and `send` take an optional `attachments` parameter: files from the service's bundle, as a comma-separated list of `file://{uuid}` references or bare file ids. Whitespace around entries is ignored, and so are empty entries; naming the same file twice (a bare id and its `file://` form count as the same) is refused.

```
run_service {"id": "triage", "action": "draft", "params": {"to": "mie@example.com", "subject": "Voice test", "body": "Two clips.", "attachments": "file://0b6e…, 1c7f…"}}
  → { "folder": "Drafts", "uid": 42, "attachments": [{ "name": "clip-1.mp3", "mime_type": "audio/mpeg", "size": 48213 }, …] }
```

How it works, and what it refuses:

- **Own bundle only.** Files are read through the run's bundle reader (the driver declares `reads: { files: true }`), which resolves only *finalized* files in the service's own bundle. A file in another bundle, an upload that was never completed, and an id that does not exist all fail the same way: `attachment "file://…" is not a file in this bundle` (`not_found`). A file from elsewhere has to be copied into the mail service's bundle first. Every read is recorded on the run as a `file_read` entry.
- **All or nothing.** Every reference is resolved before any bytes are read, and the files are read before the mailbox or server is touched. One bad reference fails the whole run: a message is never written or sent with some of its attachments missing.
- **Limits.** At most 10 files and 18 MiB of raw file bytes in all. Base64 and its line breaks grow 18 MiB to about 24.6 MiB (25.8 MB): within a 25 MiB limit, but at the edge of a provider that counts 25 MB, so a draft near the cap can be accepted into Drafts and still be refused when it is sent. The total is checked against the file records before anything is read, so an oversized request costs nothing. Separately, the driver will not APPEND a message over 32 MiB, and when the IMAP server refuses an append for size (`[TOOBIG]`, `[LIMIT]`, `[OVERQUOTA]`, or a reply saying it is too big or exceeds a limit) the agent sees the server's own text: `the server refused the message: …`. The run is not retried without the attachments.
- **The message.** With at least one file, the message is `multipart/mixed`: the text body first, exactly as a plain message carries it (UTF-8, 8bit), then one part per file in the order given, base64 in 76-character lines, `Content-Disposition: attachment`. The part's type is the file's stored MIME type (parameters dropped), or `application/octet-stream` when it is missing or not a valid type. The filename is the stored file's name, on both `Content-Type` (`name=`) and `Content-Disposition` (`filename=`). A plain ASCII name is written quoted; any other name (non-ASCII, or with a quote, backslash, or control character) is written encoded, as RFC 2231 `filename*` and RFC 2047 encoded words on `name=`, so nothing in a name can end the parameter or the header. A name or type with CR, LF, or NUL in it is refused. Threading (`reply_to_uid`), the draft's `Bcc:` header, and the `\Draft` flag work as without attachments. Without attachments the message is the single `text/plain` part it always was, byte for byte.
- **A replaced draft starts over.** A draft's attachments are not carried over when it is rewritten, and a reply does not carry the original's attachments: pass them again.

### Who can attach, and how to switch it off

The reader's authority is the caller's `run_services` on the bundle, not `read_files`. So a service that exposes `send` with a free `to` lets anyone who may run it mail any file in that bundle to an address of their choosing, without being able to read the file in Yap themselves. Whether that is acceptable is the operator's decision, made per service:

- **Pin `attachments` to an empty value** — `"pins": { "attachments": "" }` — and the parameter disappears from the service: agents do not see it, and supplying it is refused (`parameter "attachments" is fixed by this service configuration`).
- **Pin the recipients** (`to`, which locks `cc` and `bcc` too), so files can only go where the operator says.
- **Do not expose `send`**: with only `draft`, every message with attachments waits in Drafts for a human.

Existing services that expose `send` or `draft` gain `attachments` when the instance is upgraded to a release with it; there is no per-parameter allowlist to opt in.

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

**Triage** — reads, flags, proposes replies, and can remove stale drafts; no mail leaves without a human:

```
{
  "name": "triage",
  "driver": "mail",
  "actions": ["search", "read", "mark", "draft", "delete_draft"],
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

A pinned parameter is injected server-side and its value never appears in the run's params or in an error; the agent supplies only `subject` and `body`. Pins are per parameter *name*, so on their own they would leave `cc` and `bcc` open — which is why the driver treats the three recipient fields as one: **pinning any of `to`, `cc`, `bcc` locks the others.** On such a service, supplying an unpinned recipient field fails with `recipients are fixed on this service; cc cannot be supplied`, and a reply may not derive `to` from the original message either (that would be aiming by proxy). The host tells the driver which parameters were pinned through `ctx.pinned`. Pin `to` and allow only `draft` for a service that may propose replies to one person and nothing else; leave all three unpinned for a service that may address mail freely. One exception to keep in mind: when `attachments` is pinned to real file references, what those files are is not hidden. Each attached file is read through the bundle reader, so the run's audit trail records a `file_read` entry for it, and the `attachments` summary in the result names it. Both are there so the run shows what went on the message.

Invoking:

```
run_service {"id": "inbox", "action": "search", "params": {"unseen": "true", "limit": "10"}, "wait_ms": 15000}
run_service {"id": "inbox", "action": "read", "params": {"uid": "4711"}}
run_service {"id": "inbox", "action": "attachment", "params": {"uid": "4711", "part": "2"}}
run_service {"id": "triage", "action": "draft", "params": {"to": "alice@example.com", "reply_to_uid": "4711", "body": "Thanks — on it."}}
```

## Draft-for-approval

`draft` writes the message into the account's Drafts folder with the `\Draft` flag and threading headers intact. The human opens their usual mail client, finds the draft, edits it if they like, and presses send — or deletes it. There is nothing new to build or learn: the approval surface is the Drafts folder the user already has, the audit trail is the run record, and mail leaves only through a client the human controls. When the server supports UIDPLUS the result carries the new draft's `uid`, which a follow-up `read` in that folder can show.

`delete_draft` completes the rewrite loop: after creating a replacement draft, an agent can delete the stale draft by UID. The driver resolves Drafts with the same `drafts_folder` / `\Drafts` / `Drafts` rules as `draft`, selects that mailbox itself, and uses UID EXPUNGE so only the requested UID is removed. Servers without UIDPLUS are refused with an agent-visible error instead of falling back to plain `EXPUNGE`, which could purge unrelated deleted messages in Drafts.

## Limits and safety

- Results never contain config, credentials, or hosts, and pinned values only as the files a pinned `attachments` put on the message (see above). Folder names and message ids are returned — the agent needs them to refer to things.
- `delete_draft` has no folder parameter and can only operate in the resolved Drafts folder; it requires UIDPLUS so deletion is UID-scoped.
- `search` returns at most 100 summaries per call; `read` text is capped at `max_chars` (≤ 100 000) and the fetched section at 512 KiB, with `truncated: true` when either cap applied.
- `read` lists attachments with part, name, type, and size and never fetches them; `attachment` fetches one listed attachment, at most 25 MiB decoded, into the bundle (see [Downloading attachments](#downloading-attachments)).
- `draft` and `send` attach at most 10 files and 18 MiB in all, only from the service's own bundle (see [Attaching files](#attaching-files)); an appended message is capped at 32 MiB.
- Header injection is blocked: no CR/LF in any header-bound parameter (addresses, subject, display name) or in an attachment's stored filename or MIME type. Bodies are normalised to CRLF and dot-stuffed on the wire so no line can impersonate the SMTP terminator.
- Credentials travel only over TLS unless `allow_plaintext_auth` is set; a server advertising `LOGINDISABLED`, or one that does not offer STARTTLS when `starttls` was configured, fails the run rather than downgrading.
- Every read races the run's abort signal; sockets are closed in `finally`; IMAP reply lines are bounded at 64 KiB and literals at 25 MiB.
- `search` and `read` results carry `uidvalidity` so a caller can detect a mailbox that was rebuilt between calls; a UID that vanished reads as "not found".
- Recipients are capped at 50 per message; an outbound `body` at 1 MiB (UTF-8 bytes); each free-text search criterion (`query`, `from`, `to`, `subject`) at 1000 characters.
- Configured `drafts_folder` / `sent_folder` names are refused at authoring time if they contain CR, LF, or NUL, and the IMAP layer refuses to quote such a string even if one got through.
- The OAuth2 token endpoint's response is read with a 64 KiB cap; an oversized body fails the refresh without any of it being surfaced.

### What the agent sees when a run fails

The runs layer shows an agent only the failures a driver raises as Yap's own errors; any other error collapses to a flat "run failed" on the run row, with the detail kept in the operator log. The mail driver raises an agent-visible error for what an agent can act on:

- `invalid_request`: a missing, malformed, or too-large parameter (uid, limit, max_chars, dates, flag, addresses, subject, body, search text, a header-bound value with a line break, a recipient field supplied on a service whose recipients are pinned, two non-ASCII criteria in one search, an `attachment` part that is not a listed attachment, an attachment over 25 MiB, one in a transfer encoding the driver cannot decode, or one the server returned incomplete; an `attachments` list that is malformed, repeats a file, names more than 10 files or more than 18 MiB in all, or holds a file whose name or type has a line break); a message the server refused to append for size, in the server's own words; an action the service's account cannot do (`send` without an `smtp` block, a reply or `save_sent` without `imap`); an unknown action; no Drafts/Sent folder found (the error names the config field that settles it); `delete_draft` on a server without UIDPLUS; a server that cannot search non-ASCII text; a replied-to message with no usable Reply-To or From; and a recipient the server refused — reported as exactly that, with neither the address (it may be pinned) nor the server's reply line, both of which go to the log.
- `not_found`: `folder "…" not found` (the name is the agent's own input), `message <uid> not found` in the given folder, and `attachment "…" is not a file in this bundle`. When `attachments` is pinned, these errors say "a pinned attachment" instead of quoting the value.

Connection, TLS, authentication, and other protocol failures — and a service config that no longer validates — are never shown: their messages can name the host or carry a server reply, so they reach the operator log only.

## Trust model

The mail driver is part of the server, so it carries the server's trust. The egress guard protects against hostile *parameters* flowing through it — an agent cannot point the account at a different host, because the host is config — and the action allowlist plus pins decide what an agent may do with the account at all. The driver's errors and logs redact credentials and message bodies; the server's reply lines (which can echo an address) survive only in the operator log. The one exception is an append the server refused for size: its reply text, cut to printable ASCII and 200 characters, reaches the agent, because it is the only explanation of the server's own limit. See [SECURITY.md](../SECURITY.md).
