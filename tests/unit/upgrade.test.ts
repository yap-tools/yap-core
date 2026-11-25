/**
 * `yap upgrade` in stages: the target is installed into .yap/staging, its
 * `yap preflight` runs against the instance, and only a pass lets the backup,
 * the real install and the restart happen. npm is replaced by a stub that
 * writes a fake server package where the install was aimed; each fake entry
 * appends its invocation to calls.log in its working directory (the
 * instance) and exits with a chosen code. Process control is mocked, so the
 * test can see whether a restart was attempted.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstallOptions, Source } from "../../src/instance/server.js";

interface FakeServer {
  version: string;
  /** Exit code of `preflight`; undefined = the build has no preflight. */
  preflight?: number;
  /** The install produced no server entry at all. */
  broken?: boolean;
}

/** What the next npm install of each kind produces. */
const fakes: { staged: FakeServer; installed: FakeServer } = {
  staged: { version: "0.0.0" },
  installed: { version: "0.0.0" },
};
const installs: { prefix?: string; spec?: string; source: Source }[] = [];

vi.mock("../../src/instance/server.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/instance/server.js")>();
  return {
    ...real,
    installServer: vi.fn(async (dir: string, source: Source, opts: InstallOptions = {}) => {
      installs.push({ prefix: opts.prefix, spec: opts.spec, source });
      writeFakeServer(opts.prefix ?? dir, opts.prefix ? fakes.staged : fakes.installed, opts.prefix ? "staged" : "installed");
    }),
  };
});
vi.mock("../../src/instance/proc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/instance/proc.js")>()),
  runningPid: vi.fn(() => 4242),
  stopInstance: vi.fn(async () => {}),
}));
vi.mock("../../src/cli/lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/cli/lifecycle.js")>()),
  cmdStart: vi.fn(async () => {}),
}));

const { cmdUpgrade } = await import("../../src/cli/setup.js");
const { stopInstance } = await import("../../src/instance/proc.js");
const { cmdStart } = await import("../../src/cli/lifecycle.js");
const { installSpec, vendoredServerVersion } = await import("../../src/instance/server.js");

/** A fake yap-core under `prefix`: package.json, dist/index.js, backup/run.js and, if it has one, db/preflight.js. */
function writeFakeServer(prefix: string, fake: FakeServer, label: string): void {
  if (fake.broken) return;
  const pkg = join(prefix, "node_modules", "yap-core");
  const dist = join(pkg, "dist");
  mkdirSync(join(dist, "backup"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: fake.version }));
  writeFileSync(join(dist, "backup", "run.js"), "");
  if (fake.preflight !== undefined) {
    mkdirSync(join(dist, "db"), { recursive: true });
    writeFileSync(join(dist, "db", "preflight.js"), "");
  }
  writeFileSync(
    join(dist, "index.js"),
    `const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(require("node:path").join(process.cwd(), "calls.log"),
  JSON.stringify({ who: ${JSON.stringify(`${label} ${fake.version}`)}, args, envFile: process.env.YAP_ENV_FILE ?? null }) + "\\n");
process.exit(args[0] === "preflight" ? ${fake.preflight ?? 0} : 0);
`,
  );
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yap-upgrade-"));
  writeFileSync(join(dir, ".env"), "");
  writeFakeServer(dir, { version: "1.0.0", preflight: 0 }, "old");
  installs.length = 0;
  vi.mocked(stopInstance).mockClear();
  vi.mocked(cmdStart).mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function calls(): { who: string; args: string[]; envFile: string | null }[] {
  const path = join(dir, "calls.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

function stagingLeftovers(): string[] {
  const root = join(dir, ".yap", "staging");
  return existsSync(root) ? readdirSync(root) : [];
}

describe("yap upgrade with a failing preflight", () => {
  it("stops before the backup, installs nothing and does not restart", async () => {
    fakes.staged = { version: "2.0.0", preflight: 1 };
    await expect(cmdUpgrade(dir, ["v2.0.0"])).rejects.toThrow(
      /2\.0\.0 cannot start on this instance as it stands .* nothing was installed, and 1\.0\.0 is still installed and running/,
    );
    expect(vendoredServerVersion(dir)).toBe("1.0.0");
    expect(installs.map((i) => i.prefix !== undefined)).toEqual([true]); // only the staging install
    expect(calls()).toEqual([{ who: "staged 2.0.0", args: ["preflight"], envFile: join(dir, ".env") }]);
    expect(stopInstance).not.toHaveBeenCalled();
    expect(cmdStart).not.toHaveBeenCalled();
    expect(stagingLeftovers()).toEqual([]);
  });
});

describe("yap upgrade with a passing preflight", () => {
  it("checks the staged build, backs up with the old one, installs what it checked and restarts", async () => {
    fakes.staged = { version: "2.0.0", preflight: 0 };
    fakes.installed = { version: "2.0.0", preflight: 0 };
    await cmdUpgrade(dir, []);
    expect(calls().map((c) => [c.who, c.args[0]])).toEqual([
      ["staged 2.0.0", "preflight"],
      ["old 1.0.0", "backup"],
    ]);
    expect(installs).toHaveLength(2);
    expect(installs[0]!.prefix).toBeDefined();
    // The real install is pinned to the version the staged copy turned out to be.
    expect(installs[1]).toEqual({
      prefix: undefined,
      spec: installSpec({ kind: "release", version: "v2.0.0" }),
      source: { kind: "release" },
    });
    expect(vendoredServerVersion(dir)).toBe("2.0.0");
    expect(stopInstance).toHaveBeenCalledOnce();
    expect(cmdStart).toHaveBeenCalledOnce();
    expect(stagingLeftovers()).toEqual([]);
  });

  it("leaves an explicit YAP_ENV_FILE to the staged build", async () => {
    fakes.staged = { version: "2.0.0", preflight: 0 };
    fakes.installed = { version: "2.0.0", preflight: 0 };
    vi.stubEnv("YAP_ENV_FILE", "/elsewhere/yap.env");
    try {
      await cmdUpgrade(dir, ["--check"]);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(calls()[0]!.envFile).toBe("/elsewhere/yap.env");
  });

  it("clears a staging copy an interrupted upgrade left behind", async () => {
    mkdirSync(join(dir, ".yap", "staging", "upgrade-stale"), { recursive: true });
    fakes.staged = { version: "2.0.0", preflight: 0 };
    await cmdUpgrade(dir, ["--check"]);
    expect(stagingLeftovers()).toEqual([]);
  });
});

describe("yap upgrade --check", () => {
  it("runs the staged preflight and nothing else", async () => {
    fakes.staged = { version: "2.0.0", preflight: 0 };
    await cmdUpgrade(dir, ["v2.0.0", "--check"]);
    expect(installs.map((i) => i.prefix !== undefined)).toEqual([true]);
    expect(calls().map((c) => c.args[0])).toEqual(["preflight"]);
    expect(vendoredServerVersion(dir)).toBe("1.0.0");
    expect(cmdStart).not.toHaveBeenCalled();
    expect(stagingLeftovers()).toEqual([]);
  });

  it("fails the same way a real upgrade would", async () => {
    fakes.staged = { version: "2.0.0", preflight: 1 };
    await expect(cmdUpgrade(dir, ["--check"])).rejects.toThrow(/nothing was installed/);
    expect(installs).toHaveLength(1);
    expect(vendoredServerVersion(dir)).toBe("1.0.0");
  });
});

describe("yap upgrade to a build without preflight", () => {
  it("says there is nothing to check and goes on with the upgrade", async () => {
    fakes.staged = { version: "0.8.0" };
    fakes.installed = { version: "0.8.0" };
    await cmdUpgrade(dir, ["v0.8.0"]);
    expect(console.error).toHaveBeenCalledWith("note: 0.8.0 predates upgrade preflight — nothing to check before installing it");
    expect(calls().map((c) => [c.who, c.args[0]])).toEqual([["old 1.0.0", "backup"]]);
    expect(vendoredServerVersion(dir)).toBe("0.8.0");
  });
});

describe("yap upgrade when staging produced no server", () => {
  it("fails closed instead of treating it as a build without preflight", async () => {
    fakes.staged = { version: "2.0.0", broken: true };
    await expect(cmdUpgrade(dir, [])).rejects.toThrow(/produced no server — nothing was changed/);
    expect(installs).toHaveLength(1);
    expect(calls()).toEqual([]);
    expect(vendoredServerVersion(dir)).toBe("1.0.0");
  });
});
