/**
 * init / upgrade / create / service — commands that shape an instance rather
 * than talk to it. The one network act is vendoring the server from GitHub;
 * everything else is local file generation.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { CliError } from "../instance/errors.js";
import { runningPid, stopInstance } from "../instance/proc.js";
import {
  classifyVersion,
  execInServer,
  installedGitCommit,
  installServer,
  readSource,
  serverSupportsBackup,
  sourceLabel,
  vendoredServerVersion,
} from "../instance/server.js";
import { initInstance } from "./init.js";
import { cmdStart } from "./lifecycle.js";
import { cmdUserCreate } from "./resources.js";
import { installService, planService, serviceName, uninstallService } from "./service.js";
import { localTarget } from "./target.js";

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
    const source = classifyVersion(values.version);
    console.log("");
    console.log(`Installing the Yap server into this directory (${sourceLabel(source)})…`);
    await installServer(dir, source);
    const installed = vendoredServerVersion(dir);
    if (source.kind === "git") {
      const sha = installedGitCommit(dir);
      console.log(`Installed yap-core ${sourceLabel(source)}${sha ? ` @ ${sha}` : ""} (reports ${installed}).`);
    } else {
      console.log(`Installed yap-core ${installed ?? ""}`.trimEnd() + ".");
    }
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

  // An explicit ref switches (and re-pins) the source; a bare upgrade re-pulls
  // whatever the instance already tracks — the tip of its branch, or the
  // latest release.
  const source = positionals[0] ? classifyVersion(positionals[0]) : readSource(dir);

  // Portable safety copy of data/ before the code swap, taken by the
  // currently-installed server (which matches the data's schema). Versions
  // that predate backup support can't take one — say so and continue.
  if (!values["skip-backup"]) {
    if (serverSupportsBackup(dir)) {
      console.log("backing up before upgrade… (--skip-backup to skip)");
      const r = await execInServer(dir, ["backup", "--trigger", "pre-upgrade"]);
      if (r.status === "ran" && r.code !== 0) {
        throw new CliError("pre-upgrade backup failed — fix it or rerun with --skip-backup");
      }
      if (r.status === "self") {
        // We are the vendored server upgrading our own instance — back up in-process.
        await (await import("../backup/run.js")).runBackup(dir, ["--trigger", "pre-upgrade"]);
      }
    } else {
      console.error("note: the installed server predates backup support — upgrading without a backup");
    }
  }

  await installServer(dir, source);
  const after = vendoredServerVersion(dir);

  // A git ref keeps the same package version across commits, so the version
  // string can't tell us whether the code moved — assume a branch build always
  // did, and restart for it.
  const changed = source.kind === "git" ? true : before !== after;
  if (source.kind === "git") {
    const sha = installedGitCommit(dir);
    console.log(`reinstalled ${sourceLabel(source)}${sha ? ` @ ${sha}` : ""} (reports ${after})`);
  } else {
    console.log(before === after ? `already at ${after}` : `upgraded ${before} → ${after}`);
  }

  if (runningPid(dir) && !values["no-restart"] && changed) {
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
