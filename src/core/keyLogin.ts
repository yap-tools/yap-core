/**
 * Whether an access key may be used: the one refusal behind every lane a user
 * access key reaches. Two switches decide it:
 *
 * - **Instance-wide, `YAP_KEY_LOGIN=false`** (config.keyLogin). Nobody logs in
 *   with a key: the pages Core serves show only the login providers, a key is
 *   refused as an API credential on /v1 and /mcp, no user key can be made by
 *   anyone (the sysadmin lane included), and an OAuth grant made with a key
 *   stops working until the switch is back on. Startup refuses it without a
 *   provider (config.ts).
 * - **Per user, `provider_login_only`** (users row). The same refusals for one
 *   user: their keys stay stored but are refused, no key can be made for them,
 *   and setting the flag deletes the OAuth grants their keys authorized
 *   (users.ts). The sysadmin sets and clears it; a provider sign-up or invite
 *   claim sets it.
 *
 * The sysadmin key is never a user key and is not touched by either. OAuth
 * grants made after a provider login carry no key and are not touched either.
 *
 * `authenticateKey` (keys.ts) asks this for every presented key, and the key
 * creation guard for every new one; each surface words the refusal for its
 * own reader with the functions below.
 */
import type { YapConfig } from "../config.js";
import { forbidden, unauthorized, YapError } from "./errors.js";

/** Why a key was refused: the instance switch, or the user's flag. */
export type KeyRefusal = "key-login-off" | "provider-login-only";

export type KeyLoginConfig = Pick<YapConfig, "keyLogin" | "oidc">;

/** The refusal for a key of a user with this flag, or null when the key may be used. */
export function keyRefusal(config: KeyLoginConfig, providerLoginOnly: boolean): KeyRefusal | null {
  if (!config.keyLogin) return "key-login-off";
  return providerLoginOnly ? "provider-login-only" : null;
}

/** "Google", "Google or Okta"; "a login provider" when none is configured. */
export function providerPhrase(config: KeyLoginConfig): string {
  const labels = config.oidc.providers.map((p) => p.label);
  if (labels.length === 0) return "a login provider";
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

/** The words an API caller gets (/v1, /mcp, the CLI). */
export function apiKeyRefusedMessage(config: KeyLoginConfig, reason: KeyRefusal): string {
  const provider = providerPhrase(config);
  return reason === "key-login-off"
    ? `Access keys can't be used on this instance. Connect with ${provider}.`
    : `This account logs in only with ${provider}: its access keys can't be used. Connect with ${provider}.`;
}

/** A 401 with the words above and `details.reason`, so a client can tell this refusal from a bad key. */
export function keyRefusedError(config: KeyLoginConfig, reason: KeyRefusal): YapError {
  const err = unauthorized(apiKeyRefusedMessage(config, reason));
  return new YapError(err.code, err.message, { reason: refusalCode(reason) });
}

/** The words a person gets on a page where they pasted a key. */
export function pageKeyRefusedMessage(config: KeyLoginConfig, reason: KeyRefusal): string {
  const provider = providerPhrase(config);
  return reason === "key-login-off"
    ? `Sign in with ${provider}.`
    : `This account logs in with ${provider}, not with an access key. Use the ${provider} button.`;
}

/** Refuses making a user key (minting, rotating, the sysadmin lane, a new user's initial key). */
export function keyCreationRefused(config: KeyLoginConfig, reason: KeyRefusal): YapError {
  const message =
    reason === "key-login-off"
      ? `Access keys can't be made on this instance: it accepts only login with ${providerPhrase(config)}.`
      : "This user is set to provider login only (providerLoginOnly), so no access key can be made for them. " +
        "The sysadmin can clear the flag with PATCH /v1/users/:id first.";
  const err = forbidden(message);
  return new YapError(err.code, err.message, { reason: refusalCode(reason) });
}

/** The wire form of a refusal, in `details.reason`. */
export function refusalCode(reason: KeyRefusal): "key_login_off" | "provider_login_only" {
  return reason === "key-login-off" ? "key_login_off" : "provider_login_only";
}
