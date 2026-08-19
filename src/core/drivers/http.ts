/**
 * The built-in `http` driver: outbound, parameterized HTTP calls. This is the
 * firing half of the legacy hooks.ts (see that file's header for the security
 * model this preserves) ported onto the driver contract — the allowlisting of
 * *which* parameters may be supplied, and the authoring-time SSRF pre-check,
 * now live one layer up (service authoring / the runs layer); this module
 * owns only template substitution and the guarded transport call.
 *
 * `ctx.params` arrives already validated and pinned to the service's declared
 * spec — this driver does not re-check parameter names, only substitutes
 * their values into the transport.
 *
 * Errors from the network call are collapsed before they reach an agent: an
 * SSRF-guard rejection (either the egress pre-flight, which throws a
 * `YapError`, or the connect-time pinning lookup, which throws or wraps an
 * error coded `SSRF_PIN_ERROR_CODE`) becomes one generic "blocked" message
 * that never names the destination; any other network failure becomes one
 * generic "failed to reach its destination" message, for the same reason.
 * An abort is not collapsed — it is rethrown as-is, so the runs layer (which
 * owns the timeout budget) can attach its own message.
 */
import { z } from "zod";

import type { YapConfig } from "../../config.js";
import { invalid, YapError } from "../errors.js";
import { SSRF_PIN_ERROR_CODE } from "../ssrf.js";
import { DRIVER_API, type DriverDefinition, type Egress, type RunContext } from "./types.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

// Mirrors hooks.ts's hookTransportSchema: the zod schema validates the config
// shape at authoring time; the TypeScript type is inferred from it so the two
// cannot drift.
export const httpConfigSchema = z.object({
  url: z.string(),
  method: z.enum(METHODS),
  headers: z.record(z.string(), z.string()).optional(),
  // Raw body with `{{placeholder}}` substitution and NO escaping — the author
  // owns the encoding. Use for non-JSON bodies (form-encoded, XML, text). For
  // JSON, prefer body_json, which escapes values so they cannot break or
  // inject structure.
  body_template: z.string().optional(),
  // Structured JSON body: an arbitrary JSON value (usually an object) whose
  // string leaves may contain `{{placeholder}}` tokens. At fire time the
  // value is rebuilt and serialized with JSON.stringify, so substituted
  // values are always escaped and can never escape their string position.
  // Mutually exclusive with body_template.
  body_json: z.unknown().optional(),
});
export type HttpConfig = z.infer<typeof httpConfigSchema>;

function substitute(template: string, values: Record<string, string>, encode: boolean): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values[name] ?? "";
    return encode ? encodeURIComponent(value) : value;
  });
}

/**
 * Rebuilds a `body_json` value with placeholders filled in. Substitution
 * happens only in string leaves (with raw, unescaped values); the caller then
 * `JSON.stringify`s the result, which escapes every substituted value so it
 * stays inside its string and cannot inject structure. Numbers, booleans, and
 * null pass through untouched; object keys are structure, not data, so they
 * are not substituted.
 */
function materializeJsonBody(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === "string") return substitute(value, values, false);
  if (Array.isArray(value)) return value.map((item) => materializeJsonBody(item, values));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, leaf] of Object.entries(value)) out[key] = materializeJsonBody(leaf, values);
    return out;
  }
  return value;
}

/**
 * Parses and structurally validates an http service config, throwing
 * `invalid()` (naming the offending rule/field) on failure. Shared by
 * `validateConfig` and `validateConfigOnline`.
 */
function parseHttpConfig(config: unknown): HttpConfig {
  const parsed = httpConfigSchema.safeParse(config);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw invalid(`invalid http service config: ${detail}`);
  }
  const transport = parsed.data;
  if (transport.body_template !== undefined && transport.body_json !== undefined) {
    throw invalid("http service config may set either body_template or body_json, not both");
  }
  // The host must be static — placeholders may appear in path/query/body, but
  // never in the part the SSRF guard vouches for.
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(transport.url)?.[1] ?? "";
  if (authority.includes("{{")) {
    throw invalid("http service destination host cannot contain parameters");
  }
  try {
    new URL(transport.url.replace(PLACEHOLDER, "param"));
  } catch {
    throw invalid("http service config url is not a valid URL");
  }
  return transport;
}

/** Renders the origin the SSRF guard should vouch for, with placeholders
 * neutralized (mirrors the trick in hooks.ts's validateTransport). */
function materializedOrigin(url: string): string {
  return new URL(url.replace(PLACEHOLDER, "param")).origin;
}

export function createHttpDriver(config: YapConfig): DriverDefinition {
  return {
    name: "http",
    api: DRIVER_API,
    description: "Fires an outbound HTTP request with server-side parameter substitution.",
    egress: true,
    configDoc:
      "url, method (GET/POST/PUT/PATCH/DELETE), optional headers, and either body_template (raw, " +
      "unescaped {{param}} substitution) or body_json (structured, escaped substitution). The host " +
      "part of url must be static — no {{param}} tokens.",

    validateConfig(rawConfig: unknown): void {
      parseHttpConfig(rawConfig);
    },

    async validateConfigOnline(rawConfig: unknown, egress: Egress): Promise<void> {
      const transport = parseHttpConfig(rawConfig);
      await egress.assertPublic(materializedOrigin(transport.url));
    },

    actions: {
      fire: {
        description: "Fire the configured HTTP request, substituting declared parameters.",
        params: null, // param specs come from the service record
        timeoutMs: config.hookTimeoutMs,
      },
    },

    async run(ctx: RunContext): Promise<unknown> {
      const transport = ctx.config as HttpConfig;
      const values = ctx.params;

      const url = substitute(transport.url, values, true);

      const headers: Record<string, string> = {};
      for (const [name, headerValue] of Object.entries(transport.headers ?? {})) {
        const substituted = substitute(headerValue, values, false);
        // A CR/LF in a substituted value would split the header and inject
        // additional headers; reject rather than silently mangle.
        if (/[\r\n]/.test(substituted)) {
          throw invalid(`service header "${name}" must not contain a line break after substitution`);
        }
        headers[name] = substituted;
      }

      let body: string | undefined;
      if (transport.method !== "GET") {
        if (transport.body_json !== undefined) {
          body = JSON.stringify(materializeJsonBody(transport.body_json, values));
          // Default the content-type for a JSON body unless the author set one.
          if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
            headers["content-type"] = "application/json";
          }
        } else if (transport.body_template !== undefined) {
          body = substitute(transport.body_template, values, false);
        }
      }

      // egress is guaranteed non-null: this driver declares `egress: true`.
      const egress = ctx.egress!;
      try {
        const response = await egress.fetch(url, {
          method: transport.method,
          headers,
          ...(body !== undefined ? { body } : {}),
          signal: ctx.signal,
          redirect: "manual", // redirects could bounce to private targets
        });
        return { status: response.status, body: await response.text() };
      } catch (err) {
        if ((err as Error).name === "AbortError") throw err;
        const cause = (err as { cause?: { code?: string } }).cause;
        const pinBlocked =
          cause?.code === SSRF_PIN_ERROR_CODE || (err as { code?: string }).code === SSRF_PIN_ERROR_CODE;
        // A YapError here can only have come from the egress pre-flight
        // (`assertPublicDestination`) — the underlying transport throws plain
        // Error/TypeError, never YapError — so treat any YapError as a
        // pre-flight SSRF rejection too.
        if (pinBlocked || err instanceof YapError) {
          throw new YapError(
            "forbidden",
            "service destination is blocked by the SSRF guard; ask an operator to review this service's configuration",
          );
        }
        // The underlying fetch error can embed the hidden host (e.g.
        // "ENOTFOUND internal.corp"); keep it out of the agent-facing message.
        throw new YapError("internal", "service request failed to reach its destination");
      }
    },
  };
}
