/**
 * Token-scope request context. An OAuth token delegates a user's authority,
 * possibly narrowed to a role mask and/or a resource restriction. The clamp
 * has to reach capability resolution deep inside core without re-typing every
 * `userId: string` signature, so the scope rides request-scoped
 * AsyncLocalStorage: established at the two transport entry points (the REST
 * handler wrapper and the MCP tool wrapper) and read inside
 * `resolveCapability` / `effectiveCapabilities`.
 *
 * Absence of a context means full authority of the authenticated user — the
 * access-key lane, sysadmin provisioning, and background jobs all run
 * unscoped, which is exactly the pre-OAuth behavior.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { forbidden } from "./errors.js";

export const TOKEN_ROLES = ["admin", "member", "read-only"] as const;
export type TokenRole = (typeof TOKEN_ROLES)[number];

export interface TokenScope {
  /** Role mask; "admin" means no capability clamp (full delegation). */
  role: TokenRole;
  /** Resource restriction: when either list is present, only the listed
   * spaces (with everything inside them) and bundles are reachable. */
  spaces?: string[];
  bundles?: string[];
}

export interface TokenAuth {
  userId: string;
  grantId: string;
  scope: TokenScope;
}

const storage = new AsyncLocalStorage<TokenAuth>();

export function runWithTokenAuth<T>(auth: TokenAuth, fn: () => T): T {
  return storage.run(auth, fn);
}

export function currentTokenAuth(): TokenAuth | undefined {
  return storage.getStore();
}

/**
 * Credential management (access-key CRUD, connected-app grants) is the
 * privilege-escalation path of the token lane — a minted key would outlive
 * and out-power the token that created it. Keys always may; tokens only at
 * role admin (the explicit "act fully as me" delegation the web app asks for).
 */
export function assertCanManageCredentials(): void {
  const auth = currentTokenAuth();
  if (auth && auth.scope.role !== "admin") {
    throw forbidden(
      "credential management requires an access key or an authorization with admin scope",
    );
  }
}

/** Account-level writes (user docs) are denied to read-only tokens. */
export function assertAccountWrite(): void {
  const auth = currentTokenAuth();
  if (auth && auth.scope.role === "read-only") {
    throw forbidden("this authorization is read-only");
  }
}
