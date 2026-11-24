/**
 * The CLI's API client. Everything the CLI does after bootstrap goes through
 * the instance's HTTP API — never the database or the filesystem — so the CLI
 * has exactly the authority of the credential it presents, like any client.
 */
import { CliError } from "../instance/errors.js";

export interface ApiResult {
  status: number;
  body: unknown;
}

export async function apiRequest(
  baseUrl: string,
  method: string,
  path: string,
  key: string,
  body?: unknown,
  opts: { remote?: boolean } = {},
): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetch(baseUrl + path, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // `yap start` only makes sense for the instance in the cwd.
    throw new CliError(
      opts.remote
        ? `could not reach ${baseUrl}`
        : `could not reach ${baseUrl} — is the instance running? (\`yap start\`)`,
    );
  }
  const text = await res.text();
  let parsed: unknown = text;
  if (res.headers.get("content-type")?.includes("application/json")) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as text
    }
  }
  return { status: res.status, body: parsed };
}

/**
 * The CLI's user lane can only present an access key: the instance's OAuth
 * flow has no grant a terminal can use. Where key login is switched off (for
 * the instance, or for the saved key's user) the API refuses the key with
 * `details.reason`, and this says so plainly instead of a bare 401.
 */
function keyRefusedHint(res: ApiResult): string | null {
  if (res.status !== 401) return null;
  const reason = (res.body as { error?: { details?: { reason?: unknown } } } | undefined)?.error?.details?.reason;
  if (reason === "key_login_off") {
    return "This instance accepts only provider login, and the CLI can only connect with an access key, so it cannot connect to this instance yet.";
  }
  if (reason === "provider_login_only") {
    return "This account logs in only through a login provider, so the CLI's access key is refused. The instance operator can clear provider login only for the account (PATCH /v1/users/:id) and issue a key.";
  }
  return null;
}

/** Unwrap a 2xx body or throw the API's own error message. */
export function requireOk(res: ApiResult): unknown {
  if (res.status >= 200 && res.status < 300) return res.body;
  const hint = keyRefusedHint(res);
  if (hint) throw new CliError(hint);
  const message =
    (res.body as { error?: { message?: string } } | undefined)?.error?.message ??
    `request failed with status ${res.status}`;
  throw new CliError(message);
}
