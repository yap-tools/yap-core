import { randomUUID } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Sanitizes a name for use inside a `filename="..."` Content-Disposition
 * value: strips quotes, backslashes, and control characters (CR/LF would
 * otherwise inject into the response header). File names are already validated
 * on write, so this is defense-in-depth for any legacy/edge value. Lives here
 * (dependency-free) to stay importable by both the blob and file layers.
 */
export function headerSafeFilename(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f"\\]/g, "");
}
