/**
 * The API-client side of the CLI: `yap user create` (bootstrap), `yap api`
 * (full-parity passthrough), and ergonomic resource commands. Everything here
 * is plain HTTP against the instance — the CLI holds a user access key in
 * .yap/ and reads the sysadmin key from .env only when an operation needs it.
 */
import { parseArgs } from "node:util";

import { CliError } from "../instance/errors.js";
import { apiRequest, requireOk } from "./client.js";
import { readCredentials, writeCredentials } from "./credentials.js";
import { table } from "./table.js";
import type { Target } from "./target.js";

async function call(target: Target, method: string, path: string, key: string, body?: unknown): Promise<unknown> {
  return requireOk(await apiRequest(target.baseUrl, method, path, key, body, { remote: target.remote }));
}

/** List bodies are `{ data: [...] }`; tolerate a bare array for safety. */
function rows(body: unknown): Array<Record<string, unknown>> {
  const data = (body as { data?: unknown })?.data ?? body;
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
}

function printJson(body: unknown): void {
  console.log(JSON.stringify(body, null, 2));
}

interface CreateUserResponse {
  user: { id: string; name: string };
  personalSpaceId: string;
  initialKey: { key: string };
}

export async function cmdUserCreate(target: Target, dir: string, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "no-save": { type: "boolean" } },
    allowPositionals: true,
  });
  const name = positionals[0];
  if (!name) throw new CliError("usage: yap user create <name>");

  const body = (await call(target, "POST", "/v1/users", target.sysKey(), { name })) as CreateUserResponse;
  console.log(`created user ${body.user.name} (${body.user.id}), personal space ${body.personalSpaceId}`);
  console.log("");
  console.log("Access key (shown once — store it wherever this user connects from):");
  console.log(`  ${body.initialKey.key}`);

  if (!values["no-save"] && !readCredentials(dir)) {
    writeCredentials(dir, { accessKey: body.initialKey.key, userId: body.user.id, userName: body.user.name });
    console.log("");
    console.log("Saved to .yap/credentials.json — the CLI now authenticates as this user.");
  }
}

export async function cmdApi(target: Target, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { sysadmin: { type: "boolean" } },
    allowPositionals: true,
  });
  const [method, path, rawBody] = positionals;
  if (!method || !path || !path.startsWith("/")) {
    throw new CliError("usage: yap api <METHOD> </path> [json-body|-] [--sysadmin]");
  }
  let body: unknown;
  if (rawBody !== undefined) {
    const text = rawBody === "-" ? await readStdin() : rawBody;
    try {
      body = JSON.parse(text);
    } catch {
      throw new CliError("body must be valid JSON (or `-` to read JSON from stdin)");
    }
  }
  const key = values.sysadmin ? target.sysKey() : target.userKey();
  const res = await apiRequest(target.baseUrl, method.toUpperCase(), path, key, body, { remote: target.remote });
  if (typeof res.body === "string") console.log(res.body);
  else printJson(res.body);
  if (res.status >= 400) process.exit(1);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Ergonomic commands: thin, fixed mappings onto the REST surface. */
export async function cmdResource(target: Target, group: string, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean" },
      type: { type: "string" },
      filters: { type: "string" },
      sort: { type: "string" },
      desc: { type: "boolean" },
      limit: { type: "string" },
      description: { type: "string" },
    },
    allowPositionals: true,
  });
  const [sub = "list", ...args] = positionals;
  const out = (body: unknown, columns: string[]): void => {
    if (values.json) printJson(body);
    else console.log(table(rows(body), columns));
  };

  switch (`${group} ${sub}`) {
    case "users list":
      return out(await call(target, "GET", "/v1/users", target.sysKey()), ["id", "name", "createdAt"]);
    case "users delete":
      await call(target, "DELETE", `/v1/users/${need(args[0], "user id")}`, target.sysKey());
      return console.log("deleted");

    case "keys list":
      return out(await call(target, "GET", "/v1/keys", target.userKey()), ["id", "name", "createdAt", "lastUsedAt"]);
    case "keys create":
      return printJson(await call(target, "POST", "/v1/keys", target.userKey(), { name: need(args[0], "key name") }));
    case "keys rotate":
      return printJson(await call(target, "POST", `/v1/keys/${need(args[0], "key id")}/rotate`, target.userKey()));
    case "keys delete":
      await call(target, "DELETE", `/v1/keys/${need(args[0], "key id")}`, target.userKey());
      return console.log("deleted");

    case "spaces list":
      return out(await call(target, "GET", "/v1/spaces", target.userKey()), ["id", "name", "personal", "description"]);
    case "spaces show":
      return printJson(await call(target, "GET", `/v1/spaces/${need(args[0], "space id")}`, target.userKey()));
    case "spaces create":
      return printJson(
        await call(target, "POST", "/v1/spaces", target.userKey(), {
          name: need(args[0], "space name"),
          ...(values.description ? { description: values.description } : {}),
        }),
      );
    case "spaces delete":
      await call(target, "DELETE", `/v1/spaces/${need(args[0], "space id")}`, target.userKey());
      return console.log("deleted");

    case "bundles list":
      return out(await call(target, "GET", `/v1/spaces/${need(args[0], "space id")}/bundles`, target.userKey()), [
        "id",
        "name",
        "description",
      ]);
    case "bundles show":
      return printJson(await call(target, "GET", `/v1/bundles/${need(args[0], "bundle id")}`, target.userKey()));

    case "items query": {
      const bundleId = need(args[0], "bundle id");
      const params = new URLSearchParams();
      params.set("itemType", values.type ?? need(undefined, "--type <item-type>"));
      if (values.filters) params.set("filters", values.filters);
      if (values.sort) {
        params.set("sort", values.sort);
        if (values.desc) params.set("direction", "desc");
      }
      if (values.limit) params.set("limit", values.limit);
      return printJson(await call(target, "GET", `/v1/bundles/${bundleId}/items?${params}`, target.userKey()));
    }
    case "items get": {
      const bundleId = need(args[0], "bundle id");
      const ids = need(args[1], "comma-separated item ids");
      return printJson(await call(target, "GET", `/v1/bundles/${bundleId}/items?ids=${ids}`, target.userKey()));
    }

    case "connections list":
      return out(await call(target, "GET", "/v1/oauth/grants", target.userKey()), [
        "id",
        "client.name",
        "scope",
        "createdAt",
        "lastUsedAt",
      ]);
    case "connections revoke":
      await call(target, "DELETE", `/v1/oauth/grants/${need(args[0], "grant id")}`, target.userKey());
      return console.log("revoked");

    default:
      throw new CliError(`unknown command: yap ${group} ${sub} (see \`yap help\`)`);
  }
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new CliError(`missing ${what}`);
  return value;
}
