/**
 * Domain errors. Both transports translate these uniformly: REST maps to the
 * standard error body { error: { code, message, details? } }; MCP surfaces
 * them as tool errors / per-call results.
 */

export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "conflict"
  | "payload_too_large"
  | "unsupported_media_type"
  | "internal";

const HTTP_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  internal: 500,
};

export class YapError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "YapError";
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }

  toBody(): { error: { code: ErrorCode; message: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export function notFound(what: string, id?: string): YapError {
  return new YapError("not_found", id ? `${what} ${id} not found` : `${what} not found`);
}

export function invalid(message: string, details?: unknown): YapError {
  return new YapError("invalid_request", message, details);
}

/** A file larger than the configured limit — HTTP 413. */
export function tooLarge(message: string, details?: unknown): YapError {
  return new YapError("payload_too_large", message, details);
}

/** A MIME type outside the configured allowlist — HTTP 415. */
export function unsupportedMediaType(message: string, details?: unknown): YapError {
  return new YapError("unsupported_media_type", message, details);
}

export function forbidden(message: string, details?: unknown): YapError {
  return new YapError("forbidden", message, details);
}

export function unauthorized(message = "authentication required"): YapError {
  return new YapError("unauthorized", message);
}
