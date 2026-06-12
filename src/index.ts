#!/usr/bin/env node
/**
 * The `yap` command: a global CLI that creates instances (vendoring the
 * server from GitHub into the instance directory), runs them, and manages
 * them over their own HTTP API. Dependency-free by design — the command
 * surface is a switch, arguments are node:util parseArgs.
 */
import { createRequire } from "node:module";

import { cmdLogs, cmdServe, cmdStart, cmdStatus, cmdStop } from "./cli/lifecycle.js";
import { cmdApi, cmdResource, cmdUserCreate } from "./cli/resources.js";
import { cmdCreate, cmdInit, cmdService, cmdUpgrade } from "./cli/setup.js";
import { CliError } from "./cli/util.js";

// `yap … | head` closes stdout early; treat that as a normal end, not a crash.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

const USAGE = `Usage: yap <command>

An instance is a directory; run yap inside it.

Instance:
  init [--version v] [--port n] [--no-install]   Scaffold here + install the server from GitHub
  create <dir> [--user n] [--version v] [--port n]   mkdir + init + start + user create, in one go
  upgrade [version] [--no-restart]    Reinstall this instance's server, restart if running

Run:
  (none), serve                       Serve in the foreground (Ctrl+C stops)
  start | stop | status               Detached background process (.yap/yap.pid)
  logs [-n N] [-f]                    Show .yap/logs/yap.log
  service install|uninstall [--name]  Generate a systemd/launchd unit for real supervision

Manage (over the instance API, authenticated via .yap/credentials.json):
  user create <name>                  Create a user (sysadmin lane); saves the CLI credential
  api <METHOD> </path> [body|-] [--sysadmin]   Raw API passthrough — the full /v1 surface
  users list|delete                   keys list|create|rotate|delete
  spaces list|show|create|delete      bundles list <spaceId> | show <id>
  items query <bundleId> --type t [--filters json] | get <bundleId> <ids>
  connections list | revoke <id>      (--json on any list for raw output)

  version | help`;

const [command, ...rest] = process.argv.slice(2);
const dir = process.cwd();

try {
  switch (command) {
    case undefined:
    case "serve":
      await cmdServe(dir);
      break;
    case "init":
      await cmdInit(dir, rest);
      break;
    case "create":
      await cmdCreate(rest);
      break;
    case "upgrade":
      await cmdUpgrade(dir, rest);
      break;
    case "start":
      await cmdStart(dir);
      break;
    case "stop":
      await cmdStop(dir);
      break;
    case "status":
      await cmdStatus(dir);
      break;
    case "logs":
      await cmdLogs(dir, rest);
      break;
    case "service":
      await cmdService(dir, rest);
      break;
    case "user": {
      if (rest[0] !== "create") throw new CliError("usage: yap user create <name>");
      await cmdUserCreate(dir, rest.slice(1));
      break;
    }
    case "api":
      await cmdApi(dir, rest);
      break;
    case "users":
    case "keys":
    case "spaces":
    case "bundles":
    case "items":
    case "connections":
      await cmdResource(dir, command, rest);
      break;
    case "version":
    case "--version":
    case "-v": {
      // Resolves from src/ (tsx) and dist/ (built) alike — both sit one level
      // below the package root.
      const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
      console.log(pkg.version);
      break;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      break;
    default:
      console.error(`yap: unknown command ${JSON.stringify(command)}`);
      console.error("");
      console.error(USAGE);
      process.exit(1);
  }
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  if (err instanceof CliError || code?.startsWith("ERR_PARSE_ARGS")) {
    console.error(`yap: ${(err as Error).message}`);
    process.exit(1);
  }
  throw err;
}
