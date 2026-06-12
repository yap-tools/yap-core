/**
 * OS supervision: `yap service install` generates a systemd unit (Linux) or
 * launchd plist (macOS) pointing at the instance directory and prints the
 * activation commands. We write a config file and hand control to the OS —
 * the CLI is deliberately not a process supervisor.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { CliError } from "../instance/errors.js";
import { logPath } from "../instance/layout.js";
import { serverEntry } from "../instance/server.js";

export interface ServicePlan {
  /** Where the unit/plist is (or would be) written. */
  path: string;
  content: string;
  /** Shell commands the operator runs to activate/deactivate it. */
  activate: string[];
  deactivate: string[];
}

export function serviceName(dir: string, name?: string): string {
  const base = name ?? basename(dir);
  if (!/^[A-Za-z0-9._-]+$/.test(base)) {
    throw new CliError(`service name ${JSON.stringify(base)} — use --name with letters, digits, ., _, -`);
  }
  return base;
}

export function systemdUnit(dir: string, entry: string, name: string): string {
  return `[Unit]
Description=Yap instance ${name}
After=network.target

[Service]
ExecStart=${process.execPath} ${entry} serve
WorkingDirectory=${dir}
Restart=always
RestartSec=2

[Install]
WantedBy=${isRoot() ? "multi-user.target" : "default.target"}
`;
}

export function launchdPlist(dir: string, entry: string, name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>tools.yap.${name}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${entry}</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>${dir}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logPath(dir)}</string>
  <key>StandardErrorPath</key><string>${logPath(dir)}</string>
</dict>
</plist>
`;
}

function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

export function planService(dir: string, name: string, platform: NodeJS.Platform = process.platform): ServicePlan {
  const entry = serverEntry(dir);
  if (platform === "darwin") {
    const path = join(homedir(), "Library", "LaunchAgents", `tools.yap.${name}.plist`);
    return {
      path,
      content: launchdPlist(dir, entry, name),
      activate: [`launchctl load -w ${path}`],
      deactivate: [`launchctl unload -w ${path}`],
    };
  }
  if (platform === "linux") {
    const unit = `yap-${name}.service`;
    const path = isRoot()
      ? join("/etc/systemd/system", unit)
      : join(homedir(), ".config", "systemd", "user", unit);
    const ctl = isRoot() ? "systemctl" : "systemctl --user";
    const plan: ServicePlan = {
      path,
      content: systemdUnit(dir, entry, name),
      activate: [`${ctl} daemon-reload`, `${ctl} enable --now ${unit}`],
      deactivate: [`${ctl} disable --now ${unit}`],
    };
    if (!isRoot()) {
      plan.activate.push(`loginctl enable-linger ${process.env.USER ?? "$USER"}  # keep it running after logout`);
    }
    return plan;
  }
  throw new CliError(`\`yap service\` supports linux (systemd) and macOS (launchd), not ${platform}`);
}

export function installService(plan: ServicePlan): void {
  mkdirSync(dirname(plan.path), { recursive: true });
  writeFileSync(plan.path, plan.content);
}

export function uninstallService(plan: ServicePlan): boolean {
  if (!existsSync(plan.path)) return false;
  rmSync(plan.path);
  return true;
}
