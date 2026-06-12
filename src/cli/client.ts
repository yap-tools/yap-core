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

/** Unwrap a 2xx body or throw the API's own error message. */
export function requireOk(res: ApiResult): unknown {
  if (res.status >= 200 && res.status < 300) return res.body;
  const message =
    (res.body as { error?: { message?: string } } | undefined)?.error?.message ??
    `request failed with status ${res.status}`;
  throw new CliError(message);
}
