/**
 * The API-client side of the CLI: `yap user create` (bootstrap), `yap api`
 * (full-parity passthrough), and ergonomic resource commands. Everything here
 * is plain HTTP against the instance — the CLI holds a user access key in
 * .yap/ and reads the sysadmin key from .env only when an operation needs it.
 */
import { parseArgs } from "node:util";

import { apiRequest, requireOk } from "./client.js";
import { readCredentials, writeCredentials } from "./credentials.js";
import { instanceBaseUrl, instanceSysadminKey, loadInstanceEnv } from "./env.js";
import { table } from "./table.js";
import { CliError } from "./util.js";

function baseUrl(dir: string): string {
  return instanceBaseUrl(loadInstanceEnv(dir));
}

function userKey(dir: string): string {
  const creds = readCredentials(dir);
  if (!creds) {
    throw new CliError("no CLI credential in .yap/ — run `yap user create <name>` once, or save an access key there");
  }
  return creds.accessKey;
}

function sysKey(dir: string): string {
  return instanceSysadminKey(loadInstanceEnv(dir));
}

async function call(dir: string, method: string, path: string, key: string, body?: unknown): Promise<unknown> {
  return requireOk(await apiRequest(baseUrl(dir), method, path, key, body));
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

export async function cmdUserCreate(dir: string, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "no-save": { type: "boolean" } },
    allowPositionals: true,
  });
  const name = positionals[0];
  if (!name) throw new CliError("usage: yap user create <name>");

  const body = (await call(dir, "POST", "/v1/users", sysKey(dir), { name })) as CreateUserResponse;
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

export async function cmdApi(dir: string, argv: string[]): Promise<void> {
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
  const key = values.sysadmin ? sysKey(dir) : userKey(dir);
  const res = await apiRequest(baseUrl(dir), method.toUpperCase(), path, key, body);
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
export async function cmdResource(dir: string, group: string, argv: string[]): Promise<void> {
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
      return out(await call(dir, "GET", "/v1/users", sysKey(dir)), ["id", "name", "createdAt"]);
    case "users delete":
      await call(dir, "DELETE", `/v1/users/${need(args[0], "user id")}`, sysKey(dir));
      return console.log("deleted");

    case "keys list":
      return out(await call(dir, "GET", "/v1/keys", userKey(dir)), ["id", "name", "createdAt", "lastUsedAt"]);
    case "keys create":
      return printJson(await call(dir, "POST", "/v1/keys", userKey(dir), { name: need(args[0], "key name") }));
    case "keys rotate":
      return printJson(await call(dir, "POST", `/v1/keys/${need(args[0], "key id")}/rotate`, userKey(dir)));
    case "keys delete":
      await call(dir, "DELETE", `/v1/keys/${need(args[0], "key id")}`, userKey(dir));
      return console.log("deleted");

    case "spaces list":
      return out(await call(dir, "GET", "/v1/spaces", userKey(dir)), ["id", "name", "personal", "description"]);
    case "spaces show":
      return printJson(await call(dir, "GET", `/v1/spaces/${need(args[0], "space id")}`, userKey(dir)));
    case "spaces create":
      return printJson(
        await call(dir, "POST", "/v1/spaces", userKey(dir), {
          name: need(args[0], "space name"),
          ...(values.description ? { description: values.description } : {}),
        }),
      );
    case "spaces delete":
      await call(dir, "DELETE", `/v1/spaces/${need(args[0], "space id")}`, userKey(dir));
      return console.log("deleted");

    case "bundles list":
      return out(await call(dir, "GET", `/v1/spaces/${need(args[0], "space id")}/bundles`, userKey(dir)), [
        "id",
        "name",
        "description",
      ]);
    case "bundles show":
      return printJson(await call(dir, "GET", `/v1/bundles/${need(args[0], "bundle id")}`, userKey(dir)));

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
      return printJson(await call(dir, "GET", `/v1/bundles/${bundleId}/items?${params}`, userKey(dir)));
    }
    case "items get": {
      const bundleId = need(args[0], "bundle id");
      const ids = need(args[1], "comma-separated item ids");
      return printJson(await call(dir, "GET", `/v1/bundles/${bundleId}/items?ids=${ids}`, userKey(dir)));
    }

    case "connections list":
      return out(await call(dir, "GET", "/v1/oauth/grants", userKey(dir)), [
        "id",
        "client.name",
        "scope",
        "createdAt",
        "lastUsedAt",
      ]);
    case "connections revoke":
      await call(dir, "DELETE", `/v1/oauth/grants/${need(args[0], "grant id")}`, userKey(dir));
      return console.log("revoked");

    default:
      throw new CliError(`unknown command: yap ${group} ${sub} (see \`yap help\`)`);
  }
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new CliError(`missing ${what}`);
  return value;
}
