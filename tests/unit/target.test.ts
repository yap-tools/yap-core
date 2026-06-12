/**
 * Remote targeting: how the CLI decides which instance to talk to. A target
 * is local (cwd .env + .yap/credentials.json, today's behavior) or remote
 * (--url/--key flags or YAP_URL/YAP_KEY env), resolved once before dispatch.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { apiRequest } from "../../src/cli/client.js";
import { writeCredentials } from "../../src/cli/credentials.js";
import { assertLocal, isPlainHttpNonLoopback, resolveTarget } from "../../src/cli/target.js";
import { getFreeLoopbackPort } from "../../src/rest/edge.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yap-target-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An instance directory with a .env and a saved CLI credential. */
function instanceDir(): string {
  const dir = tempDir();
  writeFileSync(join(dir, ".env"), "YAP_PORT=9123\nYAP_SYSADMIN_KEY=yap_sys_local\n");
  writeCredentials(dir, { accessKey: "yk_local" });
  return dir;
}

describe("resolveTarget", () => {
  it("defaults to a local target resolved from the instance directory", () => {
    const dir = instanceDir();
    const { target, argv } = resolveTarget(["spaces", "list"], {}, dir);

    expect(target.remote).toBe(false);
    expect(target.baseUrl).toBe("http://localhost:9123");
    expect(target.userKey()).toBe("yk_local");
    expect(target.sysKey()).toBe("yap_sys_local");
    expect(argv).toEqual(["spaces", "list"]);
  });

  it("errors lazily on a local target with no saved credential", () => {
    const dir = tempDir();
    const { target } = resolveTarget([], {}, dir);
    expect(() => target.userKey()).toThrow(/no CLI credential/);
  });

  it("--url makes a remote target and strips the flags from argv", () => {
    const { target, argv } = resolveTarget(
      ["--url", "https://yap.example.com/", "spaces", "list", "--json", "--key", "yk_remote"],
      {},
      tempDir(),
    );

    expect(target.remote).toBe(true);
    expect(target.baseUrl).toBe("https://yap.example.com");
    expect(target.userKey()).toBe("yk_remote");
    expect(argv).toEqual(["spaces", "list", "--json"]);
  });

  it("supports --url=value and --key=value forms", () => {
    const { target, argv } = resolveTarget(
      ["--url=https://yap.example.com", "--key=yk_remote", "status"],
      {},
      tempDir(),
    );
    expect(target.baseUrl).toBe("https://yap.example.com");
    expect(target.userKey()).toBe("yk_remote");
    expect(argv).toEqual(["status"]);
  });

  it("errors when --url or --key is given without a value", () => {
    expect(() => resolveTarget(["--url"], {}, tempDir())).toThrow(/--url requires a value/);
    expect(() => resolveTarget(["--key"], {}, tempDir())).toThrow(/--key requires a value/);
  });

  it("activates remote mode from YAP_URL/YAP_KEY env", () => {
    const { target } = resolveTarget(
      ["spaces", "list"],
      { YAP_URL: "https://yap.example.com", YAP_KEY: "yk_env" },
      tempDir(),
    );
    expect(target.remote).toBe(true);
    expect(target.baseUrl).toBe("https://yap.example.com");
    expect(target.userKey()).toBe("yk_env");
  });

  it("lets flags beat env vars", () => {
    const { target } = resolveTarget(
      ["--url", "https://flag.example.com", "--key", "yk_flag"],
      { YAP_URL: "https://env.example.com", YAP_KEY: "yk_env" },
      tempDir(),
    );
    expect(target.baseUrl).toBe("https://flag.example.com");
    expect(target.userKey()).toBe("yk_flag");
  });

  it("requires an explicit key on a remote target — no fallback to local credentials", () => {
    const dir = instanceDir(); // has both .env and a saved credential
    const { target } = resolveTarget([], { YAP_URL: "https://yap.example.com" }, dir);

    expect(target.remote).toBe(true);
    expect(target.baseUrl).toBe("https://yap.example.com"); // not the local .env port
    expect(() => target.userKey()).toThrow(/pass --key or set YAP_KEY/);
  });

  it("refuses the sysadmin lane on a remote target", () => {
    const dir = instanceDir(); // local .env holds a sysadmin key — must not be used
    const { target } = resolveTarget([], { YAP_URL: "https://yap.example.com" }, dir);
    expect(() => target.sysKey()).toThrow(/local-only/);
  });
});

describe("assertLocal", () => {
  it("refuses lifecycle commands on a remote target", () => {
    const { target } = resolveTarget([], { YAP_URL: "https://yap.example.com" }, tempDir());
    expect(() => assertLocal(target, "start")).toThrow(/start manages a local instance directory/);
  });

  it("passes through on a local target", () => {
    const { target } = resolveTarget([], {}, tempDir());
    expect(() => assertLocal(target, "start")).not.toThrow();
  });
});

describe("apiRequest connection errors", () => {
  it("suggests `yap start` for a local target but not for a remote one", async () => {
    const closed = `http://127.0.0.1:${await getFreeLoopbackPort()}`;
    await expect(apiRequest(closed, "GET", "/health", "k")).rejects.toThrow(/yap start/);
    await expect(apiRequest(closed, "GET", "/health", "k", undefined, { remote: true })).rejects.toThrow(
      new RegExp(`^could not reach ${closed}$`),
    );
  });
});

describe("isPlainHttpNonLoopback", () => {
  it("flags plain http to a non-loopback host", () => {
    expect(isPlainHttpNonLoopback("http://yap.example.com")).toBe(true);
  });

  it("accepts https anywhere and http on loopback", () => {
    expect(isPlainHttpNonLoopback("https://yap.example.com")).toBe(false);
    expect(isPlainHttpNonLoopback("http://localhost:8787")).toBe(false);
    expect(isPlainHttpNonLoopback("http://127.0.0.1:8787")).toBe(false);
    expect(isPlainHttpNonLoopback("http://[::1]:8787")).toBe(false);
  });
});
