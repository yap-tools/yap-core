/**
 * Which instance a command talks to. Local (the default): the cwd is the
 * instance directory — base URL from its .env, user key from
 * .yap/credentials.json, sysadmin key from .env. Remote: --url/--key flags or
 * YAP_URL/YAP_KEY env name an instance elsewhere; no local state is read at
 * all, so a credential never travels to a host it wasn't given for.
 */
import { instanceBaseUrl, instanceSysadminKey, loadInstanceEnv } from "../instance/env.js";
import { CliError } from "../instance/errors.js";
import { readCredentials } from "./credentials.js";

type Env = Record<string, string | undefined>;

export interface Target {
  baseUrl: string;
  remote: boolean;
  userKey(): string;
  sysKey(): string;
}

export interface ResolvedTarget {
  target: Target;
  /** argv with the global --url/--key flags stripped. */
  argv: string[];
}

/** Pull `--name <v>` / `--name=<v>` out of argv wherever it appears. */
function extractFlag(argv: string[], name: string): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === `--${name}`) {
      value = argv[i + 1];
      if (value === undefined) throw new CliError(`--${name} requires a value`);
      argv.splice(i--, 2);
    } else if (arg.startsWith(`--${name}=`)) {
      value = arg.slice(name.length + 3);
      argv.splice(i--, 1);
    }
  }
  return value;
}

export function resolveTarget(
  argv: string[],
  env: Env = process.env,
  cwd: string = process.cwd(),
): ResolvedTarget {
  const rest = [...argv];
  const url = extractFlag(rest, "url") ?? env.YAP_URL;
  const key = extractFlag(rest, "key") ?? env.YAP_KEY;

  if (url) {
    const baseUrl = url.replace(/\/$/, "");
    const target: Target = {
      baseUrl,
      remote: true,
      userKey() {
        if (!key) throw new CliError("no access key — pass --key or set YAP_KEY");
        return key;
      },
      sysKey() {
        throw new CliError("sysadmin commands are local-only — run this on the instance host");
      },
    };
    if (isPlainHttpNonLoopback(baseUrl)) {
      console.error(`yap: warning: sending your access key over plain http to ${baseUrl}`);
    }
    return { target, argv: rest };
  }

  return { target: localTarget(cwd, env), argv: rest };
}

/** Today's behavior: the cwd is the instance, .env and .yap/ are the state. */
export function localTarget(cwd: string, env: Env = process.env): Target {
  const instanceEnv = loadInstanceEnv(cwd, env);
  return {
    baseUrl: instanceBaseUrl(instanceEnv),
    remote: false,
    userKey() {
      const creds = readCredentials(cwd);
      if (!creds) {
        throw new CliError(
          "no CLI credential in .yap/ — run `yap user create <name>` once, or save an access key there",
        );
      }
      return creds.accessKey;
    },
    sysKey: () => instanceSysadminKey(instanceEnv),
  };
}

/** Lifecycle/setup commands manage the local directory — never a remote. */
export function assertLocal(target: Target, command: string): void {
  if (target.remote) {
    throw new CliError(
      `${command} manages a local instance directory — it can't target a remote (--url/YAP_URL is set)`,
    );
  }
}

/** A bearer key over plain http is fine on loopback, a leak anywhere else. */
export function isPlainHttpNonLoopback(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== "http:") return false;
    return !(
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.startsWith("127.") ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}
