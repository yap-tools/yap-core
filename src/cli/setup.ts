/**
 * init / upgrade / create / service — commands that shape an instance rather
 * than talk to it. The one network act is vendoring the server from GitHub;
 * everything else is local file generation.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { initInstance } from "./init.js";
import { installServer, vendoredServerEntry, vendoredServerVersion } from "./install.js";
import { cmdStart } from "./lifecycle.js";
import { runningPid, stopInstance } from "./proc.js";
import { cmdUserCreate } from "./resources.js";
import { installService, planService, serviceName, uninstallService } from "./service.js";
import { localTarget } from "./target.js";
import { CliError } from "./util.js";

export async function cmdInit(dir: string, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { version: { type: "string" }, port: { type: "string" }, "no-install": { type: "boolean" } },
  });
  if (values.port && !/^\d+$/.test(values.port)) throw new CliError("--port must be a number");

  const result = initInstance(dir, { port: values.port });
  if (!result.created) {
    console.error(`yap: ${result.envPath} already exists — not overwriting.`);
    console.error("Edit it directly, or remove it and run `yap init` again to start fresh.");
    process.exit(1);
  }
  console.log("Scaffolded a Yap instance in this directory (.env with generated keys, data under ./data).");
  console.log("");
  console.log("Your sysadmin key (shown once here; it stays readable in the .env file):");
  console.log(`  ${result.sysadminKey}`);

  if (!values["no-install"]) {
    console.log("");
    console.log(`Installing the Yap server into this directory (${values.version ?? "latest release"})…`);
    await installServer(dir, values.version);
    console.log(`Installed yap-core ${vendoredServerVersion(dir) ?? ""}`.trimEnd() + ".");
  }

  console.log("");
  console.log("Next steps:");
  console.log("  yap start                 # serve this instance in the background");
  console.log("  yap user create <name>    # create your user; saves the CLI credential");
  console.log("");
  console.log(`Then connect any MCP client to http://localhost:${values.port ?? 8787}/mcp with that user's key.`);
}

export async function cmdUpgrade(dir: string, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "no-restart": { type: "boolean" }, "skip-backup": { type: "boolean" } },
    allowPositionals: true,
  });
  const before = vendoredServerVersion(dir);
  if (!before) throw new CliError("no server installed here — `yap init` first");

  // Portable safety copy of data/ before the code swap, taken by the
  // currently-installed server (which matches the data's schema). Versions
  // that predate backup support can't take one — say so and continue.
  if (!values["skip-backup"]) {
    const vendored = vendoredServerEntry(dir);
    const supportsBackup = vendored && existsSync(join(dirname(vendored), "backup", "run.js"));
    if (supportsBackup) {
      console.log("backing up before upgrade… (--skip-backup to skip)");
      const child = spawn(process.execPath, [vendored, "backup", "--trigger", "pre-upgrade"], {
        cwd: dir,
        stdio: "inherit",
      });
      const code = await new Promise<number>((res) => child.on("exit", (c) => res(c ?? 1)));
      if (code !== 0) throw new CliError("pre-upgrade backup failed — fix it or rerun with --skip-backup");
    } else {
      console.error("note: the installed server predates backup support — upgrading without a backup");
    }
  }

  await installServer(dir, positionals[0]);
  const after = vendoredServerVersion(dir);
  console.log(before === after ? `already at ${after}` : `upgraded ${before} → ${after}`);

  if (runningPid(dir) && !values["no-restart"] && before !== after) {
    console.log("restarting…");
    await stopInstance(dir);
    await cmdStart(dir);
  }
}

export async function cmdCreate(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { user: { type: "string" }, version: { type: "string" }, port: { type: "string" } },
    allowPositionals: true,
  });
  const target = positionals[0];
  if (!target) throw new CliError("usage: yap create <directory> [--user <name>] [--version <ref>] [--port <n>]");
  const dir = resolve(target);
  mkdirSync(dir, { recursive: true });

  const initArgs = [
    ...(values.version ? ["--version", values.version] : []),
    ...(values.port ? ["--port", values.port] : []),
  ];
  await cmdInit(dir, initArgs);
  console.log("");
  await cmdStart(dir);
  await cmdUserCreate(localTarget(dir), dir, [values.user ?? "admin"]);
  console.log("");
  console.log(`Instance ready in ${dir}.`);
}

export async function cmdService(dir: string, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { name: { type: "string" } },
    allowPositionals: true,
  });
  const sub = positionals[0];
  const plan = planService(dir, serviceName(dir, values.name));

  if (sub === "install") {
    installService(plan);
    console.log(`Wrote ${plan.path}`);
    console.log("");
    console.log("Activate it (the OS owns restart-on-crash and start-on-boot from here):");
    for (const cmd of plan.activate) console.log(`  ${cmd}`);
    console.log("");
    console.log("Stop `yap start`-style processes first (`yap stop`) so the port is free.");
    return;
  }
  if (sub === "uninstall") {
    if (!uninstallService(plan)) throw new CliError(`no service file at ${plan.path}`);
    console.log(`Removed ${plan.path}`);
    console.log("Deactivate it if it was loaded:");
    for (const cmd of plan.deactivate) console.log(`  ${cmd}`);
    return;
  }
  throw new CliError("usage: yap service install|uninstall [--name <name>]");
}
