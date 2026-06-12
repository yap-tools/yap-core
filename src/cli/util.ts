/** An operator-facing CLI failure: printed as one line, no stack trace. */
import { realpathSync } from "node:fs";

export class CliError extends Error {}

export function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}
