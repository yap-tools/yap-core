/**
 * Account-level capabilities: what a user may do with their own account, as
 * opposed to the granted capabilities that decide access to a space or
 * bundle (capabilities.ts). Every user holds all of them unless the operator
 * denies some — a per-user deny list, set over the sysadmin lane and empty by
 * default.
 *
 * A denial is read from the user's row on every check, so it binds whatever
 * credential the request arrived with (access key or OAuth token, at any
 * role) and takes effect on the next operation: nothing is cached on a
 * session, and no key or token has to be reissued. It removes authority only —
 * it revokes no credential and deletes nothing — and it never reaches the
 * sysadmin lane, which acts on a user rather than as them.
 */
import { eq } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { forbidden, invalid, notFound } from "./errors.js";

export const ACCOUNT_CAPABILITIES = [
  /** All-or-nothing over the user's own credentials: create, list, rotate
   * and revoke access keys; list and revoke connected-app authorizations. */
  "manage_keys",
  /** Create new spaces. */
  "create_spaces",
] as const;

export type AccountCapability = (typeof ACCOUNT_CAPABILITIES)[number];

function isAccountCapability(value: unknown): value is AccountCapability {
  return (ACCOUNT_CAPABILITIES as readonly unknown[]).includes(value);
}

/**
 * Validates a deny list from an API boundary: an array of known account
 * capability names. Returned deduplicated and in canonical order, so the same
 * set always stores and reads back the same way.
 */
export function checkDeniedCapabilities(input: unknown): AccountCapability[] {
  if (!Array.isArray(input)) {
    throw invalid("deniedCapabilities must be an array of account capability names", {
      allowed: ACCOUNT_CAPABILITIES,
    });
  }
  const unknown = input.filter((value) => !isAccountCapability(value));
  if (unknown.length > 0) {
    throw invalid("deniedCapabilities contains unknown account capabilities", {
      unknown,
      allowed: ACCOUNT_CAPABILITIES,
    });
  }
  return ACCOUNT_CAPABILITIES.filter((capability) => input.includes(capability));
}

export function serializeDeniedCapabilities(denied: readonly AccountCapability[]): string {
  return JSON.stringify(denied);
}

/** Reads the stored column back. Names this version does not know carry no
 * meaning here and are dropped rather than surfaced. */
export function parseDeniedCapabilities(stored: string): AccountCapability[] {
  const parsed: unknown = JSON.parse(stored);
  if (!Array.isArray(parsed)) throw new Error("users.denied_capabilities is not a JSON array");
  return ACCOUNT_CAPABILITIES.filter((capability) => parsed.includes(capability));
}

/** Throws `forbidden`, naming the capability, when the operator has denied it to the user. */
export async function requireAccountCapability(
  db: Db,
  userId: string,
  capability: AccountCapability,
): Promise<void> {
  const { users } = db.tables;
  const rows = await db.client
    .select({ deniedCapabilities: users.deniedCapabilities })
    .from(users)
    .where(eq(users.id, userId));
  const row = rows[0];
  if (!row) throw notFound("user", userId);
  if (parseDeniedCapabilities(row.deniedCapabilities).includes(capability)) {
    throw forbidden(`account capability ${capability} is denied for this user`, {
      capability,
      decidedBy: "account_restriction",
    });
  }
}
