/**
 * Scope request context. Two credentials can carry a scope that narrows
 * their user's authority: an OAuth token (a role mask and, optionally, a
 * resource restriction) and a scoped access key (a role mask only). The clamp
 * has to reach capability resolution deep inside core without re-typing every
 * `userId: string` signature, so the scope rides request-scoped
 * AsyncLocalStorage: established at the two transport entry points (the REST
 * handler wrapper and the MCP tool wrapper) and read inside
 * `resolveCapability` / `effectiveCapabilities`.
 *
 * The context says where its scope came from (`source`), because the two are
 * not interchangeable outside capability resolution: an admin-role token may
 * manage credentials, a scoped key never may.
 *
 * Absence of a context means full authority of the authenticated user — an
 * unscoped access key, sysadmin provisioning, and background jobs all run
 * unscoped, which is exactly the pre-OAuth behavior.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { forbidden } from "./errors.js";

export const TOKEN_ROLES = ["admin", "member", "read-only"] as const;
export type TokenRole = (typeof TOKEN_ROLES)[number];

export function isTokenRole(value: unknown): value is TokenRole {
  return (TOKEN_ROLES as readonly unknown[]).includes(value);
}

/** A scoped access key's fixed scope: a role mask only, never a place. */
export interface KeyScope {
  role: TokenRole;
}

export interface TokenScope {
  /** Role mask; "admin" means no capability clamp (full delegation). */
  role: TokenRole;
  /** Resource restriction: when either list is present, only the listed
   * spaces (with everything inside them) and bundles are reachable. */
  spaces?: string[];
  bundles?: string[];
}

/** A scope from an OAuth token: delegated identity, bound to its grant. */
export interface TokenAuth {
  source: "token";
  userId: string;
  grantId: string;
  scope: TokenScope;
}

/**
 * A scope from a scoped access key: the key's fixed role mask. Never a
 * resource restriction — a key scope limits what the key may do, never where;
 * "where" is what grants are for.
 */
export interface KeyAuth {
  source: "key";
  userId: string;
  keyId: string;
  scope: KeyScope;
}

/** Whatever narrows the current request, if anything does. */
export type ScopedAuth = TokenAuth | KeyAuth;

const storage = new AsyncLocalStorage<ScopedAuth>();

export function runWithScope<T>(auth: ScopedAuth, fn: () => T): T {
  return storage.run(auth, fn);
}

export function currentScope(): ScopedAuth | undefined {
  return storage.getStore();
}

/**
 * Runs `fn` with no scope in effect, and so does everything it schedules. For
 * work that outlives the request that started it and acts as someone else: the
 * service scheduler arms a schedule's timer while handling an edit, and a timer
 * inherits the async context it was created in — so every fire runs through
 * this, or it would be judged against the *editor's* scope.
 */
export function runOutsideScope<T>(fn: () => T): T {
  return storage.exit(fn);
}

/**
 * Credential management (access-key CRUD, connected-app grants) is the
 * privilege-escalation path of every scoped credential — a minted key would
 * outlive and out-power the credential that created it. Unscoped keys always
 * may; tokens only at role admin (the explicit "act fully as me" delegation
 * the web app asks for); scoped keys never, whatever their role, so a narrow
 * key can neither widen itself nor mint a wider one.
 */
export function assertCanManageCredentials(): void {
  const auth = currentScope();
  if (!auth) return;
  if (auth.source === "key") {
    throw forbidden("this access key is scoped: managing keys and connected apps needs an unscoped key or an admin OAuth login", {
      decidedBy: "key_scope",
    });
  }
  if (auth.scope.role !== "admin") {
    throw forbidden(
      "credential management requires an access key or an authorization with admin scope",
    );
  }
}

/** Account-level writes (user docs, new spaces) are denied to a read-only
 * scope, token or key alike. */
export function assertAccountWrite(): void {
  const auth = currentScope();
  if (auth && auth.scope.role === "read-only") {
    if (auth.source === "key") throw forbidden("this access key is read-only", { decidedBy: "key_scope" });
    throw forbidden("this authorization is read-only");
  }
}

/**
 * Is the request running on a scoped access key? Such a key stands in for its
 * user but is never the user in person, so it cannot give the approvals only
 * a person gives (a REST service write counting as its author's approval).
 */
export function onScopedKey(): boolean {
  return currentKeyScope() !== undefined;
}

/** The calling key's scope when the request runs on a scoped key. */
export function currentKeyScope(): KeyScope | undefined {
  const auth = currentScope();
  return auth?.source === "key" ? auth.scope : undefined;
}

/**
 * The scope rule for creating a space, which is account-level (no granted
 * capability to clamp): no read-only scope, token or key; and since
 * `create_spaces` sits outside the role masks, a scoped key gets it only at
 * role admin. Tokens keep their rule: anything but read-only.
 */
export function assertCanCreateSpaces(): void {
  assertAccountWrite();
  const keyScope = currentKeyScope();
  if (keyScope && keyScope.role !== "admin") {
    throw forbidden(`this access key is scoped to ${keyScope.role}: creating spaces needs an unscoped key or a scoped admin key`, {
      decidedBy: "key_scope",
    });
  }
}
