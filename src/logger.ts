/**
 * Logger with access-key redaction. Keys can travel as bearer tokens or as a
 * query-parameter fallback (?key=...), and the brief requires Yap to redact
 * keys from its own logs.
 */

const KEY_PATTERN = /yap_[A-Za-z0-9_-]{8,}/g;
const QUERY_KEY_PATTERN = /([?&]key=)[^&\s"']+/gi;

export function redact(input: string): string {
  return input.replace(KEY_PATTERN, "yap_[REDACTED]").replace(QUERY_KEY_PATTERN, "$1[REDACTED]");
}

function redactArg(arg: unknown): unknown {
  if (typeof arg === "string") return redact(arg);
  if (arg instanceof Error) return redact(arg.stack ?? arg.message);
  if (typeof arg === "object" && arg !== null) {
    try {
      return JSON.parse(redact(JSON.stringify(arg)));
    } catch {
      return arg;
    }
  }
  return arg;
}

export interface YapLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(sink: Pick<Console, "debug" | "info" | "log" | "warn" | "error"> = console): YapLogger {
  const wrap =
    (fn: (...a: unknown[]) => void) =>
    (...args: unknown[]) =>
      fn(...args.map(redactArg));
  return {
    debug: wrap(sink.debug.bind(sink)),
    info: wrap(sink.info.bind(sink)),
    log: wrap(sink.log.bind(sink)),
    warn: wrap(sink.warn.bind(sink)),
    error: wrap(sink.error.bind(sink)),
  };
}
