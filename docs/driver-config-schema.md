# Driver config schemas

Every service is a driver plus a config, and the config is written once by whoever authors the service. A driver may publish what that config looks like in a form a program can read: a JSON Schema for the config object, and a list of the fields in it that hold secrets. A client uses this to build a config form, to mask and never echo the secret fields, and to keep them apart from ordinary settings.

The schema is a description. It is optional, and it does not validate anything at run time: the driver's own `validateConfig` remains the one authority on what a config may contain, exactly as before. A driver without a schema is listed with `configSchema: null` and works the same way it always has.

Core also uses the secret paths to store a service's config in two parts: readable settings and encrypted, write-only secrets. That is described in [service-config.md](service-config.md). Marking a field secret therefore decides who can read it back: get the list right. And because `validateConfig` then checks a config that can include secrets stored earlier by another author, its error messages must name fields, never echo values.

## The contract

A driver definition may carry `configSchema`:

```js
export default {
  name: "notes",
  api: 1,
  // …description, egress, actions, run, validateConfig as usual…
  configSchema: {
    jsonSchema: {
      type: "object",
      properties: {
        base_url: { type: "string", description: "The API's base URL." },
        token: { type: "string", description: "API token." },
        oauth: {
          type: "object",
          properties: { client_id: { type: "string" }, client_secret: { type: "string" } },
        },
        headers: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["base_url", "token"],
      examples: [{ base_url: "https://api.example.com", token: "<token>" }],
    },
    secrets: [
      { path: "token", label: "API token", description: "Create one under Settings → API." },
      { path: "oauth.client_secret", label: "OAuth client secret" },
      { path: "headers.*", label: "Header value" },
    ],
  },
};
```

- **`jsonSchema`** is a JSON Schema (draft 2020-12) whose root is `type: "object"`. It must be plain JSON. Put example configs under the standard `examples` keyword; use placeholders there, never real credentials, because the schema is readable by any authenticated caller.
- **`secrets`** lists every path in the config that holds a secret: passwords, API keys, tokens, client secrets, private keys. It may be empty. Each entry has a `path`, a short `label` (up to 80 characters) for a form field, and an optional `description` (up to 500 characters).

### Secret paths

A path is a dot-separated list of property names from the root of the config: `pass`, `oauth2.client_secret`. A `*` segment stands for every key of a map, that is a schema node with `additionalProperties`: `headers.*` marks every header value, whatever the header is called. Property names in a path may use letters, digits, `_` and `-`.

Each path must resolve inside `jsonSchema`, following `properties` for a name and `additionalProperties` for `*`. A path that does not resolve is refused when the driver is loaded, so renaming a field without updating its secret marking fails loudly instead of silently un-marking it.

### Where it is checked

The registry checks `configSchema` structurally whenever a driver is registered: at boot for built-in and installed drivers, and when an operator runs `yap driver add`. A malformed schema is refused with a message naming the driver and the field, for example `driver "notes" configSchema.secrets[1].path "oauth.secret" does not name a field in jsonSchema`.

A driver written in TypeScript with a zod config schema can generate `jsonSchema` from it with `jsonSchemaFromZod` (`src/core/drivers/schema.ts`), which uses the input side of the schema (what an author writes, before defaults) and renders anything JSON Schema cannot express, such as a custom check or a refinement, as an unconstrained `{}`. The built-in mail driver does this and then adds back by hand what zod keeps in refinements (see `src/core/drivers/mail/config.ts`).

## Reading it

The schema is served without any values. No service's config ever appears in it.

**REST.** `GET /v1/drivers` returns `{ data: [...] }`, one entry per installed driver, sorted by name. `GET /v1/drivers/:name` returns one entry, or 404. Any valid access key, access token or the sysadmin key may read them; no credential is a 401.

**MCP.** The read-only `list_drivers` tool returns the same `{ data: [...] }`. Pass `names` to narrow it to some drivers; an unknown name is an error.

Each entry:

```jsonc
{
  "name": "mail",
  "description": "Reads, searches, sends, drafts …",
  "egress": true,                                   // reaches the network through the guarded egress
  "reads": { "files": true, "items": false },       // bundle surfaces it may read
  "writes": { "items": false, "files": true },      // bundle surfaces it may write
  "actions": [
    { "name": "send", "description": "…", "params": [{ "name": "to", "description": "…", "required": false }], "timeoutMs": 60000 }
  ],                                                // params is null when the service record declares them (http)
  "configDoc": "user: the account's login name …",  // the free-text help, or null
  "configSchema": {                                 // or null
    "jsonSchema": { "type": "object", "properties": { … }, "examples": [ … ] },
    "secrets": [{ "path": "pass", "label": "Password", "description": "…" }]
  }
}
```

`timeoutMs` is the budget the driver declares; an operator's `YAP_RUN_TIMEOUT_CAP_MS` may lower what a run actually gets.

## The built-in drivers

| driver | secret paths | notes |
|---|---|---|
| `http` | `headers.*` | Header values are where an http service carries credentials by design (an `Authorization` or API-key header), so every header value is marked. The url and body are not: a token belongs in a header. |
| `mail` | `pass`, `oauth2.client_secret`, `oauth2.refresh_token` | `oauth2.client_id`, the hosts and the addresses are settings, not secrets. The schema also carries the rules zod keeps in a refinement: exactly one of `pass` / `oauth2` (`oneOf`), at least one of `imap` / `smtp` (`anyOf`), and `from` as an email address. |

Both publish `examples` that their own `validateConfig` accepts; the test suite checks this, and that every secret path resolves.
