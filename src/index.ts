#!/usr/bin/env node
/**
 * The `yap` command: a global CLI that creates instances (vendoring the
 * server from GitHub into the instance directory), runs them, and manages
 * them over their own HTTP API. Dependency-free by design — the command
 * surface is a switch, arguments are node:util parseArgs.
 */
import { createRequire } from "node:module";

import { cmdBackup, cmdRestore } from "./cli/backup.js";
import { cmdLogs, cmdServe, cmdStart, cmdStatus, cmdStop } from "./cli/lifecycle.js";
import { cmdApi, cmdResource, cmdUserCreate } from "./cli/resources.js";
import { cmdCreate, cmdInit, cmdService, cmdUpgrade } from "./cli/setup.js";
import { assertLocal, resolveTarget } from "./cli/target.js";
import { CliError } from "./instance/errors.js";

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
  upgrade [version] [--no-restart] [--skip-backup]   Reinstall this instance's server, restart if running

Data:
  backup [--out <path>]               Write a portable backup (to the sink, or a file)
  backup list                         List backups in the configured sink
  restore <name|path> | --latest      Replace this instance's data from a backup (--force to overwrite)

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

Remote (manage commands only; sysadmin and lifecycle stay on the instance host):
  --url <url> --key <accessKey>       Target a remote instance — or set YAP_URL / YAP_KEY

  version | help`;

const { target, argv } = resolveTarget(process.argv.slice(2));
const [command, ...rest] = argv;
const dir = process.cwd();

try {
  switch (command) {
    case undefined:
    case "serve":
      assertLocal(target, command ?? "serve");
      await cmdServe(dir);
      break;
    case "init":
      assertLocal(target, command);
      await cmdInit(dir, rest);
      break;
    case "create":
      assertLocal(target, command);
      await cmdCreate(rest);
      break;
    case "upgrade":
      assertLocal(target, command);
      await cmdUpgrade(dir, rest);
      break;
    case "backup":
      assertLocal(target, command);
      await cmdBackup(dir, rest);
      break;
    case "restore":
      assertLocal(target, command);
      await cmdRestore(dir, rest);
      break;
    case "start":
      assertLocal(target, command);
      await cmdStart(dir);
      break;
    case "stop":
      assertLocal(target, command);
      await cmdStop(dir);
      break;
    case "status":
      assertLocal(target, command);
      await cmdStatus(dir);
      break;
    case "logs":
      assertLocal(target, command);
      await cmdLogs(dir, rest);
      break;
    case "service":
      assertLocal(target, command);
      await cmdService(dir, rest);
      break;
    case "user": {
      if (rest[0] !== "create") throw new CliError("usage: yap user create <name>");
      await cmdUserCreate(target, dir, rest.slice(1));
      break;
    }
    case "api":
      await cmdApi(target, rest);
      break;
    case "users":
    case "keys":
    case "spaces":
    case "bundles":
    case "items":
    case "connections":
      await cmdResource(target, command, rest);
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
