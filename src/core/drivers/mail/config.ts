/**
 * The mail service config: what an operator writes once, encrypted on the
 * service record, and what every action reads. `normalizeMailConfig` is the
 * single place that decides what the shape means — it validates, fills the
 * defaults that depend on other fields (security by port), and hands back a
 * config the rest of the driver can use without re-checking. Errors are
 * `invalid()` and name the offending field, so the CLI can show them at
 * authoring time.
 *
 * One account serves both protocols: `user` plus either `pass` (an app
 * password on Fastmail/Gmail, the account password on a self-hosted server) or
 * an `oauth2` block (Google Workspace, Microsoft 365 — where basic auth is
 * switched off). Exactly one of the two; a config with both is ambiguous and
 * is refused rather than guessed at.
 *
 * Security defaults follow the well-known ports: 993/465 are the implicit-TLS
 * ports, 143/587 the STARTTLS ones, and anything unusual gets `tls` because
 * the safe guess is the one that fails loudly when wrong. `none` is never a
 * default — plaintext is for lab servers and the operator has to say so.
 *
 * Like the http driver, the zod schema is the validator and the TypeScript
 * types are inferred from it, so the two cannot drift.
 */
import { z } from "zod";

import { invalid } from "../../errors.js";
import { jsonSchemaFromZod, type DriverConfigSchema } from "../schema.js";
import { isAddress } from "./message.js";

export const SECURITY = ["tls", "starttls", "none"] as const;
export type Security = (typeof SECURITY)[number];

export const configDoc = [
  "user: the account's login name (required)",
  "pass: its password — an app password on Fastmail and personal Gmail (exactly one of pass / oauth2)",
  "oauth2: { client_id, client_secret, refresh_token, token_url (https) } for XOAUTH2 on Google Workspace / Microsoft 365",
  "from: the address mail is sent as (required); name: the display name shown with it (optional)",
  "imap: { host, port, security? } — needed for folders/search/read/mark/draft/delete_draft and for replies (optional)",
  "smtp: { host, port, security? } — needed for send (optional); at least one of imap / smtp is required",
  'security: "tls" (implicit TLS), "starttls", or "none"; defaults by port: 993/465 → tls, 143/587 → starttls, other → tls',
  "allow_plaintext_auth: true to send credentials over a security:none connection — lab servers only (default false)",
  "drafts_folder: where draft lands (default: the folder flagged \\Drafts, else one named \"Drafts\")",
  "sent_folder: where sent mail is copied when save_sent is on (default: the folder flagged \\Sent, else \"Sent\")",
  "save_sent: true to append a copy of every sent message to the sent folder (default false; needs imap)",
  "",
  "Restrict what a service may do with its `actions` allowlist; `delete_draft` is safe to grant because it can only touch Drafts. Pin `to` for a service that can send but not aim.",
].join("\n");

export function defaultSecurity(port: number): Security {
  if (port === 993 || port === 465) return "tls";
  if (port === 143 || port === 587) return "starttls";
  return "tls";
}

const nonEmptyString = z
  .string({ error: "must be a non-empty string" })
  .refine((s) => s.trim() !== "", "must be a non-empty string");

const optionalBoolean = z.boolean({ error: "must be true or false" }).optional();

/** A mailbox name goes onto the IMAP wire quoted; CR/LF/NUL would end the
 * command early, so they are refused here as well as in imap.ts. */
const folderName = nonEmptyString.refine((s) => !/[\r\n\0]/.test(s), "must not contain a line break or NUL");

const endpointSchema = z
  .object(
    {
      host: nonEmptyString.refine((h) => !/[\s/@:]/.test(h), "must be a bare hostname").describe("Server hostname."),
      port: z
        .number({ error: "must be an integer from 1 to 65535" })
        .int("must be an integer from 1 to 65535")
        .min(1, "must be an integer from 1 to 65535")
        .max(65535, "must be an integer from 1 to 65535")
        .describe("Server port."),
      security: z
        .enum(SECURITY, { error: `must be one of ${SECURITY.join(", ")}` })
        .optional()
        .describe("tls (implicit), starttls, or none. Defaults by port: 993/465 tls, 143/587 starttls, other tls."),
    },
    { error: "must be an object with host and port" },
  )
  .transform(
    (block): ProtocolBlock => ({
      host: block.host,
      port: block.port,
      security: block.security ?? defaultSecurity(block.port),
    }),
  );

/** One endpoint, `security` always filled in. */
export interface ProtocolBlock {
  host: string;
  port: number;
  security: Security;
}

const oauth2Schema = z
  .object(
    {
      client_id: nonEmptyString.describe("OAuth client id."),
      client_secret: nonEmptyString.describe("OAuth client secret."),
      refresh_token: nonEmptyString.describe("Long-lived refresh token the driver exchanges for access tokens."),
      token_url: nonEmptyString.describe("The provider's https token endpoint."),
    },
    { error: "must be an object" },
  )
  .superRefine((oauth2, ctx) => {
    let url: URL;
    try {
      url = new URL(oauth2.token_url);
    } catch {
      ctx.addIssue({ code: "custom", path: ["token_url"], message: "must be a valid URL" });
      return;
    }
    if (url.protocol !== "https:") ctx.addIssue({ code: "custom", path: ["token_url"], message: "must be an https URL" });
  });
export type OAuth2Config = z.infer<typeof oauth2Schema>;

export const mailConfigSchema = z
  .object({
    user: nonEmptyString.describe("The account's login name, for both IMAP and SMTP."),
    pass: nonEmptyString.optional().describe("Password or app password. Exactly one of pass and oauth2."),
    oauth2: oauth2Schema.optional().describe("XOAUTH2 credentials, for providers with basic auth switched off. Exactly one of pass and oauth2."),
    from: z
      .custom<string>((v) => isAddress(v), 'must be a single email address like "name@example.com"')
      .describe("The address mail is sent as."),
    name: nonEmptyString
      .refine((s) => !/[\r\n\0]/.test(s), "must not contain a line break")
      .optional()
      .describe("Display name shown with the from address."),
    imap: endpointSchema.optional().describe("IMAP server. Needed for every action except send. At least one of imap and smtp."),
    smtp: endpointSchema.optional().describe("SMTP server. Needed for send. At least one of imap and smtp."),
    allow_plaintext_auth: optionalBoolean
      .transform((v) => v ?? false)
      .describe("Send credentials over a security: none connection. Lab servers only."),
    save_sent: optionalBoolean
      .transform((v) => v ?? false)
      .describe("Append a copy of every sent message to the sent folder. Needs imap."),
    drafts_folder: folderName.optional().describe("Where draft writes. Default: the folder flagged \\Drafts, else Drafts."),
    sent_folder: folderName.optional().describe("Where save_sent copies to. Default: the folder flagged \\Sent, else Sent."),
  })
  .superRefine((config, ctx) => {
    if ((config.pass !== undefined) === (config.oauth2 !== undefined)) {
      ctx.addIssue({ code: "custom", message: "exactly one of pass or oauth2 is required" });
    }
    if (config.imap === undefined && config.smtp === undefined) {
      ctx.addIssue({ code: "custom", message: "at least one of imap or smtp is required" });
    }
    if (config.save_sent && config.imap === undefined) {
      ctx.addIssue({ code: "custom", path: ["save_sent"], message: "save_sent requires an imap block" });
    }
  });

/** The normalised config: known fields only, every optional one either absent
 * or well-formed, both endpoint blocks with `security` filled in. */
export type MailConfig = z.output<typeof mailConfigSchema>;

/**
 * Validates `raw` and returns the normalised config, throwing `invalid()`
 * naming the offending field otherwise.
 */
export function normalizeMailConfig(raw: unknown): MailConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalid("invalid mail service config: config must be an object");
  }
  const parsed = mailConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")} ${issue.message}` : issue.message))
      .join("; ");
    throw invalid(`invalid mail service config: ${detail}`);
  }
  return parsed.data;
}

/**
 * The published config schema. Generated from `mailConfigSchema`, with the two
 * things zod cannot express put back by hand: `from` is a custom check (an
 * email address), and the cross-field rules (exactly one of pass / oauth2, at
 * least one of imap / smtp) live in a superRefine. `normalizeMailConfig` stays
 * the authority; this is the description a client builds a form from.
 */
function buildMailConfigSchema(): DriverConfigSchema {
  const generated = jsonSchemaFromZod(mailConfigSchema);
  const properties = generated.properties as Record<string, Record<string, unknown>>;
  properties.from = { ...properties.from, type: "string", format: "email" };
  return {
    jsonSchema: {
      ...generated,
      allOf: [
        { oneOf: [{ required: ["pass"] }, { required: ["oauth2"] }] },
        { anyOf: [{ required: ["imap"] }, { required: ["smtp"] }] },
      ],
      examples: [
        {
          user: "me@example.com",
          pass: "app-password",
          from: "me@example.com",
          name: "Me",
          imap: { host: "imap.example.com", port: 993 },
          smtp: { host: "smtp.example.com", port: 465 },
        },
        {
          user: "me@example.com",
          oauth2: {
            client_id: "client-id",
            client_secret: "client-secret",
            refresh_token: "refresh-token",
            token_url: "https://oauth2.example.com/token",
          },
          from: "me@example.com",
          imap: { host: "imap.example.com", port: 993 },
          smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
          save_sent: true,
        },
      ],
    },
    secrets: [
      {
        path: "pass",
        label: "Password",
        description: "The account password, or an app password where the provider issues them (Fastmail, personal Gmail).",
        // Sent to the IMAP and SMTP servers, in the clear when plaintext auth is allowed.
        boundTo: ["imap", "smtp", "allow_plaintext_auth"],
      },
      {
        path: "oauth2.client_secret",
        label: "OAuth client secret",
        description: "The secret of the OAuth client registered with the mail provider.",
        // Sent to the token endpoint; the access tokens it buys go to the mail servers.
        boundTo: ["oauth2.token_url", "imap", "smtp", "allow_plaintext_auth"],
      },
      {
        path: "oauth2.refresh_token",
        label: "OAuth refresh token",
        description: "The long-lived token the driver exchanges for short-lived access tokens.",
        boundTo: ["oauth2.token_url", "imap", "smtp", "allow_plaintext_auth"],
      },
    ],
    destinations: [
      { label: "IMAP server", setting: "imap" },
      { label: "SMTP server", setting: "smtp" },
      { label: "OAuth token endpoint", setting: "oauth2.token_url" },
      { label: "Recipients (To)", param: "to", actions: ["send"] },
      { label: "Recipients (Cc)", param: "cc", actions: ["send"] },
      { label: "Recipients (Bcc)", param: "bcc", actions: ["send"] },
    ],
  };
}

export const mailConfigSchemaInfo: DriverConfigSchema = buildMailConfigSchema();
