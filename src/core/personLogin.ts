/**
 * The one "identify the person" step behind every page Core serves itself:
 * the OAuth consent screen, the connected-apps page, a service's approve page
 * and its secret form. It turns what the page posted into a verified Yap user
 * and nothing more; what the person may then do (consent, approve, save) is
 * each page's own shared code, the same whichever way they logged in.
 *
 * Two login methods:
 * - an access key pasted into the page (`pageLogin`, keys.ts), always there;
 * - a login ticket, which the page rendered after a provider login carries
 *   (`spendLoginTicket`, oidc.ts), good once, for that page and what it is
 *   about.
 * A post carrying both is refused: a page sends one or the other. Where key
 * login is switched off (keyLogin.ts) the key is refused, and every refusal is
 * worded without mentioning keys at all (`loginRefusedMessage`).
 */
import type { YapConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { pageKeyRefusedMessage, providerPhrase, type KeyRefusal } from "./keyLogin.js";
import { pageLogin, type PageLoginRefusal } from "./keys.js";
import { spendLoginTicket, type LoginPurpose } from "./oidc.js";

/** Why a page login was refused. `login-expired`: the provider login's ticket
 * is used, expired, or for another page; `two-logins`: a key and a ticket at once. */
export type PersonLoginRefusal = PageLoginRefusal | "login-expired" | "two-logins";

export type PersonLogin =
  | {
      ok: true;
      userId: string;
      /** The key logged in with; null after a provider login. */
      keyId: string | null;
      /** The provider logged in with; null for a key. */
      provider: string | null;
    }
  | { ok: false; reason: PersonLoginRefusal };

/** Words for the two refusals that are the same on every page. */
export const LOGIN_EXPIRED = "Your login has expired or was already used. Log in again.";
export const TWO_LOGINS = "Log in one way: with your provider or with an access key, not both.";

/** The refusals a page words for itself, when key login is on: each is about the key it was given. */
export type KeyLoginRefusalWords = Record<Exclude<PersonLoginRefusal, KeyRefusal | "login-expired" | "two-logins">, string>;

/**
 * What a page says for a refused login. `action` finishes "Sign in with
 * {provider} to …" ("approve", "save"), used for every refusal where key login
 * is off for the instance, so such a page never mentions keys.
 */
export function loginRefusedMessage(
  config: YapConfig,
  reason: PersonLoginRefusal,
  keyWords: KeyLoginRefusalWords,
  action: string,
): string {
  if (reason === "login-expired") return LOGIN_EXPIRED;
  if (reason === "provider-login-only") return pageKeyRefusedMessage(config, reason);
  if (!config.keyLogin) return `Sign in with ${providerPhrase(config)} to ${action}.`;
  if (reason === "two-logins") return TWO_LOGINS;
  if (reason === "key-login-off") return pageKeyRefusedMessage(config, reason);
  return keyWords[reason];
}

export async function identifyPerson(
  env: { db: Db; config: YapConfig },
  presented: { accessKey?: unknown; loginTicket?: unknown },
  page: { purpose: LoginPurpose; context: Record<string, string> },
): Promise<PersonLogin> {
  const accessKey = typeof presented.accessKey === "string" ? presented.accessKey.trim() : "";
  const ticket = typeof presented.loginTicket === "string" ? presented.loginTicket.trim() : "";
  if (accessKey && ticket) return { ok: false, reason: "two-logins" };
  if (ticket) {
    const spent = await spendLoginTicket(env.db, ticket, page.purpose, page.context);
    if (!spent) return { ok: false, reason: "login-expired" };
    return { ok: true, userId: spent.userId, keyId: null, provider: spent.provider };
  }
  const login = await pageLogin(env.db, env.config, accessKey);
  if (!login.ok) return login;
  return { ok: true, userId: login.userId, keyId: login.keyId, provider: null };
}
