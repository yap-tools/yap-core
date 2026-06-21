/**
 * `yap agent-runtime` — the sysadmin lane for instance-level model-provider
 * credentials. Every verb is a thin HTTP call against the instance (the CLI
 * package ships no server code). `authorize` runs the runtime's provider login
 * + on-disk capture server-side — the server is on the instance host in local
 * mode — so this only triggers it and reports the result.
 */
import { parseArgs } from "node:util";

import { CliError } from "../instance/errors.js";
import { apiRequest, requireOk } from "./client.js";
import { table } from "./table.js";
import type { Target } from "./target.js";

async function call(target: Target, method: string, path: string, key: string, body?: unknown): Promise<unknown> {
  return requireOk(await apiRequest(target.baseUrl, method, path, key, body, { remote: target.remote }));
}

function rows(body: unknown): Array<Record<string, unknown>> {
  const data = (body as { data?: unknown })?.data ?? body;
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
}

export async function cmdAgentRuntime(target: Target, _dir: string, argv: string[]): Promise<void> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true });
  const [first, verb] = positionals;

  if (first === undefined || first === "list") {
    const body = await call(target, "GET", "/v1/agent-runtimes", target.sysKey());
    console.log(table(rows(body), ["name", "image", "status", "updatedAt"]));
    return;
  }

  const name = first;
  switch (verb) {
    case "status": {
      const body = await call(target, "GET", "/v1/agent-runtimes", target.sysKey());
      const row = rows(body).find((r) => r.name === name);
      if (!row) throw new CliError(`unknown runtime ${name}`);
      console.log(JSON.stringify(row, null, 2));
      return;
    }
    case "authorize": {
      await call(target, "POST", `/v1/agent-runtimes/${name}/authorize`, target.sysKey());
      console.log(`stored credential for runtime ${name}`);
      return;
    }
    case "refresh": {
      const body = (await call(target, "POST", `/v1/agent-runtimes/${name}/refresh`, target.sysKey())) as {
        status: string;
      };
      console.log(`runtime ${name}: ${body.status}`);
      return;
    }
    case "revoke": {
      await call(target, "DELETE", `/v1/agent-runtimes/${name}/credential`, target.sysKey());
      console.log(`revoked credential for runtime ${name}`);
      return;
    }
    default:
      throw new CliError("usage: yap agent-runtime [list] | <name> authorize|refresh|status|revoke");
  }
}
