/**
 * The built-in `mail` driver: read, search, send, draft, and delete drafts through one
 * operator-configured IMAP/SMTP account, and download attachments into the bundle.
 *
 * The driver declares eight actions and the *service* decides which of them an
 * agent gets (the service's `actions` allowlist). That is what turns one
 * driver into three very different capabilities:
 *
 * - a **reader** (`actions: ["folders","search","read"]`) can look and change
 *   nothing;
 * - a **triage** service (`["search","read","mark","draft","delete_draft"]`) flags messages,
 *   proposes replies into the Drafts folder, and can remove stale drafts there;
 * - a **notifier** (`["send"]` with `pins: {to: "ops@…"}`) can send but cannot
 *   aim.
 *
 * `attachment` is the odd one out: it is the only action that leaves
 * something in Yap rather than in the mailbox — one attachment, decoded, as a
 * finalized file in the service's bundle (hence `writes: { files: true }`).
 * It fetches only parts `read` lists as attachments, never a section the
 * agent names, and refuses rather than store anything partial or over the
 * cap.
 *
 * The opposite direction belongs to `draft` and `send`: their `attachments`
 * parameter names files in the same bundle, read through the run's bundle
 * reader (hence `reads: { files: true }`), and puts them on the message as
 * MIME attachments. The reader resolves only finalized files of the
 * service's own bundle and records a `file_read` on the run for each, so the
 * driver never reaches file bytes any other way. Its authority is the
 * caller's `run_services` on the bundle — not `read_files` — which on a
 * `send` with a free `to` means a caller can mail any file in the bundle to
 * an address of their choosing. That is the operator's call to make, and the
 * switch is a pin: `pins: { attachments: "" }` removes the parameter from the
 * service, as does pinning the recipients or not exposing `send`.
 *
 * The last shape is why the three recipient parameters — `to`, `cc`, `bcc` —
 * are treated as one. Pins are per parameter *name*, so a pinned `to` alone
 * would leave `cc` open and let an agent route mail past it. The rule here is
 * that **any pinned recipient field locks the others**: on a service that pins
 * one of them, supplying another is refused, and a reply may not derive `to`
 * from the original either. `ctx.pinned` is how the driver knows; pinning `to`
 * therefore really does fix where mail can go.
 *
 * This file is the seam between that contract and the protocol layer in the
 * sibling modules: it parses the string parameters an agent supplies, opens
 * exactly the connections an action needs, closes them in `finally`, and
 * shapes what comes back.
 *
 * What comes back is agent-visible, so the rule for every result is: report
 * what happened, never what it was aimed at. No host, no credential, no
 * pinned value is ever echoed; folder names and message ids are the one kind
 * of operational metadata the results do carry, because without them the
 * agent cannot refer to what it found.
 *
 * Numbers arrive as strings and are parsed and capped here (summaries ≤ 100,
 * text ≤ 100 000 chars, outbound bodies ≤ 1 MiB, search text ≤ 1000 chars,
 * downloaded attachments ≤ 25 MiB decoded, outbound attachments ≤ 10 files
 * and 18 MiB in all, an appended message ≤ 32 MiB);
 * dates are calendar days the way IMAP defines them; every header-bound
 * parameter goes through the injection check in message.ts before it reaches
 * a wire.
 *
 * Failures come in two kinds. The runs layer shows an agent only a `YapError`
 * verbatim; every other error collapses to "run failed" on the run row and
 * lives in the operator log. Internally the actions throw `AgentError` for
 * the failures an agent can act on — a bad parameter, a message that is not
 * there, a missing Drafts folder — and `run()` converts those (and the IMAP
 * client's errors tagged `agent: "not_found" | "invalid_request"`) into
 * `YapError`s at the boundary. Nothing in an AgentError's text comes from the
 * config or a pinned value; a refused recipient, whose address may well be
 * pinned, is reported without it. A config that fails to normalise at run
 * time is an operator's problem, not the agent's, so it collapses too.
 */
import { convert as htmlToText } from "html-to-text";
import iconv from "iconv-lite";

import { YapError } from "../../errors.js";
import { DRIVER_API, type DriverActionSpec, type DriverDefinition, type DriverFailCode, type DriverParamSpec, type Egress, type RunContext } from "../types.js";
import { resolveAuth } from "./auth.js";
import { configDoc, normalizeMailConfig, type MailConfig } from "./config.js";
import { imapConnect, type ImapClient, type MailboxInfo, type MailCtx, type SearchCriterion } from "./imap.js";
import { attachmentParts, partFilename, textParts, type BodyPart } from "./imap-parse.js";
import {
  assertHeaderSafe,
  attachmentSummary,
  buildMessage,
  isAddress,
  makeMessageId,
  MAX_RECIPIENTS,
  parseAddresses,
  type MessageAttachment,
} from "./message.js";
import { ProtocolError } from "./net.js";
import { smtpProbe, smtpSend, type SmtpRejection, type SmtpSessionConfig } from "./smtp.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_MAX_CHARS = 20_000;
const MAX_MAX_CHARS = 100_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SEARCH_TEXT_CHARS = 1000;
const SUMMARY_FIELD_CHARS = 512;
const TEXT_SECTION_BYTES = 512 * 1024;
/** The largest attachment `attachment` stores, counted after transfer decoding. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Files one outgoing message may carry. */
const MAX_OUTBOUND_ATTACHMENTS = 10;
/** Raw bytes of all files on one outgoing message. Base64 grows 18 MiB to
 * about 24 MiB, under the 25 MB most providers accept, so a draft that was
 * accepted can also be sent. */
const MAX_OUTBOUND_ATTACHMENT_BYTES = 18 * 1024 * 1024;
const FILE_REF_PREFIX = "file://";
const FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ONLINE_VALIDATION_TIMEOUT_MS = 20_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const SPECIAL_USE: Record<string, string> = {
  "\\ALL": "all",
  "\\ARCHIVE": "archive",
  "\\DRAFTS": "drafts",
  "\\FLAGGED": "flagged",
  "\\IMPORTANT": "important",
  "\\JUNK": "junk",
  "\\SENT": "sent",
  "\\TRASH": "trash",
};

const MARK_FLAGS: Record<string, ["+FLAGS" | "-FLAGS", string]> = {
  seen: ["+FLAGS", "\\Seen"],
  unseen: ["-FLAGS", "\\Seen"],
  flagged: ["+FLAGS", "\\Flagged"],
  unflagged: ["-FLAGS", "\\Flagged"],
};

/** A failure the agent is allowed to read; `run()` turns it into a `YapError`. */
class AgentError extends Error {
  constructor(
    message: string,
    readonly code: DriverFailCode = "invalid_request",
  ) {
    super(message);
    this.name = "AgentError";
  }
}

type Params = Record<string, string>;
type Handler = (ctx: RunContext, config: MailConfig, params: Params) => Promise<unknown>;

const folderParam: DriverParamSpec = { name: "folder", description: "Mailbox name (default INBOX)", required: false };
const uidParam: DriverParamSpec = { name: "uid", description: "The message's UID in that folder, as returned by search", required: true };
const draftUidParam: DriverParamSpec = { name: "uid", description: "The draft message's UID in the Drafts folder, as returned by draft or search", required: true };
const composeParams: DriverParamSpec[] = [
  { name: "to", description: "Recipient address, or several separated by commas (a reply defaults to the original sender)", required: false },
  { name: "cc", description: "Cc addresses, comma-separated", required: false },
  { name: "bcc", description: "Bcc addresses, comma-separated — envelope only when sending, a Bcc header on a draft", required: false },
  { name: "subject", description: "Subject line (required unless replying; a reply defaults to Re: the original)", required: false },
  { name: "body", description: "Plain-text body", required: true },
  {
    name: "attachments",
    description: `Files from this bundle to attach, comma-separated: each a file://{uuid} reference or a bare file id. Only files in this service's own bundle can be attached; at most ${MAX_OUTBOUND_ATTACHMENTS} files and ${MAX_OUTBOUND_ATTACHMENT_BYTES / 1024 / 1024} MiB in all`,
    required: false,
  },
  { name: "reply_to_uid", description: "UID of the message being replied to: sets In-Reply-To/References and the Re: subject", required: false },
  { name: "folder", description: "Folder the replied-to message lives in (default INBOX)", required: false },
];

const actions: Record<string, DriverActionSpec> = {
  folders: {
    description: "List the account's folders with their special use (drafts, sent, …) and message counts.",
    params: [],
    timeoutMs: 30_000,
  },
  search: {
    description: "Find messages in a folder, newest first. Every criterion given must match; with none, the latest messages are returned.",
    params: [
      folderParam,
      { name: "query", description: "Text to look for anywhere in the message", required: false },
      { name: "from", description: "Text the From header must contain", required: false },
      { name: "to", description: "Text the To header must contain", required: false },
      { name: "subject", description: "Text the Subject must contain", required: false },
      { name: "since", description: "Only messages on or after this day, YYYY-MM-DD", required: false },
      { name: "before", description: "Only messages before this day, YYYY-MM-DD", required: false },
      { name: "unseen", description: '"true" to return only unread messages', required: false },
      { name: "limit", description: `How many summaries at most (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`, required: false },
    ],
    timeoutMs: 30_000,
  },
  read: {
    description:
      "Read one message: headers, its text (HTML converted), and a list of attachments, each with the part id the attachment action takes. Reading does not mark it seen.",
    params: [
      uidParam,
      folderParam,
      { name: "max_chars", description: `Truncate the text after this many characters (default ${DEFAULT_MAX_CHARS}, max ${MAX_MAX_CHARS})`, required: false },
    ],
    timeoutMs: 60_000,
  },
  attachment: {
    description: `Download one attachment of a message into this bundle as a file. Take \`part\` from the message's read. Does not mark the message seen. At most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB.`,
    params: [
      uidParam,
      folderParam,
      { name: "part", description: 'The attachment\'s part id, as listed in read\'s attachments (e.g. "2" or "1.3")', required: true },
    ],
    timeoutMs: 120_000,
  },
  mark: {
    description: "Mark a message seen, unseen, flagged, or unflagged.",
    params: [uidParam, { name: "flag", description: "One of seen, unseen, flagged, unflagged", required: true }, folderParam],
    timeoutMs: 30_000,
  },
  send: {
    description: "Send an email from the configured account, optionally as a threaded reply, optionally with files from this bundle attached.",
    params: composeParams,
    timeoutMs: 60_000,
  },
  draft: {
    description:
      "Write a message into the account's Drafts folder for a human to review and send, optionally with files from this bundle attached; nothing is delivered.",
    params: composeParams,
    timeoutMs: 60_000,
  },
  delete_draft: {
    description: "Delete a draft by UID; this action can only ever touch the Drafts folder.",
    params: [draftUidParam],
    timeoutMs: 30_000,
  },
};

export function createMailDriver(): DriverDefinition {
  return {
    name: "mail",
    api: DRIVER_API,
    description:
      "Reads, searches, sends, drafts, and deletes drafts through an IMAP/SMTP account, and downloads attachments into the bundle; the service picks which of those an agent may do.",
    egress: true,
    // Only `attachment` uses the writer. The runner builds one per run of any
    // action of a driver that declares writes (runs.ts), but it is a handle,
    // not a permission: the other handlers never touch it.
    writes: { files: true },
    // The same holds for the reader, which the runner cannot scope per action
    // either: only `draft` and `send` may touch `ctx.reader`, through
    // `loadAttachments`, to read the files named in `attachments`. Every
    // other handler leaves it alone (a unit test checks that).
    reads: { files: true },
    configDoc,

    validateConfig(config: unknown): void {
      normalizeMailConfig(config);
    },

    async validateConfigOnline(rawConfig: unknown, egress: Egress): Promise<void> {
      const config = normalizeMailConfig(rawConfig);
      const ctx: MailCtx = { egress, signal: AbortSignal.timeout(ONLINE_VALIDATION_TIMEOUT_MS), log: () => {} };
      if (config.imap) {
        await labelled("imap", async () => {
          const client = await imapConnect(ctx, config);
          await client.logout();
        });
      }
      if (config.smtp) {
        await labelled("smtp", async () => smtpProbe(ctx, await smtpConfig(ctx, config)));
      }
    },

    actions,

    async run(ctx: RunContext): Promise<unknown> {
      try {
        const handler = Object.hasOwn(handlers, ctx.action) ? handlers[ctx.action] : undefined;
        // The service's allowlist, not the driver's full set, is what the agent
        // may know about — and the host lists that itself, so no names here.
        if (!handler) throw new AgentError(`unknown action "${String(ctx.action)}"`);
        return await handler(ctx, runConfig(ctx), ctx.params ?? {});
      } catch (e) {
        throw agentVisible(e);
      }
    },
  };
}

/**
 * A config that no longer normalises at run time is an operator problem —
 * `invalid()` from config.ts is a YapError, which the runner would show the
 * agent. Re-thrown plain so it collapses; the detail goes to the log.
 */
function runConfig(ctx: RunContext): MailConfig {
  try {
    return normalizeMailConfig(ctx.config);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.log(`mail: ${message}`);
    throw new Error(message, { cause: e });
  }
}

const handlers: Record<string, Handler> = {
  async folders(ctx, config) {
    requireBlock(config, "imap", "folders");
    return await withImap(ctx, config, async (client) => {
      const folders: Array<{ name: string; special_use?: string; messages?: number }> = [];
      for (const entry of await client.list()) {
        const folder: { name: string; special_use?: string; messages?: number } = { name: entry.name };
        const special = specialUse(entry.attributes);
        if (special) folder.special_use = special;
        if (isSelectable(entry)) {
          const info = await client.select(entry.name, { readOnly: true });
          folder.messages = info.exists;
        }
        folders.push(folder);
      }
      return { folders };
    });
  },

  async search(ctx, config, params) {
    requireBlock(config, "imap", "search");
    const folder = folderOf(params);
    const limit = intParam(params, "limit", { fallback: DEFAULT_LIMIT, max: MAX_LIMIT }) as number;
    const criteria = searchCriteria(params);
    return await withImap(ctx, config, async (client) => {
      const box = await client.select(folder, { readOnly: true });
      const uids = await client.search(criteria);
      const newest = [...uids].sort((a, b) => b - a).slice(0, limit);
      const summaries = await client.fetchSummaries(newest);
      summaries.sort((a, b) => b.uid - a.uid);
      return {
        folder,
        uidvalidity: box.uidvalidity,
        total: uids.length,
        messages: summaries.map((s) => ({
          uid: s.uid,
          date: s.internalDate ? s.internalDate.toISOString() : (s.envelope?.date ?? null),
          from: clip(joinAddresses(s.envelope?.from)),
          to: clip(joinAddresses(s.envelope?.to)),
          subject: clip(s.envelope?.subject ?? ""),
          flags: s.flags,
          size: s.size,
        })),
      };
    });
  },

  async read(ctx, config, params) {
    requireBlock(config, "imap", "read");
    const folder = folderOf(params);
    const uid = intParam(params, "uid", { required: true }) as number;
    const maxChars = intParam(params, "max_chars", { fallback: DEFAULT_MAX_CHARS, max: MAX_MAX_CHARS }) as number;
    return await withImap(ctx, config, async (client) => {
      const box = await client.select(folder, { readOnly: true });
      const headers = await client.fetchHeaders(uid, ["message-id", "in-reply-to", "references", "date", "from", "to", "cc", "subject"]);
      const tree = await client.fetchStructure(uid);
      const { text, truncated } = await bestText(ctx, client, uid, tree, maxChars);
      return {
        uid,
        folder,
        uidvalidity: box.uidvalidity,
        message_id: headers["message-id"] ?? null,
        in_reply_to: headers["in-reply-to"] ?? null,
        references: headers["references"] ?? null,
        date: headers["date"] ?? null,
        from: headers["from"] ?? null,
        to: headers["to"] ?? null,
        cc: headers["cc"] ?? null,
        subject: headers["subject"] ?? null,
        text,
        truncated,
        attachments: attachmentParts(tree).map((part) => ({
          part: part.part,
          filename: partFilename(part),
          content_type: `${part.type}/${part.subtype}`,
          size: part.size,
        })),
      };
    });
  },

  async attachment(ctx, config, params) {
    requireBlock(config, "imap", "attachment");
    const folder = folderOf(params);
    const uid = intParam(params, "uid", { required: true }) as number;
    const wanted = requireParam(params, "part");
    if (!ctx.writer) throw new Error("mail: the attachment action ran without a file writer");
    const writer = ctx.writer;
    return await withImap(ctx, config, async (client) => {
      await client.select(folder, { readOnly: true });
      const tree = await client.fetchStructure(uid);
      // Only a part `read` would list is fetchable. That is the whole guard
      // against an agent naming an arbitrary section (the body text,
      // HEADER, a multipart container): its string never reaches the wire
      // unless it equals the number of a listed attachment.
      const part = attachmentParts(tree).find((p) => p.part === wanted);
      if (!part) throw new AgentError(`part ${JSON.stringify(wanted)} is not an attachment of message ${uid}; take part from read's attachments`);
      const label = `attachment part ${JSON.stringify(part.part)}`;
      const encoding = part.encoding ?? "7bit";
      const ceiling = encodedCeiling(encoding);
      if (ceiling === null) throw new AgentError(`${label} uses the ${encoding} transfer encoding, which cannot be decoded`);
      // Three checks, one per thing that can be too big: the size the
      // structure declares, the bytes the server actually sends, and what
      // they decode to.
      if (part.size != null && part.size > ceiling) throw overCap(label, `${mib(part.size)} MiB encoded`);
      const bytes = transferDecode(await fetchWhole(client, uid, part, ceiling, label), encoding);
      if (bytes.length > MAX_ATTACHMENT_BYTES) throw overCap(label, `${mib(bytes.length)} MiB`);
      const contentType = `${part.type}/${part.subtype}`.toLowerCase();
      const filename = safeFilename(partFilename(part)) ?? `attachment-${uid}-${part.part}.${extensionFor(contentType)}`;
      // The writer's own refusals (the instance's MIME allowlist, its file
      // size cap) are YapErrors and reach the agent as they are.
      const file = await writer.writeFile({ name: filename, mimeType: contentType, bytes });
      return { uid, folder, part: part.part, filename, content_type: contentType, size: bytes.length, file };
    });
  },

  async mark(ctx, config, params) {
    requireBlock(config, "imap", "mark");
    const folder = folderOf(params);
    const uid = intParam(params, "uid", { required: true }) as number;
    const flag = params["flag"] ?? "";
    const mapping = Object.hasOwn(MARK_FLAGS, flag) ? MARK_FLAGS[flag] : undefined;
    if (!mapping) throw new AgentError(`flag must be one of ${Object.keys(MARK_FLAGS).join(", ")}`);
    return await withImap(ctx, config, async (client) => {
      await client.select(folder, { readOnly: false });
      const flags = await client.store(uid, mapping[0], [mapping[1]]);
      return { uid, flags };
    });
  },

  async send(ctx, config, params) {
    requireBlock(config, "smtp", "send");
    const draft = composeParams_(params, ctx.pinned);
    if (draft.replyToUid !== undefined) requireBlock(config, "imap", "send with reply_to_uid", "reply_to_uid");
    if (config.save_sent) requireBlock(config, "imap", "send with save_sent", "save_sent");
    const attachments = await loadAttachments(ctx, draft);

    let imap: ImapClient | null = null;
    try {
      if (draft.replyToUid !== undefined || config.save_sent) imap = await imapConnect(ctx, config);
      // Everything that can fail is settled before a byte of mail leaves:
      // the thread lookup, the Sent-folder discovery, and the message build.
      const sentFolder = config.save_sent && imap ? await discoverFolder(imap, config.sent_folder, "\\SENT", "sent", "sent_folder") : null;
      const { message, messageId, recipients } = await composeMessage(config, draft, imap, { bccHeader: false, attachments });
      await smtpSend(ctx, await smtpConfig(ctx, config), { from: config.from, to: recipients, message }).catch((e: unknown) => {
        // The address and the reply line may name a pinned recipient: log them, tell the agent only the verdict.
        const rejections = e instanceof ProtocolError && e.step === "RCPT TO" ? e["rejections"] : undefined;
        if (!Array.isArray(rejections)) throw e;
        for (const r of rejections as SmtpRejection[]) ctx.log(`send: recipient ${r.address} refused: ${r.reply}`);
        throw new AgentError("the server refused a recipient");
      });
      if (sentFolder && imap) {
        try {
          await imap.append(sentFolder, message, ["\\Seen"]);
        } catch (e) {
          // The mail is out; failing the run now would invite a duplicate send.
          ctx.log(`send: delivered, but the copy to ${JSON.stringify(sentFolder)} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return { accepted: true, message_id: messageId, ...attachmentsResult(attachments) };
    } finally {
      if (imap) await imap.logout();
    }
  },

  async draft(ctx, config, params) {
    requireBlock(config, "imap", "draft");
    const draft = composeParams_(params, ctx.pinned);
    // Read before connecting: a reference that does not resolve, or a total
    // over the cap, fails the run before the mailbox is touched at all.
    const attachments = await loadAttachments(ctx, draft);
    return await withImap(ctx, config, async (client) => {
      const folder = await discoverFolder(client, config.drafts_folder, "\\DRAFTS", "drafts", "drafts_folder");
      const { message } = await composeMessage(config, draft, client, { bccHeader: true, attachments });
      const { uid } = await client.append(folder, message, ["\\Draft"]);
      return { folder, uid, ...attachmentsResult(attachments) };
    });
  },

  async delete_draft(ctx, config, params) {
    requireBlock(config, "imap", "delete_draft");
    const uid = intParam(params, "uid", { required: true }) as number;
    return await withImap(ctx, config, async (client) => {
      const folder = await discoverFolder(client, config.drafts_folder, "\\DRAFTS", "drafts", "drafts_folder");
      await client.deleteDraft(folder, uid);
      return { folder, uid };
    });
  },
};

// ---------------------------------------------------------------------------
// Connections

async function withImap<T>(ctx: MailCtx, config: MailConfig, fn: (client: ImapClient) => Promise<T>): Promise<T> {
  const client = await imapConnect(ctx, config);
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}

async function smtpConfig(ctx: MailCtx, config: MailConfig): Promise<SmtpSessionConfig> {
  if (!config.smtp) throw new Error("smtpConfig: the config has no smtp block");
  return { ...config.smtp, allow_plaintext_auth: config.allow_plaintext_auth, auth: await resolveAuth(ctx, config) };
}

function requireBlock(config: MailConfig, block: "imap" | "smtp", what: string, because?: string): void {
  if (config[block]) return;
  const reason = because ? `${because} requires an ${block} block` : `the ${what} action requires an ${block} block`;
  throw new AgentError(`${reason} in the service config`);
}

/**
 * The run boundary: an AgentError, or a protocol error the IMAP client tagged
 * with an `agent` verdict, becomes a `YapError` the runner shows verbatim;
 * anything else passes through untouched and collapses on the run row.
 */
function agentVisible(e: unknown): unknown {
  if (e instanceof AgentError) return withCause(new YapError(e.code, e.message), e);
  if (e instanceof ProtocolError) {
    const agent = e["agent"];
    if (agent === "not_found" || agent === "invalid_request") return withCause(new YapError(agent, e.message), e);
  }
  return e;
}

function withCause(err: YapError, cause: unknown): YapError {
  err.cause = cause;
  return err;
}

/** Prefixes any failure with the protocol it came from, for authoring-time output. */
async function labelled(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`${label}: ${message}`, { cause: e });
  }
}

// ---------------------------------------------------------------------------
// Parameters

function folderOf(params: Params): string {
  const folder = params["folder"];
  if (folder === undefined || folder === "") return "INBOX";
  if (typeof folder !== "string" || /[\r\n\0]/.test(folder)) throw new AgentError("folder must be a mailbox name");
  return folder;
}

interface IntOptions {
  required?: boolean;
  fallback?: number;
  max?: number;
}

function intParam(params: Params, name: string, { required = false, fallback, max }: IntOptions = {}): number | undefined {
  const raw = params[name];
  if (raw === undefined || raw === "") {
    if (required) throw new AgentError(`${name} is required`);
    return fallback;
  }
  if (!/^\d+$/.test(String(raw).trim()) || Number(raw) < 1) throw new AgentError(`${name} must be a positive integer`);
  const value = Number(raw);
  return max !== undefined ? Math.min(value, max) : value;
}

/** "2025-02-01" → "1-Feb-2025"; anything that is not a real calendar day is refused. */
function imapDate(value: string, name: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  const month = m ? Number(m[2]) - 1 : -1;
  const day = m ? Number(m[3]) : -1;
  const date = m ? new Date(Date.UTC(Number(m[1]), month, day)) : null;
  if (!date || Number.isNaN(date.getTime()) || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    throw new AgentError(`${name} must be a date written as YYYY-MM-DD`);
  }
  return `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

/** Needs a literal on the wire? Mirrors imap.ts: non-ASCII, quotes, backslashes. */
function needsLiteral(text: string): boolean {
  return !/^[\x20-\x7e]*$/.test(text) || /["\\]/.test(text);
}

function searchCriteria(params: Params): SearchCriterion[] {
  const criteria: SearchCriterion[] = [];
  if (params["unseen"] === "true") criteria.push("UNSEEN");
  const since = params["since"];
  if (since !== undefined && since !== "") criteria.push("SINCE", imapDate(since, "since"));
  const before = params["before"];
  if (before !== undefined && before !== "") criteria.push("BEFORE", imapDate(before, "before"));

  const texts: Array<{ key: string; value: string }> = [];
  const textFields: Array<[string, string]> = [
    ["from", "FROM"],
    ["to", "TO"],
    ["subject", "SUBJECT"],
    ["query", "TEXT"],
  ];
  for (const [name, key] of textFields) {
    const value = params[name];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw new AgentError(`${name} must be a single line of text`);
    if (value.length > MAX_SEARCH_TEXT_CHARS) throw new AgentError(`${name} may be at most ${MAX_SEARCH_TEXT_CHARS} characters`);
    texts.push({ key, value });
  }
  const literals = texts.filter((t) => needsLiteral(t.value));
  if (literals.length > 1) {
    throw new AgentError(
      `only one of from, to, subject, query may contain non-ASCII text or quotes per search (${literals.map((t) => t.key.toLowerCase()).join(", ")} do)`,
    );
  }
  // The one literal, if any, must end the command.
  for (const t of [...texts.filter((t) => !needsLiteral(t.value)), ...literals]) criteria.push(t.key, { literal: t.value });

  return criteria.length ? criteria : ["ALL"];
}

function clip(text: string): string {
  return text.length > SUMMARY_FIELD_CHARS ? text.slice(0, SUMMARY_FIELD_CHARS) : text;
}

function joinAddresses(list: string[] | undefined): string {
  return Array.isArray(list) ? list.join(", ") : "";
}

// ---------------------------------------------------------------------------
// Folders

function specialUse(attributes: string[]): string | null {
  for (const attr of attributes) {
    const use = SPECIAL_USE[attr.toUpperCase()];
    if (use) return use;
  }
  return null;
}

function isSelectable(entry: MailboxInfo): boolean {
  return !entry.attributes.some((a) => /^\\(noselect|nonexistent)$/i.test(a));
}

function lastSegment(entry: MailboxInfo): string {
  const parts = entry.delimiter ? entry.name.split(entry.delimiter) : [entry.name];
  return parts[parts.length - 1] ?? entry.name;
}

/**
 * Configured name → SPECIAL-USE attribute → a selectable folder whose last
 * path segment is `plainName` (case-insensitive) → an error naming the config
 * field that would settle it.
 */
async function discoverFolder(client: ImapClient, configured: string | undefined, attribute: string, plainName: string, field: string): Promise<string> {
  if (configured) return configured;
  const entries = await client.list();
  const byAttr = entries.find((e) => e.attributes.some((a) => a.toUpperCase() === attribute));
  if (byAttr) return byAttr.name;
  const byName = entries.find((e) => isSelectable(e) && lastSegment(e).toLowerCase() === plainName);
  if (byName) return byName.name;
  throw new AgentError(`no ${plainName} folder found on the server — set ${field} in the service config`);
}

// ---------------------------------------------------------------------------
// Reading

async function bestText(ctx: MailCtx, client: ImapClient, uid: number, tree: BodyPart, maxChars: number): Promise<{ text: string; truncated: boolean }> {
  const parts = textParts(tree);
  const part = parts.find((p) => p.subtype === "plain") ?? parts.find((p) => p.subtype === "html") ?? parts[0];
  if (!part) {
    ctx.log(`read: message ${uid} has no text part`);
    return { text: "", truncated: false };
  }
  const { buffer, truncated: cut } = await client.fetchSection(uid, part.part, { maxBytes: TEXT_SECTION_BYTES, size: part.size });
  let text = decodeText(buffer, part.encoding, part.params["charset"]);
  if (part.subtype === "html") {
    text = htmlToText(text, {
      wordwrap: false,
      selectors: [
        { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
        { selector: "img", format: "skip" },
      ],
    });
  }
  text = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const truncated = cut || text.length > maxChars;
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return { text, truncated };
}

function decodeText(buffer: Buffer, encoding: string | null, charset: string | null | undefined): string {
  const bytes = transferDecode(buffer, encoding);
  const cs = (charset ?? "utf-8").toLowerCase();
  return iconv.encodingExists(cs) ? iconv.decode(bytes, cs) : bytes.toString("utf8");
}

/** Undo the Content-Transfer-Encoding; anything but base64 and
 * quoted-printable is taken as it came (7bit, 8bit, binary). */
function transferDecode(buffer: Buffer, encoding: string | null): Buffer {
  const enc = encoding?.toLowerCase();
  if (enc === "base64") return Buffer.from(buffer.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (enc === "quoted-printable") return decodeQuotedPrintable(buffer);
  return buffer;
}

/** RFC 2045 §6.7: soft line breaks vanish (whitespace a transport added
 * after the "=" included), =XX becomes a byte. */
function decodeQuotedPrintable(buffer: Buffer): Buffer {
  const text = buffer.toString("latin1").replace(/=[ \t]*\r?\n/g, "");
  return Buffer.from(
    text.replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
    "latin1",
  );
}

// ---------------------------------------------------------------------------
// Attachments

/**
 * How many wire bytes an encoding may spend per decoded byte, line breaks
 * included. These bound how much is read before the decoded cap is checked,
 * so they lean generous. base64 is 4/3 plus a CRLF per line: 1.5 covers lines
 * down to 24 characters, well past the 76 and 64 that encoders use (RFC 2045
 * sets a maximum line length, no minimum, so a stranger wrapping is refused
 * as over the limit rather than read without bound); quoted-printable is up to
 * "=XX" per byte with a soft break every 75 characters (78/25); the identity
 * encodings carry the bytes as they are, with room for CRLF normalisation.
 * Unknown encodings have no entry and are refused rather than stored raw.
 */
const ENCODING_EXPANSION: Record<string, number> = {
  base64: 1.5,
  "quoted-printable": 3.2,
  "7bit": 1.05,
  "8bit": 1.05,
  binary: 1,
};

/** The most encoded bytes an attachment under the cap could take, or null
 * for an encoding the driver cannot decode. */
function encodedCeiling(encoding: string): number | null {
  if (!Object.hasOwn(ENCODING_EXPANSION, encoding)) return null;
  return Math.ceil(MAX_ATTACHMENT_BYTES * ENCODING_EXPANSION[encoding]!) + 64 * 1024;
}

function overCap(label: string, size: string): AgentError {
  return new AgentError(`${label} is over the ${mib(MAX_ATTACHMENT_BYTES)} MiB limit (${size})`);
}

function mib(bytes: number): string {
  const value = bytes / 1024 / 1024;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * The whole encoded part. Past `ceiling` it cannot decode to something under
 * the cap, so the client stops reading there; and a part that ends before
 * the size its BODYSTRUCTURE gave is incomplete. Both are refused: a partial
 * file is never stored.
 */
async function fetchWhole(client: ImapClient, uid: number, part: BodyPart, ceiling: number, label: string): Promise<Buffer> {
  const { buffer, exceeded } = await client.fetchSectionWhole(uid, part.part, { limit: ceiling });
  if (exceeded) throw overCap(label, `more than ${mib(ceiling)} MiB encoded`);
  if (part.size != null && buffer.length < part.size) {
    throw new AgentError(`${label} came back incomplete from the server (${buffer.length} of ${part.size} bytes); try again`);
  }
  return buffer;
}

/**
 * An attachment's own name, made safe to store: control characters (C0, DEL,
 * C1), bidirectional overrides (which can make "x\u202Efdp.exe" display as
 * "xexe.pdf"), and path separators become "_"; leading dots and spaces go (no
 * hidden or relative-looking names); and an over-long name is shortened from
 * the middle, by code point, so its extension survives. Null when nothing
 * usable is left.
 */
function safeFilename(raw: string | null): string | null {
  if (!raw) return null;
  let name = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069/\\]+/g, "_")
    .trim()
    .replace(/^[.\s]+/, "");
  if (!name || /^_+$/.test(name)) return null;
  // files.ts counts UTF-16 units against 255; cutting whole code points
  // under that count never leaves half a surrogate pair behind.
  const MAX = 255;
  if (name.length > MAX) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    let base = "";
    for (const ch of name.slice(0, dot > 0 && ext ? dot : name.length)) {
      if (base.length + ch.length + ext.length > MAX) break;
      base += ch;
    }
    name = base + ext;
  }
  return name;
}

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/json": "json",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.ms-excel": "xls",
  "application/octet-stream": "bin",
  "audio/mpeg": "mp3",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/svg+xml": "svg",
  "message/rfc822": "eml",
  "text/calendar": "ics",
  "text/csv": "csv",
  "text/html": "html",
  "text/plain": "txt",
  "video/mp4": "mp4",
};

/** A file extension for a nameless attachment: a known one, else a short
 * plain subtype ("x-foo" is not one), else "bin". */
function extensionFor(contentType: string): string {
  if (Object.hasOwn(EXTENSIONS, contentType)) return EXTENSIONS[contentType]!;
  const subtype = contentType.slice(contentType.indexOf("/") + 1);
  return /^[a-z0-9]{1,5}$/.test(subtype) ? subtype : "bin";
}

// ---------------------------------------------------------------------------
// Composing

/** The three parameters that decide where mail goes; a pin on any one of them
 * speaks for all three (see the header). */
const RECIPIENT_FIELDS = ["to", "cc", "bcc"] as const;
type RecipientField = (typeof RECIPIENT_FIELDS)[number];

interface Draft {
  to: string[] | undefined;
  cc: string[];
  bcc: string[];
  body: string;
  subject: string | undefined;
  replyToUid: number | undefined;
  folder: string;
  /** File references to attach, in order; empty for a plain message. */
  attachments: string[];
  /** Whether `attachments` came from a pin, and so must not be echoed. */
  attachmentsPinned: boolean;
}

/** Validates the shared send/draft parameters; the header checks run before
 * any connection is opened so an injection attempt costs nothing. Everything
 * thrown in here is about the agent's own input, so it is all agent-visible
 * — including message.ts's address and header checks. */
function composeParams_(params: Params, pinned: readonly string[]): Draft {
  try {
    const pinnedRecipients = RECIPIENT_FIELDS.filter((field) => pinned.includes(field));
    const recipientsLocked = pinnedRecipients.length > 0;
    const list = (field: RecipientField): string[] | undefined => {
      const raw = params[field];
      if (raw === undefined || raw === "") return undefined;
      // The host already refuses a *pinned* name; this refuses the unpinned
      // siblings, which is what makes the pin mean "recipients are fixed".
      if (recipientsLocked && !pinnedRecipients.includes(field)) {
        throw new AgentError(`recipients are fixed on this service; ${field} cannot be supplied`);
      }
      return parseAddresses(raw, field);
    };
    const to = list("to");
    const cc = list("cc") ?? [];
    const bcc = list("bcc") ?? [];
    // message.ts re-checks this on the headers it writes; the envelope-only
    // bcc of a *sent* message never reaches those headers, so the one count
    // that covers every recipient lives here. A reply derives exactly one
    // address when `to` is absent, and it counts.
    if ((to?.length ?? 1) + cc.length + bcc.length > MAX_RECIPIENTS) {
      throw new AgentError(`a message may have at most ${MAX_RECIPIENTS} recipients across to, cc, and bcc`);
    }
    const body = requireParam(params, "body");
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new AgentError(`body may be at most ${MAX_BODY_BYTES / 1024 / 1024} MiB`);
    const rawSubject = params["subject"];
    const subject = rawSubject === undefined || rawSubject === "" ? undefined : assertHeaderSafe(rawSubject, "subject");
    const rawReply = params["reply_to_uid"];
    const replyToUid = rawReply === undefined || rawReply === "" ? undefined : intParam(params, "reply_to_uid", { required: true });
    if (replyToUid === undefined) {
      if (to === undefined) throw new AgentError("to is required unless reply_to_uid is given");
      if (subject === undefined) throw new AgentError("subject is required unless reply_to_uid is given");
    } else if (to === undefined && recipientsLocked) {
      // Deriving `to` from an arbitrary message would be aiming by proxy.
      throw new AgentError("recipients are fixed on this service; a reply cannot derive `to` from the original message");
    }
    const attachmentsPinned = pinned.includes("attachments");
    const attachments = attachmentRefs(params["attachments"], attachmentsPinned);
    return { to, cc, bcc, body, subject, replyToUid, folder: folderOf(params), attachments, attachmentsPinned };
  } catch (e) {
    throw e instanceof AgentError ? e : new AgentError(e instanceof Error ? e.message : String(e));
  }
}

/**
 * "file://a, b" → ["file://a", "b"]: split on commas, trimmed, empty entries
 * dropped, each checked for shape and for not repeating another (a bare id
 * and its file:// form are the same file). Nothing is resolved here, so a
 * bad list costs no reads. A pinned list is the operator's and is never
 * quoted back.
 */
function attachmentRefs(raw: string | undefined, pinned: boolean): string[] {
  if (raw === undefined) return [];
  const refs = raw.split(",").map((ref) => ref.trim()).filter((ref) => ref !== "");
  if (refs.length > MAX_OUTBOUND_ATTACHMENTS) {
    throw new AgentError(`attachments may list at most ${MAX_OUTBOUND_ATTACHMENTS} files (got ${refs.length})`);
  }
  const seen = new Set<string>();
  for (const ref of refs) {
    const id = ref.startsWith(FILE_REF_PREFIX) ? ref.slice(FILE_REF_PREFIX.length) : ref;
    if (!FILE_ID_RE.test(id)) {
      throw new AgentError(pinned ? "a pinned attachment is not a file reference" : `attachment ${JSON.stringify(ref.slice(0, 100))} is not a file://{uuid} reference or file id`);
    }
    const key = id.toLowerCase();
    if (seen.has(key)) throw new AgentError(pinned ? "a pinned attachment is listed more than once" : `attachment ${JSON.stringify(ref)} is listed more than once`);
    seen.add(key);
  }
  return refs;
}

/**
 * The files named in `attachments`, read through the run's bundle reader —
 * the one way this driver reaches file bytes. Every reference is resolved
 * first and the total checked against the file records, so an unknown
 * reference or an oversized request fails before a byte is read; then each
 * file is read with the remaining budget as its ceiling, so a record that
 * understates its size cannot carry the total past the cap either. The
 * reader confines this to finalized files of the run's own bundle and
 * audits each read; its not-found becomes an error naming the reference.
 */
async function loadAttachments(ctx: RunContext, draft: Draft): Promise<MessageAttachment[]> {
  if (draft.attachments.length === 0) return [];
  const reader = ctx.reader;
  if (!reader) throw new Error("mail: attachments were given but the run has no file reader");
  const label = (ref: string): string => (draft.attachmentsPinned ? "a pinned attachment" : `attachment ${JSON.stringify(ref)}`);
  const resolved = [];
  for (const ref of draft.attachments) {
    try {
      resolved.push({ ref, file: await reader.readFile(ref) });
    } catch (e) {
      if (e instanceof YapError && (e.code === "not_found" || e.code === "invalid_request")) {
        throw new AgentError(`${label(ref)} is not a file in this bundle`, "not_found");
      }
      throw e;
    }
  }
  const capMiB = MAX_OUTBOUND_ATTACHMENT_BYTES / 1024 / 1024;
  const total = resolved.reduce((sum, { file }) => sum + file.size, 0);
  if (total > MAX_OUTBOUND_ATTACHMENT_BYTES) {
    throw new AgentError(`attachments total ${mib(total)} MiB; the cap is ${capMiB} MiB`);
  }
  const out: MessageAttachment[] = [];
  let remaining = MAX_OUTBOUND_ATTACHMENT_BYTES;
  for (const { ref, file } of resolved) {
    let bytes: Uint8Array;
    try {
      bytes = await file.bytes({ maxBytes: remaining });
    } catch (e) {
      if (e instanceof YapError && e.code === "payload_too_large") {
        throw new AgentError(`${label(ref)} takes the attachments past the ${capMiB} MiB cap`);
      }
      throw e;
    }
    remaining -= bytes.byteLength;
    const attachment = { filename: file.name, mimeType: file.mimeType, bytes };
    try {
      // The same header checks buildMessage applies, run now so a name with
      // a line break in it (the uploader chose it) fails before any mailbox
      // or server is touched, and as an error the caller can act on.
      attachmentSummary([attachment]);
    } catch (e) {
      throw new AgentError(`${label(ref)}: ${e instanceof Error ? e.message : String(e)}`);
    }
    out.push(attachment);
  }
  return out;
}

/** The `attachments` key of a draft or send result: present only when the
 * message carried files, so a plain message's result keeps its old shape. */
function attachmentsResult(attachments: readonly MessageAttachment[]): { attachments?: ReturnType<typeof attachmentSummary> } {
  return attachments.length > 0 ? { attachments: attachmentSummary(attachments) } : {};
}

function requireParam(params: Params, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value === "") throw new AgentError(`${name} is required`);
  return value;
}

/**
 * The bare address out of a header value like `Alice <alice@example.com>`,
 * `alice@example.com`, or a group/list — the first mailbox only, validated by
 * the same strict rule outbound addresses pass, so an original sender with an
 * unparseable From cannot smuggle anything into our own To header.
 */
function firstAddress(headerValue: string | undefined): string | undefined {
  if (!headerValue) return undefined;
  const angle = /<([^<>\s]+)>/.exec(headerValue);
  const candidate = angle ? angle[1] : headerValue.trim().split(/[\s,;]+/)[0];
  return candidate && isAddress(candidate) ? candidate : undefined;
}

async function composeMessage(
  config: MailConfig,
  draft: Draft,
  imap: ImapClient | null,
  { bccHeader, attachments }: { bccHeader: boolean; attachments: readonly MessageAttachment[] },
): Promise<{ message: Buffer; messageId: string; recipients: string[] }> {
  let { subject, to } = draft;
  let inReplyTo: string | undefined;
  let references: string[] | undefined;
  if (draft.replyToUid !== undefined) {
    if (!imap) throw new Error("composeMessage: a reply needs an IMAP connection");
    await imap.select(draft.folder, { readOnly: true });
    const original = await imap.fetchHeaders(draft.replyToUid, ["message-id", "references", "subject", "reply-to", "from"]);
    if (to === undefined) {
      // A reply goes back to whoever asked for replies — Reply-To first, else
      // the sender. Not a guess worth making silently when neither parses.
      // (composeParams_ already refused this on a service whose recipients
      // are fixed.)
      const address = firstAddress(original["reply-to"]) ?? firstAddress(original["from"]);
      if (!address) throw new AgentError("the original message has no usable Reply-To or From address; supply `to`");
      to = [address];
    }
    const originalId = original["message-id"];
    if (originalId) {
      inReplyTo = originalId;
      references = [...(original["references"] ?? "").split(/\s+/).filter(Boolean), originalId];
    }
    if (subject === undefined) {
      const originalSubject = original["subject"] ?? "";
      subject = /^re:/i.test(originalSubject.trim()) ? originalSubject : `Re: ${originalSubject}`;
    }
  }
  if (to === undefined || subject === undefined) {
    // composeParams_ guarantees both outside a reply; this is the type system's
    // assurance, not a reachable branch.
    throw new Error("composeMessage: missing recipient or subject");
  }
  const messageId = makeMessageId(config.from.slice(config.from.lastIndexOf("@") + 1));
  const message = buildMessage({
    from: config.from,
    fromName: config.name,
    to,
    cc: draft.cc,
    // A draft keeps Bcc as a header for the mail client to honour at send
    // time; a message going out now carries its bcc on the envelope only.
    ...(bccHeader ? { bcc: draft.bcc } : {}),
    subject,
    body: draft.body,
    inReplyTo,
    references,
    messageId,
    attachments,
  });
  return { message, messageId, recipients: [...to, ...draft.cc, ...draft.bcc] };
}
