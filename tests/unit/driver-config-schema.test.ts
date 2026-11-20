/**
 * Driver config schemas: the optional, machine-readable description of a
 * service config, with the paths that hold secrets.
 *
 * For each built-in driver the published schema must be a valid JSON Schema
 * that accepts the driver's own examples, the driver's validateConfig must
 * accept those same examples (so schema and validator agree on at least the
 * documented shapes), and every secret path must name a field in the schema.
 * The registry's structural check refuses a malformed schema with a message
 * naming the field, and a driver without a schema stays valid.
 */
import { randomBytes } from "node:crypto";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { describeDriver, validateDriverDefinition } from "../../src/core/drivers/registry.js";
import { secretPathResolves } from "../../src/core/drivers/schema.js";
import { DRIVER_API } from "../../src/core/drivers/types.js";
import { createDriverRegistry } from "../../src/server.js";

// ajv-formats is CommonJS; under ESM interop its function may sit on .default.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as unknown as (ajv: Ajv2020) => Ajv2020;

const config = loadConfig({
  YAP_SYSADMIN_KEY: "sysadmin-key-0123456789",
  YAP_MASTER_KEY: randomBytes(32).toString("base64"),
});
const builtIns = createDriverRegistry(config).list();

function compile(jsonSchema: Record<string, unknown>) {
  // strictRequired would flag the standard `oneOf: [{ required: [...] }]` idiom.
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(jsonSchema);
}

describe("built-in driver config schemas", () => {
  it("covers every built-in driver", () => {
    expect(builtIns.map((d) => d.name)).toEqual(["http", "mail"]);
    for (const driver of builtIns) expect(driver.configSchema, driver.name).toBeDefined();
  });

  for (const driver of builtIns) {
    describe(driver.name, () => {
      const schema = driver.configSchema!;

      it("is a JSON Schema that accepts its own examples, as does validateConfig", () => {
        const validate = compile(schema.jsonSchema);
        const examples = schema.jsonSchema.examples as unknown[];
        expect(examples.length).toBeGreaterThan(0);
        for (const example of examples) {
          expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
          expect(() => driver.validateConfig(example)).not.toThrow();
        }
      });

      it("lists secret paths that exist in the schema, each with a label", () => {
        expect(schema.secrets.length).toBeGreaterThan(0);
        for (const secret of schema.secrets) {
          expect(secretPathResolves(schema.jsonSchema, secret.path), secret.path).toBe(true);
          expect(secret.label.trim()).not.toBe("");
        }
      });
    });
  }

  it("mail marks the password and both OAuth secrets, not the hosts or the client id", () => {
    const mail = builtIns.find((d) => d.name === "mail")!.configSchema!;
    expect(mail.secrets.map((s) => s.path)).toEqual(["pass", "oauth2.client_secret", "oauth2.refresh_token"]);
  });

  it("mail's schema carries the cross-field rules zod keeps in a refinement", () => {
    const validate = compile(builtIns.find((d) => d.name === "mail")!.configSchema!.jsonSchema);
    const base = { user: "u", from: "me@example.com", imap: { host: "imap.example.com", port: 993 } };
    expect(validate({ ...base, pass: "p" })).toBe(true);
    expect(validate(base)).toBe(false); // neither pass nor oauth2
    const oauth2 = { client_id: "a", client_secret: "b", refresh_token: "c", token_url: "https://x.example/t" };
    expect(validate({ ...base, pass: "p", oauth2 })).toBe(false); // both
    expect(validate({ user: "u", from: "me@example.com", pass: "p" })).toBe(false); // neither imap nor smtp
    expect(validate({ ...base, pass: "p", from: "not an address" })).toBe(false);
  });

  it("binds each built-in secret to the settings that decide where it goes", () => {
    const http = builtIns.find((d) => d.name === "http")!;
    expect(http.configSchema!.secrets[0]!.boundTo).toEqual(["url"]);
    const mail = builtIns.find((d) => d.name === "mail")!;
    const bound = Object.fromEntries(mail.configSchema!.secrets.map((s) => [s.path, s.boundTo]));
    expect(bound.pass).toEqual(["imap", "smtp", "allow_plaintext_auth"]);
    expect(bound["oauth2.refresh_token"]).toContain("oauth2.token_url");
  });

  it("http marks every header value", () => {
    const http = builtIns.find((d) => d.name === "http")!.configSchema!;
    expect(http.secrets.map((s) => s.path)).toEqual(["headers.*"]);
  });

  it("names where each built-in sends data", () => {
    const http = builtIns.find((d) => d.name === "http")!.configSchema!;
    expect(http.destinations).toEqual([{ label: "URL", setting: "url" }]);
    const mail = builtIns.find((d) => d.name === "mail")!.configSchema!;
    expect(mail.destinations!.map((d) => d.setting ?? `param:${d.param}`)).toEqual([
      "imap",
      "smtp",
      "oauth2.token_url",
      "param:to",
      "param:cc",
      "param:bcc",
    ]);
    expect(mail.destinations!.find((d) => d.param === "to")!.actions).toEqual(["send"]);
  });
});

function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "demo",
    api: DRIVER_API,
    description: "A demo driver.",
    egress: false,
    validateConfig() {},
    actions: { ping: { description: "Ping.", params: [], timeoutMs: 5000 } },
    async run() {
      return { ok: true };
    },
    ...overrides,
  };
}

const goodSchema = {
  jsonSchema: {
    type: "object",
    properties: {
      token: { type: "string" },
      auth: { type: "object", properties: { key: { type: "string" } } },
      headers: { type: "object", additionalProperties: { type: "string" } },
    },
  },
  secrets: [
    { path: "token", label: "API token", description: "From the provider's settings page." },
    { path: "auth.key", label: "Key" },
    { path: "headers.*", label: "Header value" },
  ],
};

describe("configSchema on the driver contract", () => {
  it("is optional: a driver without one validates and describes with configSchema null", () => {
    const def = validateDriverDefinition(definition());
    expect(def.configSchema).toBeUndefined();
    expect(describeDriver(def).configSchema).toBeNull();
  });

  it("accepts a well-formed schema with nested and map secret paths", () => {
    const def = validateDriverDefinition(definition({ configSchema: goodSchema }));
    expect(describeDriver(def).configSchema).toEqual(goodSchema);
  });

  it("hands out a copy, so a caller cannot mutate the installed definition", () => {
    const def = validateDriverDefinition(definition({ configSchema: structuredClone(goodSchema) }));
    const view = describeDriver(def);
    view.configSchema!.secrets.pop();
    expect(def.configSchema!.secrets).toHaveLength(3);
  });

  const bad: Array<[string, unknown, RegExp]> = [
    ["not an object", "schema", /configSchema must be an object/],
    ["no jsonSchema", { secrets: [] }, /configSchema\.jsonSchema must be a JSON Schema object/],
    ["a non-object root", { jsonSchema: { type: "string" }, secrets: [] }, /must describe an object/],
    [
      "a function inside jsonSchema",
      { jsonSchema: { type: "object", default: () => 1 }, secrets: [] },
      /jsonSchema must be plain JSON/,
    ],
    [
      "a cycle inside jsonSchema",
      (() => {
        const node: Record<string, unknown> = { type: "object" };
        node.self = node;
        return { jsonSchema: node, secrets: [] };
      })(),
      /jsonSchema must be plain JSON/,
    ],
    ["secrets missing", { jsonSchema: { type: "object" } }, /secrets must be an array/],
    [
      "a path the schema does not declare",
      { jsonSchema: goodSchema.jsonSchema, secrets: [{ path: "auth.secret", label: "S" }] },
      /secrets\[0\]\.path "auth\.secret" does not name a field/,
    ],
    [
      "a * on a non-map",
      { jsonSchema: goodSchema.jsonSchema, secrets: [{ path: "auth.*", label: "S" }] },
      /does not name a field/,
    ],
    [
      "a malformed path",
      { jsonSchema: goodSchema.jsonSchema, secrets: [{ path: "auth..key", label: "S" }] },
      /secrets\[0\]\.path must be a dot path/,
    ],
    [
      "a duplicate path",
      { jsonSchema: goodSchema.jsonSchema, secrets: [{ path: "token", label: "A" }, { path: "token", label: "B" }] },
      /lists "token" twice/,
    ],
    [
      "a missing label",
      { jsonSchema: goodSchema.jsonSchema, secrets: [{ path: "token" }] },
      /secrets\[0\]\.label must be a non-empty string/,
    ],
    [
      "a non-string description",
      { jsonSchema: goodSchema.jsonSchema, secrets: [{ path: "token", label: "T", description: 3 }] },
      /secrets\[0\]\.description must be a string/,
    ],
    [
      "a boundTo that is not an array",
      { jsonSchema: goodSchema.jsonSchema, secrets: [{ path: "token", label: "T", boundTo: "auth" }] },
      /secrets\[0\]\.boundTo must be an array/,
    ],
    [
      "a boundTo the schema does not declare",
      { jsonSchema: goodSchema.jsonSchema, secrets: [{ path: "token", label: "T", boundTo: ["url"] }] },
      /boundTo "url" does not name a field/,
    ],
    [
      "a boundTo that is itself a secret",
      {
        jsonSchema: goodSchema.jsonSchema,
        secrets: [
          { path: "token", label: "T", boundTo: ["auth.key"] },
          { path: "auth.key", label: "K" },
        ],
      },
      /boundTo "auth\.key" is a secret path/,
    ],
    [
      "a destination with neither setting nor param",
      { ...goodSchema, destinations: [{ label: "Where" }] },
      /destinations\[0\] needs exactly one of setting and param/,
    ],
    [
      "a destination the schema does not declare",
      { ...goodSchema, destinations: [{ label: "URL", setting: "url" }] },
      /destinations\[0\]\.setting "url" does not name a field/,
    ],
    [
      "a destination that is a secret",
      { ...goodSchema, destinations: [{ label: "Key", setting: "auth.key" }] },
      /destinations\[0\]\.setting "auth\.key" is a secret path/,
    ],
    [
      "a param destination no action takes",
      { ...goodSchema, destinations: [{ label: "To", param: "to" }] },
      /destinations\[0\]\.param "to" is not a parameter/,
    ],
    [
      "a param destination for an unknown action",
      { ...goodSchema, destinations: [{ label: "To", param: "to", actions: ["send"] }] },
      /names "send", which is not one of its actions/,
    ],
  ];
  for (const [name, configSchema, message] of bad) {
    it(`refuses ${name}, naming the driver`, () => {
      expect(() => validateDriverDefinition(definition({ configSchema }))).toThrow(message);
      expect(() => validateDriverDefinition(definition({ configSchema }))).toThrow(/driver "demo" configSchema/);
    });
  }
});
