#!/usr/bin/env node
/**
 * The `yap` command. No arguments starts the server; `init` scaffolds config
 * and keys under the yap home (~/.yap or YAP_HOME). Kept dependency-free —
 * two subcommands don't justify an argument parser.
 */
import { createRequire } from "node:module";

import { initInstance } from "./cli/init.js";

// `yap … | head` closes stdout early; treat that as a normal end, not a crash.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

const USAGE = `Usage: yap [command]

Commands:
  (none), serve   Serve the instance in the current directory (REST /v1, MCP /mcp)
  init            Scaffold a Yap instance here: .env with generated keys + data/
  version         Print the yap version
  help            Show this message

An instance is a directory. Config comes from the environment, with an env
file as fallback: YAP_ENV_FILE if set, else ./.env. Run one instance per
directory; give each its own YAP_PORT.`;

const command = process.argv[2];
switch (command) {
  case undefined:
  case "serve": {
    await (await import("./serve.js")).serve();
    break;
  }
  case "init": {
    const result = initInstance(process.cwd());
    if (!result.created) {
      console.error(`yap: ${result.envPath} already exists — not overwriting.`);
      console.error("Edit it directly, or remove it and run `yap init` again to start fresh.");
      process.exit(1);
    }
    console.log(`Scaffolded a Yap instance in this directory (.env with generated keys, data under ./data).`);
    console.log("");
    console.log(`Your sysadmin key (shown once here; it stays readable in the .env file):`);
    console.log(`  ${result.sysadminKey}`);
    console.log("");
    console.log("Next steps:");
    console.log("  yap                       # serve this instance on http://localhost:8787");
    console.log("  curl -s -X POST localhost:8787/v1/users \\");
    console.log(`    -H "Authorization: Bearer ${result.sysadminKey}" \\`);
    console.log(`    -H "Content-Type: application/json" -d '{"name": "Ada"}'`);
    console.log("");
    console.log("The response includes a personal space and a one-time access key —");
    console.log("connect any MCP client to http://localhost:8787/mcp with that key.");
    break;
  }
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
  case "-h": {
    console.log(USAGE);
    break;
  }
  default: {
    console.error(`yap: unknown command ${JSON.stringify(command)}`);
    console.error("");
    console.error(USAGE);
    process.exit(1);
  }
}
