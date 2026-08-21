# yap-driver-smtp

An example [Yap](https://github.com/yap-tools/yap-core) service driver: send a plain-text email over SMTP.

It is deliberately small and dependency-free — one `index.js`, no imports at all — because it doubles as the
reference for what an *external* driver looks like. Everything it needs arrives by injection on the run context:
the decrypted config, the caller's parameters, the names of the pinned ones, a guarded network door, an abort
signal, a log sink, and `ctx.fail` for errors the agent may read.

It is a reference, not the way to get email into Yap: every instance already ships the built-in `mail` driver
(IMAP + SMTP, six actions, documented in [docs/mail-driver.md](../../../docs/mail-driver.md)), which needs no
install. Use this folder when you are writing a driver of your own.

## Install

```sh
yap driver add ./examples/drivers/smtp     # a local path
yap driver add yap-driver-smtp             # or, once published, a registry name
yap driver list
```

`yap driver add` packs the folder, installs it under `<instance>/drivers/`, and loads it once with the same
loader the server uses at boot — so a driver that does not satisfy the contract fails at install time, not in
front of an agent.

## Configuration

The config is written when the service is authored, encrypted at rest, and decrypted only in memory inside a
run. No listing, no agent-visible surface, and no run record ever shows it.

| Field    | Required | Meaning                                                                          |
| -------- | -------- | -------------------------------------------------------------------------------- |
| `host`   | yes      | The SMTP server's hostname.                                                       |
| `port`   | yes      | Its port: 587 or 25 for plain submission, 465 for implicit TLS.                   |
| `secure` | no       | `true` to wrap the connection in TLS from the first byte, as port 465 expects.    |
| `user`   | no       | Username for `AUTH LOGIN`. Set together with `pass`, or set neither.              |
| `pass`   | no       | Password for `AUTH LOGIN`.                                                        |
| `from`   | yes      | The envelope sender and the `From:` header.                                       |

## The action

`send` takes three parameters — `to`, `subject`, and `body` — and sends one UTF-8, plain-text message to one
recipient. It returns `{"accepted": true}` and nothing more: a run's result is agent-visible, and `to` may be
a pinned value the agent is not meant to learn, so the recipient is not echoed back.

## The worked example: a pinned recipient

The point of a service is that an operator decides *how much* of a capability an agent gets. Pin `to` at
authoring time and the agent can send mail but cannot choose who receives it:

```sh
curl -X POST "$YAP/v1/bundles/$BUNDLE/services" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{
        "name": "notify-me",
        "driver": "smtp",
        "description": "Emails Troels.",
        "config": {"host": "smtp.example.com", "port": 587, "user": "postmaster",
                   "pass": "…", "from": "yap@example.com"},
        "pins": {"to": "troels@example.com"}
      }'
```

The agent now sees an action with two parameters:

```json
{ "name": "send", "params": [{ "name": "subject", "required": true }, { "name": "body", "required": true }] }
```

`to` is gone from the listing entirely — a pin is configuration, so an agent cannot learn that it is fixed, let
alone to what. Supplying it anyway is a hard error (`parameter "to" is fixed by this service configuration`),
and the pinned value is merged in by the runner *after* the caller's parameters have been validated, so it can
never be overridden. It is also kept off the run record, which any holder of `run_services` can read — and off
the run's *result*, which is why `send` answers `{"accepted": true}` rather than naming the recipient.

## Trust model

A driver is **trusted code running in the server process**. Installing one is the same class of decision as
installing a plugin: it can read what it is given and it runs with the server's privileges. What the contract
guarantees is not a sandbox but a set of explicit crossings, and this driver stays inside them:

- **Egress.** It declares `egress: true` and reaches the network only through `ctx.egress.connect()`, which
  resolves the host itself and refuses private, link-local, and loopback addresses unless the operator
  allowlisted them (`YAP_HOOK_ALLOW_HOSTS`). That check happens at *run* time, on the address actually
  connected to. There is no authoring-time pre-check for SMTP the way there is for `http`, because Yap's
  pre-flight guard vouches for http(s) URLs only — an internal relay is therefore accepted at authoring time
  and refused when the run dials it.
- **The socket is the driver's.** `egress.dispose()` releases only the fetch pool; this driver closes its own
  socket in a `finally`, on every path.
- **Writes.** It declares none, so `ctx.writer` is `null` and no write surface is reachable from it. A driver
  that wants to create items declares `writes: { items: true }` and gets a bundle-scoped
  `ctx.writer.createItems(itemTypeName, values)`; `writes.files` is reserved — declaring it is refused at load
  time, since no file surface exists on the writer yet.
- **Abort.** Every read races `ctx.signal`, so a run that hits its budget tears the session down rather than
  holding a socket open.
- **Injection.** `to` and `from` must be single addresses that require a dotted domain (`name@host.tld`) — a
  single-label intranet address like `postmaster@relay` is rejected by design, not just international ones —
  and a `subject` containing a line break is refused, since either could otherwise let an agent-supplied value
  inject extra headers. The body is first normalized so every line-break form it might contain (`\r\n`, bare
  `\n`, *and bare* `\r`) becomes a real line break, and only then are lines starting with `.` dot-stuffed and
  the whole message rejoined with `\r\n`. Skipping the bare-CR case would be an SMTP smuggling hole: a body
  containing a lone `\r.\r` would reach a server that treats bare CR as a line terminator on its own, which
  reads that as the end of `DATA` and the attacker-supplied SMTP commands after it as new commands — bypassing
  the pinned recipient entirely. Normalizing first means no line of the payload, in any of its forms, can be
  read as the end of `DATA`.
- **Errors.** A rejected SMTP reply becomes a plain `Error` carrying the server's reply line. Yap collapses a
  non-sanitized driver error into a flat `run failed` for the agent (a reply line can echo an address), so the
  transcript is written to `ctx.log` instead, where it stays inside the run. When a driver *wants* the agent to
  read a failure — a missing parameter, a message that is not there — it throws `ctx.fail(message, code?)`
  instead: that message (and its `invalid_request` / `not_found` code) is kept verbatim on the run row, so the
  driver is vouching that it contains no config or pinned value.
- **Pins.** `ctx.pinned` lists the names of the parameters the service pinned for this action (their values are
  already merged into `ctx.params`). This single-recipient driver has no use for it; the built-in `mail` driver
  does — its `to`, `cc`, and `bcc` overlap in meaning, so a pin on any one of them makes it refuse the others.

## License

MIT.
