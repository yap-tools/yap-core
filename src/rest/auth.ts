/**
 * REST authentication: interpret the request's resolved credential. The
 * route wrapper resolves the bearer once per request (core/credential.ts)
 * and hands the outcome to every handler; the helpers here apply the REST
 * lane policies — requireUser for content endpoints (user and token lanes),
 * requireSysadmin for the operator endpoints, users and their keys (sysadmin
 * lane only) — with REST's wording.
 */
import type { Context } from "hono";

import { bearerToken, type CredentialOutcome } from "../core/credential.js";
import { unauthorized, YapError } from "../core/errors.js";
import { refusalCode } from "../core/keyLogin.js";

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
    case "key-refused":
      // details.reason lets a client (the CLI) tell this from a bad key.
      throw new YapError("unauthorized", auth.message, { reason: refusalCode(auth.reason) });
  }
}

export function requireSysadmin(auth: CredentialOutcome): void {
  if (auth.kind !== "sysadmin") throw unauthorized("sysadmin key required");
}
