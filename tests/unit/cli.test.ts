/**
 * CLI plumbing: env-file search order, instance config derivation, the
 * `yap init` scaffold, credentials, vendored-server detection, pidfile
 * hygiene, table formatting, and service-unit generation.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { credentialsPath, readCredentials, writeCredentials } from "../../src/cli/credentials.js";
import { instanceBaseUrl, loadInstanceEnv, resolveEnvFile } from "../../src/cli/env.js";
import { initInstance } from "../../src/cli/init.js";
import { installSpec, vendoredServerEntry, vendoredServerVersion } from "../../src/cli/install.js";
import { pidPath, runningPid } from "../../src/cli/proc.js";
import { launchdPlist, systemdUnit } from "../../src/cli/service.js";
import { table } from "../../src/cli/table.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yap-cli-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveEnvFile", () => {
  it("prefers an existing YAP_ENV_FILE over the cwd .env", () => {
    const dir = tempDir();
    const explicit = join(dir, "explicit.env");
    writeFileSync(explicit, "");
    writeFileSync(join(dir, ".env"), "");
    expect(resolveEnvFile({ YAP_ENV_FILE: explicit }, dir)).toBe(explicit);
  });

  it("falls back to ./.env, then undefined", () => {
    const cwd = tempDir();
    expect(resolveEnvFile({}, cwd)).toBeUndefined();
    writeFileSync(join(cwd, ".env"), "");
    expect(resolveEnvFile({}, cwd)).toBe(join(cwd, ".env"));
  });

  it("skips a YAP_ENV_FILE that does not exist instead of crashing", () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, ".env"), "");
    expect(resolveEnvFile({ YAP_ENV_FILE: join(cwd, "missing.env") }, cwd)).toBe(join(cwd, ".env"));
  });
});

describe("initInstance", () => {
  it("scaffolds a private .env with generated keys and instance-relative data paths", () => {
    const dir = tempDir();
    const result = initInstance(dir);

    expect(result.created).toBe(true);
    expect(result.envPath).toBe(join(dir, ".env"));
    expect(result.sysadminKey.startsWith("yap_sys_")).toBe(true);
    expect(result.sysadminKey.length).toBeGreaterThanOrEqual(16);

    const mode = statSync(result.envPath).mode & 0o777;
    expect(mode).toBe(0o600);

    const content = readFileSync(result.envPath, "utf8");
    expect(content).toContain(`YAP_SYSADMIN_KEY=${result.sysadminKey}`);
    const masterKey = content.match(/^YAP_MASTER_KEY=(.+)$/m)?.[1];
    expect(Buffer.from(masterKey!, "base64")).toHaveLength(32);
    // Relative to the instance directory, so the directory stays relocatable.
    expect(content).toContain("YAP_SQLITE_PATH=./data/yap.db");
    expect(content).toContain("YAP_BLOB_FS_ROOT=./data/blobs");

    expect(statSync(join(dir, "data")).isDirectory()).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".env");
  });

  it("refuses to overwrite an existing .env", () => {
    const dir = tempDir();
    const first = initInstance(dir);
    const before = readFileSync(first.envPath, "utf8");

    const second = initInstance(dir);
    expect(second.created).toBe(false);
    expect(second.envPath).toBe(first.envPath);
    expect(readFileSync(first.envPath, "utf8")).toBe(before);
  });

  it("leaves an existing .gitignore alone", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".gitignore"), "custom\n");
    initInstance(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("custom\n");
  });

  it("gitignores the CLI credential directory", () => {
    const dir = tempDir();
    initInstance(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".yap/");
  });

  it("persists an explicit port into the .env", () => {
    const dir = tempDir();
    const result = initInstance(dir, { port: "9001" });
    expect(readFileSync(result.envPath, "utf8")).toContain("\nYAP_PORT=9001\n");
  });
});

describe("instance env", () => {
  it("merges .env with real env vars winning", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), "YAP_PORT=9000\nYAP_SYSADMIN_KEY=from-file\n");
    const env = loadInstanceEnv(dir, { YAP_SYSADMIN_KEY: "from-env" });
    expect(env.YAP_PORT).toBe("9000");
    expect(env.YAP_SYSADMIN_KEY).toBe("from-env");
  });

  it("derives the base URL from YAP_BASE_URL or the port", () => {
    expect(instanceBaseUrl({})).toBe("http://localhost:8787");
    expect(instanceBaseUrl({ YAP_PORT: "9000" })).toBe("http://localhost:9000");
    expect(instanceBaseUrl({ YAP_BASE_URL: "https://yap.example/" })).toBe("https://yap.example");
  });
});

describe("credentials", () => {
  it("round-trips and is private to the owner", () => {
    const dir = tempDir();
    expect(readCredentials(dir)).toBeUndefined();
    writeCredentials(dir, { accessKey: "yap_abc", userName: "ada" });
    expect(readCredentials(dir)).toEqual({ accessKey: "yap_abc", userName: "ada" });
    expect(statSync(credentialsPath(dir)).mode & 0o777).toBe(0o600);
  });
});

describe("vendored server", () => {
  it("builds the GitHub install spec for latest and pinned", () => {
    expect(installSpec()).toBe("yap-core@github:yap-tools/yap-core#semver:*");
    expect(installSpec("v0.1.0")).toBe("yap-core@github:yap-tools/yap-core#v0.1.0");
  });

  it("detects an installed server and its version", () => {
    const dir = tempDir();
    expect(vendoredServerEntry(dir)).toBeUndefined();
    const pkgDir = join(dir, "node_modules", "yap-core");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    writeFileSync(join(pkgDir, "dist", "index.js"), "");
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "0.2.0" }));
    expect(vendoredServerEntry(dir)).toBe(join(pkgDir, "dist", "index.js"));
    expect(vendoredServerVersion(dir)).toBe("0.2.0");
  });
});

describe("pidfile", () => {
  it("reports a live pid and cleans a stale one", () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".yap"), { recursive: true });
    writeFileSync(pidPath(dir), `${process.pid}\n`);
    expect(runningPid(dir)).toBe(process.pid);

    writeFileSync(pidPath(dir), "999999999\n");
    expect(runningPid(dir)).toBeUndefined();
    expect(() => statSync(pidPath(dir))).toThrow(); // stale file removed
  });
});

describe("table", () => {
  it("formats columns, nested paths, and missing values", () => {
    const out = table(
      [
        { id: "a1", client: { name: "App" }, lastUsedAt: null },
        { id: "b2", client: { name: "Other" }, lastUsedAt: "2026-06-12" },
      ],
      ["id", "client.name", "lastUsedAt"],
    );
    expect(out).toContain("ID  CLIENT.NAME  LASTUSEDAT");
    expect(out).toContain("a1  App          -");
    expect(out).toContain("b2  Other        2026-06-12");
    expect(table([], ["id"])).toBe("(none)");
  });
});

describe("service generation", () => {
  it("systemd unit runs the instance's server from its directory", () => {
    const unit = systemdUnit("/srv/yap-a", "/srv/yap-a/node_modules/yap-core/dist/index.js", "yap-a");
    expect(unit).toContain("WorkingDirectory=/srv/yap-a");
    expect(unit).toContain("/srv/yap-a/node_modules/yap-core/dist/index.js serve");
    expect(unit).toContain("Restart=always");
  });

  it("launchd plist keeps the instance alive and logs into .yap", () => {
    const plist = launchdPlist("/srv/yap-a", "/srv/yap-a/node_modules/yap-core/dist/index.js", "yap-a");
    expect(plist).toContain("<string>tools.yap.yap-a</string>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain(join("/srv/yap-a", ".yap", "logs", "yap.log"));
  });
});
