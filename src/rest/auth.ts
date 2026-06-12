/**
 * REST authentication: interpret the request's resolved credential. The
 * route wrapper resolves the bearer once per request (core/credential.ts)
 * and hands the outcome to every handler; the helpers here apply the REST
 * lane policies — requireUser for content endpoints (user and token lanes),
 * requireSysadmin for the provisioning endpoints (sysadmin lane only) — with
 * REST's wording.
 */
import type { Context } from "hono";

import { bearerToken, type CredentialOutcome } from "../core/credential.js";
import { unauthorized } from "../core/errors.js";

export function bearerFrom(c: Context): string | null {
  return bearerToken(c.req.header("authorization"));
}

/** The acting user id, rejecting missing/invalid credentials and the sysadmin key. */
export function requireUser(auth: CredentialOutcome): string {
  switch (auth.kind) {
    case "user":
    case "token":
      return auth.userId;
    case "missing":
      throw unauthorized("bearer access key or access token required");
    case "sysadmin":
      throw unauthorized("the sysadmin key is not a user credential; use a user access key");
    case "invalid-token":
      throw unauthorized("invalid, expired, or revoked access token");
    case "invalid-key":
      throw unauthorized("invalid or revoked access key");
  }
}

export function requireSysadmin(auth: CredentialOutcome): void {
  if (auth.kind !== "sysadmin") throw unauthorized("sysadmin key required");
}
