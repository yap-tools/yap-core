/**
 * The example external driver: send mail over SMTP.
 *
 * It exists to be read as much as to be used — it is the reference for what a
 * driver written *outside* Yap looks like, and it exercises every part of the
 * injection contract:
 *
 * - It imports nothing. The whole contract arrives on `ctx`: the decrypted
 *   config, the caller's parameters (pins already merged in), the guarded
 *   network door, the abort signal, and a log sink. There is no Yap module to
 *   depend on and no version of Yap to track.
 * - It declares `egress: true` and reaches the network only through
 *   `ctx.egress.connect()`, which resolves the host itself and refuses private,
 *   link-local, and loopback addresses unless the operator allowlisted them.
 *   The socket it hands back belongs to *this* driver, so the `finally` below
 *   closes it — nothing else will.
 * - It honours `ctx.signal`: every read races the signal, so a run that hits
 *   its budget tears the session down instead of holding a socket open.
 * - It declares its own parameters, which is what makes a *pin* possible: an
 *   operator who fixes `to` at authoring time gets a service an agent can send
 *   through but cannot aim. See README.md.
 *
 * The SMTP itself is deliberately minimal: greeting, EHLO, optional AUTH LOGIN,
 * MAIL FROM, RCPT TO, DATA, QUIT — one plain-text, UTF-8 message to one
 * recipient. It is not a mail library; it is the smallest thing that really
 * talks to a real server.
 *
 * Failures are plain Errors carrying the server's reply line. Yap's runs layer
 * treats a non-sanitized driver error as "run failed" for the agent (a reply
 * line can echo an address), so the reply text survives only in `ctx.log` —
 * which is why every reply is logged.
 */

/** Wall-clock budget for opening the connection; the action's own timeoutMs
 * (and the run's) still bound the session as a whole. */
const CONNECT_TIMEOUT_MS = 10_000;

export default {
  name: "smtp",
  api: 1,
  description: "Sends a plain-text email over SMTP.",
  egress: true,
  configDoc: [
    "host: the SMTP server's hostname (required)",
    "port: its port, 1-65535 — commonly 587 (STARTTLS-less submission), 465 (implicit TLS), or 25 (required)",
    "secure: true to wrap the connection in TLS from the first byte, as port 465 expects (default false)",
    "user / pass: credentials for AUTH LOGIN — set both or neither (optional)",
    "from: the envelope and From: address mail is sent as (required)",
    "",
    "Pin the `to` parameter when authoring the service to fix the recipient: the agent then supplies",
    "only subject and body, and cannot choose who receives the mail.",
  ].join("\n"),

  validateConfig(config) {
    assertConfig(config);
  },

  // No validateConfigOnline: `egress.assertPublic` vouches for http(s) URLs
  // only, and an SMTP destination is a host and a port. The guard that matters
  // for this driver is the one inside `egress.connect`, which re-resolves and
  // re-checks at run time anyway.

  actions: {
    send: {
      description: "Send one plain-text email.",
      params: [
        { name: "to", description: "Recipient email address", required: true },
        { name: "subject", description: "Subject line", required: true },
        { name: "body", description: "Plain-text message body", required: true },
      ],
      timeoutMs: 30_000,
    },
  },

  async run(ctx) {
    const config = assertConfig(ctx.config);
    const to = requireParam(ctx.params, "to");
    const subject = requireParam(ctx.params, "subject");
    const body = requireParam(ctx.params, "body");
    assertAddress(to, 'the "to" parameter');
    // A line break here would end the header block and let a caller inject
    // headers (or a body) of its own — the mail equivalent of header smuggling.
    if (/[\r\n]/.test(subject)) throw new Error('the "subject" parameter must not contain a line break');

    const message = buildMessage({ from: config.from, to, subject, body });

    const socket = await ctx.egress.connect(config.host, config.port, {
      tls: config.secure === true,
      signal: ctx.signal,
      timeoutMs: CONNECT_TIMEOUT_MS,
    });
    const session = createSession(socket, ctx);
    try {
      await session.expect([220], "greeting");
      await session.command("EHLO yap", [250], "EHLO");
      if (config.user !== undefined) {
        await session.command("AUTH LOGIN", [334], "AUTH LOGIN");
        await session.command(base64(config.user), [334], "AUTH LOGIN username", "<username>");
        await session.command(base64(config.pass), [235], "AUTH LOGIN password", "<password>");
      }
      await session.command(`MAIL FROM:<${config.from}>`, [250], "MAIL FROM");
      await session.command(`RCPT TO:<${to}>`, [250, 251], "RCPT TO");
      await session.command("DATA", [354], "DATA");
      // The message, then the lone dot that ends it. Body lines starting with a
      // dot were stuffed while building the message, so no line of the payload
      // can impersonate this terminator.
      await session.command(
        `${message}\r\n.`,
        [250],
        "message",
        `<message, ${Buffer.byteLength(message, "utf8")} bytes>`,
      );
      try {
        await session.command("QUIT", [221], "QUIT");
      } catch {
        // Best effort: the mail is accepted once the DATA terminator got its
        // 250, so a server that hangs up during QUIT has still taken it.
      }
      return { accepted: [to] };
    } finally {
      // The socket is the driver's — `egress.dispose()` does not touch it.
      // `end()` immediately followed by `destroy()` is not a belt-and-braces
      // teardown, it is a race: `destroy()` tears the socket down before the
      // FIN `end()` queued has any chance to reach the peer, so the first
      // call would be dead code. We want the FIN sent — QUIT may not have
      // gotten a reply (see the `catch` above), so this may be the only
      // signal the peer gets that the session is over — but we still want a
      // hard close if the peer never reciprocates, rather than leaning on
      // `ctx.egress`'s own budget. So: `end()` to close gracefully, then
      // `destroy()` only if the socket has not already finished closing on
      // its own within a short grace period.
      session.dispose();
      socket.end();
      const graceTimer = setTimeout(() => socket.destroy(), 200);
      socket.once("close", () => clearTimeout(graceTimer));
      if (graceTimer.unref) graceTimer.unref();
    }
  },
};

// ---- Config and parameters --------------------------------------------------

/**
 * Structurally validates a service config, throwing an Error that names the
 * offending field (Yap turns that into an authoring-time 400). Used both by
 * `validateConfig` at authoring time and by `run`, since the config reaching a
 * run was written by an older version of this driver as easily as by this one.
 */
function assertConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("smtp config must be an object");
  }
  const { host, port, secure, user, pass } = config;
  if (typeof host !== "string" || host.trim() === "") {
    throw new Error("host must be a non-empty string");
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  if (secure !== undefined && typeof secure !== "boolean") {
    throw new Error("secure must be a boolean when present");
  }
  if (user !== undefined && (typeof user !== "string" || user === "")) {
    throw new Error("user must be a non-empty string when present");
  }
  if (pass !== undefined && (typeof pass !== "string" || pass === "")) {
    throw new Error("pass must be a non-empty string when present");
  }
  if ((user === undefined) !== (pass === undefined)) {
    throw new Error("user and pass must be set together, or neither");
  }
  assertAddress(config.from, "from");
  return config;
}

/** A single address, strictly enough to keep CR/LF and grouping syntax out. */
function assertAddress(value, field) {
  if (typeof value !== "string" || !/^[^\s<>@,;:\\"]+@[^\s<>@,;:\\"]+\.[^\s<>@,;:\\"]+$/.test(value)) {
    throw new Error(`${field} must be a single email address like "name@example.com"`);
  }
}

function requireParam(params, name) {
  const value = params[name];
  if (typeof value !== "string" || value === "") throw new Error(`the "${name}" parameter is required`);
  return value;
}

// ---- The message ------------------------------------------------------------

function base64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * RFC 2047 encoded word for a header value with non-ASCII in it. The body may
 * carry raw UTF-8 (the message declares 8bit), but a header may not.
 */
function encodeHeader(value) {
  const isAscii = [...value].every((char) => char.codePointAt(0) < 128);
  return isAscii ? value : `=?utf-8?B?${base64(value)}?=`;
}

/** RFC 5322 date: `toUTCString` is the right shape but spells the zone "GMT". */
function rfc5322Date(now) {
  return now.toUTCString().replace(/GMT$/, "+0000");
}

function buildMessage({ from, to, subject, body }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${rfc5322Date(new Date())}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  // Split on every line-break form — CRLF, bare LF, *and bare CR* — not just
  // "\r\n". A lone CR left unsplit would ride inside a "line" and reach the
  // wire raw; a server that treats bare CR as its own line terminator would
  // then see the dot-stuffing (and the CRLF join below) apply to the wrong
  // logical lines. A body containing "\r.\rRCPT TO:<attacker>\r", for example,
  // would put a bare `\r.\r` on the wire — which such a server reads as
  // "<CR>", "." (end of DATA), "<CR>" and everything after it as new SMTP
  // commands: an SMTP smuggling attack that runs right past the pinned
  // recipient. Every line-break form is normalized to a real line break here,
  // so joining with "\r\n" below always emits CRLF and nothing else survives
  // to the wire.
  const lines = body
    .split(/\r\n|\r|\n/)
    .map((line) => (line.startsWith(".") ? `.${line}` : line));
  return `${headers.join("\r\n")}\r\n\r\n${lines.join("\r\n")}`;
}

// ---- The SMTP conversation --------------------------------------------------

/**
 * A line-oriented view of the socket plus the reply grammar on top of it.
 *
 * Two details are the whole reason this is not three lines of `socket.write`:
 * a reply may be *multi-line* (`250-first` … `250 last`, the continuation form
 * a naive parser mistakes for the end), and a reply may never arrive at all —
 * so every read races `ctx.signal`, and a server that closes mid-session fails
 * the pending read instead of hanging the run.
 *
 * A hostile or broken server that never sends a terminating CRLF, or that
 * keeps a `250-` continuation going forever, would otherwise let the pending
 * line and the collected continuation lines grow for the whole timeout
 * budget; both are capped below.
 */
const MAX_REPLY_LINE_BYTES = 64 * 1024;
const MAX_REPLY_CONTINUATION_LINES = 100;

function createSession(socket, ctx) {
  let pending = "";
  const lines = [];
  let waiting = null;
  let failure = null;

  const settle = () => {
    if (!waiting) return;
    if (lines.length > 0) {
      const resolve = waiting.resolve;
      waiting = null;
      resolve(lines.shift());
    } else if (failure) {
      const reject = waiting.reject;
      waiting = null;
      reject(failure);
    }
  };
  const fail = (err) => {
    failure ??= err;
    settle();
  };

  const onData = (chunk) => {
    pending += chunk.toString("utf8");
    if (Buffer.byteLength(pending, "utf8") > MAX_REPLY_LINE_BYTES) {
      fail(new Error(`SMTP reply line exceeded ${MAX_REPLY_LINE_BYTES} bytes without a terminator`));
      return;
    }
    let index;
    while ((index = pending.indexOf("\r\n")) >= 0) {
      lines.push(pending.slice(0, index));
      pending = pending.slice(index + 2);
    }
    settle();
  };
  const onClose = () => fail(new Error("the SMTP server closed the connection"));
  const onAbort = () =>
    fail(Object.assign(new Error("the SMTP session was aborted"), { name: "AbortError" }));

  socket.on("data", onData);
  socket.on("error", fail);
  socket.on("end", onClose);
  socket.on("close", onClose);
  // A signal that was already aborted before this session existed fired its
  // "abort" event in the past — `addEventListener` from here on would never
  // see it, and every future read would hang until the socket itself gave up
  // (or forever, against a server that just sits there). Fail immediately in
  // that case instead of registering a listener that will never fire.
  if (ctx.signal.aborted) {
    onAbort();
  } else {
    ctx.signal.addEventListener("abort", onAbort, { once: true });
  }

  const nextLine = () =>
    new Promise((resolve, reject) => {
      waiting = { resolve, reject };
      settle();
    });

  /** Reads one whole reply, continuation lines included. */
  async function readReply() {
    const collected = [];
    for (;;) {
      const line = await nextLine();
      collected.push(line);
      if (collected.length > MAX_REPLY_CONTINUATION_LINES) {
        throw new Error(`SMTP reply exceeded ${MAX_REPLY_CONTINUATION_LINES} continuation lines`);
      }
      const match = /^(\d{3})([ -]?)/.exec(line);
      if (!match) throw new Error(`unexpected SMTP reply: ${line}`);
      if (match[2] !== "-") return { code: Number(match[1]), lines: collected, last: line };
    }
  }

  return {
    /** Reads a reply and demands one of `codes`, naming the step on failure. */
    async expect(codes, step) {
      // Mirrors the same check in `command()`: a read invoked directly (the
      // greeting, which no command precedes) would otherwise start a
      // `nextLine()` wait with no guarantee the abort listener above is still
      // able to fire for it — checking here, before that wait begins, closes
      // the gap.
      if (ctx.signal.aborted) throw Object.assign(new Error("run aborted"), { name: "AbortError" });
      const reply = await readReply();
      // The transcript goes to the run's log ring, which is where a reply line
      // can be seen without it reaching the agent-visible error column.
      for (const line of reply.lines) ctx.log(`< ${line}`);
      if (!codes.includes(reply.code)) {
        throw new Error(`SMTP ${step} was rejected: ${reply.last}`);
      }
      return reply;
    },

    /** Writes one line and reads its reply. `label` redacts what is logged. */
    async command(line, codes, step, label) {
      if (ctx.signal.aborted) throw Object.assign(new Error("run aborted"), { name: "AbortError" });
      ctx.log(`> ${label ?? line}`);
      socket.write(`${line}\r\n`);
      return await this.expect(codes, step);
    },

    dispose() {
      ctx.signal.removeEventListener("abort", onAbort);
      socket.removeListener("data", onData);
      socket.removeListener("error", fail);
      socket.removeListener("end", onClose);
      socket.removeListener("close", onClose);
    },
  };
}
